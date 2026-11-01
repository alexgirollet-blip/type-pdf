// type-pdf Worker: serves the app, accounts, per-user storage and live sync.
// Storage changes are additive only (new tables / new columns), so existing accounts and papers
// carry over untouched when a new version is deployed.
import { DurableObject } from "cloudflare:workers";

const MB = 1024 * 1024;
const MAX_PDF = 40 * MB;                 // largest single PDF
// Cloudflare's free plan allows 5 GB of Durable Object storage per Cloudflare *account*, shared by every
// Worker in that account (Pages static files, KV, D1 and R2 have separate allowances). Each single
// Durable Object is also capped at 1 GB on the free plan, so every PDF gets its own small object.
const GLOBAL_LIMIT = 5 * 1024 * MB;
const GLOBAL_SAFETY = 150 * MB;          // keep a margin so the store never hits the hard limit
const DEFAULT_QUOTA = 250 * MB;
const QUOTA_CHOICES = [100, 250, 500, 1024, 2048].map(n => n * MB);
const CHUNK = MB;                        // SQLite values max out at 2 MB; PDFs are stored in 1 MB chunks
const SESSION_DAYS = 60;
const TRASH_DAYS = 30;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const HEX = /^[a-f0-9]{8,64}$/;

function tokenFrom(req) {
  const h = req.headers.get("authorization") || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  return new URL(req.url).searchParams.get("token") || "";
}
function pdfStub(env, u, hash) { return env.PDFS.get(env.PDFS.idFromName(u + ":" + hash)); }
function authStub(env) { return env.AUTH.get(env.AUTH.idFromName("auth")); }
function userStub(env, u) { return env.USERS.get(env.USERS.idFromName("u:" + u)); }
async function call(stub, path, body, method = "POST") { return stub.fetch(new Request("https://do" + path, { method, body: body === undefined ? undefined : JSON.stringify(body) })); }

// ---- real storage used by the whole Cloudflare account (optional; needs CF_ACCOUNT_ID + CF_API_TOKEN) ----
let cfCache = { at: 0, value: null, error: null };
// when Cloudflare refuses the token, find out why so the admin panel can say exactly what to fix
async function explainTokenProblem(acct, token) {
  if (!/^[0-9a-f]{32}$/i.test(acct)) return "CF_ACCOUNT_ID doesn't look like an account ID (it should be 32 letters and numbers, from the dashboard's Account home).";
  if (/^[0-9a-f]{37}$/i.test(token)) return "CF_API_TOKEN looks like the Global API Key. Create an API token instead (My Profile → API Tokens → Create Token) and paste that.";
  if (/^[0-9a-f]{32}$/i.test(token)) return "CF_API_TOKEN looks like a token's ID, not the token itself. The token is the long value shown only once, right after you create it. Roll the token (or make a new one) and paste that value.";
  const verify = async u => { try { const j = await (await fetch(u, { headers: { authorization: "Bearer " + token } })).json(); return j && j.success && j.result && j.result.status; } catch (e) { return null; } };
  const st = await verify("https://api.cloudflare.com/client/v4/user/tokens/verify") || await verify(`https://api.cloudflare.com/client/v4/accounts/${acct}/tokens/verify`);
  if (!st) return "Cloudflare doesn't recognise CF_API_TOKEN. Paste the token value again (shown once after creating it), as a Secret, with nothing else around it.";
  if (st !== "active") return `The API token is ${st}. Activate it, or create a new one.`;
  return "The token works but can't read analytics for this account. Edit it: Permissions → Account · Account Analytics · Read, and Account Resources → include this account (check CF_ACCOUNT_ID matches).";
}
async function cfGql(token, query, variables) {
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => ({}));
  if (j.errors && j.errors.length) throw new Error(j.errors[0].message || "GraphQL error");
  if (!j.data) throw new Error("No data from Cloudflare (HTTP " + r.status + ")");
  return j.data;
}
// the shape of each dataset (which "bytes" metric, whether it has namespaceId), found once by asking the API itself
const cfShapes = {};
async function datasetShape(token, ds, type) {
  if (cfShapes[ds]) return cfShapes[ds];
  const guess = { agg: "max", metric: "storedBytes", ns: true };
  try {
    const t = await cfGql(token, `query($n:String!){__type(name:$n){fields{name type{name ofType{name ofType{name}}}}}}`, { n: type });
    const fields = (t.__type && t.__type.fields) || [];
    const tn = f => f.type.name || (f.type.ofType && (f.type.ofType.name || (f.type.ofType.ofType && f.type.ofType.ofType.name)));
    const sub = async name => { const x = await cfGql(token, `query($n:String!){__type(name:$n){fields{name}}}`, { n: name }); return ((x.__type && x.__type.fields) || []).map(f => f.name); };
    let found = null;
    for (const agg of ["max", "sum", "avg"]) {
      const f = fields.find(q => q.name === agg); if (!f) continue;
      const names = await sub(tn(f)); const m = names.find(n => n === "storedBytes") || names.find(n => /bytes/i.test(n));
      if (m) { found = { agg, metric: m }; break; }
    }
    const dimF = fields.find(q => q.name === "dimensions");
    const dims = dimF ? await sub(tn(dimF)) : [];
    if (found && dims.includes("date")) return cfShapes[ds] = { ...found, ns: dims.includes("namespaceId") };
  } catch (e) { if (/auth/i.test(e.message)) throw e; }
  return guess;
}
// bytes stored now: the latest reported size of each namespace (Cloudflare doesn't report every day), added up
async function datasetBytes(token, acct, since, ds, type) {
  const sh = await datasetShape(token, ds, type);
  const q = `query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){${ds}(filter:{date_geq:$d},limit:5000){${sh.agg}{${sh.metric}} dimensions{date${sh.ns ? " namespaceId" : ""}}}}}}`;
  const data = await cfGql(token, q, { a: acct, d: since });
  const groups = (data.viewer && data.viewer.accounts && data.viewer.accounts[0] && data.viewer.accounts[0][ds]) || [];
  const latest = new Map();   // namespace (or "all") -> {date, bytes}
  for (const g of groups) {
    const date = g.dimensions && g.dimensions.date, key = (sh.ns && g.dimensions.namespaceId) || "all", b = Number((g[sh.agg] || {})[sh.metric]) || 0;
    if (!date) continue;
    const cur = latest.get(key);
    if (!cur || date > cur.date) latest.set(key, { date, bytes: b });
    else if (date === cur.date) cur.bytes = sh.ns ? Math.max(cur.bytes, b) : cur.bytes + b;
  }
  let value = 0, date = null;
  for (const v of latest.values()) { value += v.bytes; if (!date || v.date > date) date = v.date; }
  return { value, date };
}
async function cloudflareUsage(env) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return { configured: false };
  if (Date.now() - cfCache.at < 10 * 60e3) return { configured: true, ...cfCache };
  // forgive copy-paste slips: spaces, line breaks, quotes, or "Bearer " pasted in front
  const token = String(env.CF_API_TOKEN).trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").trim();
  const acct = String(env.CF_ACCOUNT_ID).trim().replace(/^["']|["']$/g, "").trim();
  const since = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
  try {
    // Cloudflare reports key-value Durable Objects and SQLite Durable Objects (what TypePDF uses) in two datasets
    const parts = [];
    for (const [ds, type] of [["durableObjectsSqlStorageGroups", "AccountDurableObjectsSqlStorageGroups"], ["durableObjectsStorageGroups", "AccountDurableObjectsStorageGroups"]]) {
      try { parts.push(await datasetBytes(token, acct, since, ds, type)); }
      catch (e) { if (/auth/i.test(e.message)) throw new Error(await explainTokenProblem(acct, token)); parts.push({ value: 0, date: null, err: e.message }); }
    }
    if (parts.every(x => x.err)) throw new Error(parts.map(x => x.err).join("; "));
    const value = parts.reduce((t, x) => t + x.value, 0);
    const date = parts.map(x => x.date).filter(Boolean).sort().pop() || null;
    cfCache = { at: Date.now(), value, date, error: null };
  } catch (e) { cfCache = { at: Date.now() - 8 * 60e3, value: cfCache.value, date: cfCache.date, error: String(e.message || e) }; }
  return { configured: true, ...cfCache };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try { return await api(req, env, url); }
    catch (e) { console.error(e); return bad("Server error", 500); }
  },
};

async function api(req, env, url) {
  const auth = authStub(env);
  const path = url.pathname;
  const ip = req.headers.get("cf-connecting-ip") || "local";

  if (path === "/api/auth/signup" || path === "/api/auth/login") {
    if (req.method !== "POST") return bad("Use POST", 405);
    const body = await req.json().catch(() => ({}));
    return call(auth, path.slice(9), { ...body, ip });
  }

  const token = tokenFrom(req);
  if (!token) return bad("Sign in first", 401);
  const who = await (await call(auth, "/check", { token })).json();
  if (!who.user) return bad("Your session has ended. Sign in again.", 401);
  const user = who.user;

  // storage the whole Cloudflare account really uses, when the admin has connected it
  const cf = await cloudflareUsage(env);
  if (cf.configured && cf.value != null) who.cfUsed = cf.value;
  if (who.admin) who.cf = { configured: cf.configured, used: cf.value ?? null, date: cf.date || null, error: cf.error || null };
  const knownUsed = Math.max(who.globalUsed || 0, who.cfUsed || 0);

  if (path === "/api/auth/me") return json(who);
  if (path === "/api/auth/logout" || path === "/api/auth/password" || path === "/api/auth/delete") {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    if (path === "/api/auth/delete" && who.admin) return bad("The admin account can't be deleted here.", 400);
    const res = await call(auth, path.slice(9), { ...body, token, user, ip });
    if (path === "/api/auth/delete" && res.ok) await call(userStub(env, user), "/wipe?u=" + user, {});
    return res;
  }

  // ---- admin: the first account created ----
  if (path.startsWith("/api/admin/")) {
    if (!who.admin) return bad("Only the admin can do that.", 403);
    if (path === "/api/admin/overview") { const o = await (await call(auth, "/admin/overview", {})).json(); return json({ ...o, cf: who.cf }); }
    if (path === "/api/admin/quota" || path === "/api/admin/default") {
      const b = await req.json().catch(() => ({}));
      if (!QUOTA_CHOICES.includes(+b.quota)) return bad("Pick one of the listed sizes.");
      return call(auth, path === "/api/admin/quota" ? "/admin/quota" : "/admin/default", b);
    }
    let m = path.match(/^\/api\/admin\/user\/([a-z0-9_.-]{3,24})(?:\/docs(?:\/([a-f0-9]{8,64}))?)?$/);
    if (m) {
      const target = m[1], stub = userStub(env, target);
      if (path.endsWith("/docs") && req.method === "GET") return stub.fetch(new Request("https://do/docs?all=1", { headers: { "x-user": target } }));
      if (m[2] && req.method === "DELETE") return stub.fetch(new Request(`https://do/docs/${m[2]}?purge=1`, { method: "DELETE", headers: { "x-user": target } }));
      if (!path.includes("/docs") && req.method === "DELETE") {
        if (target === user) return bad("You can't delete your own admin account.");
        const r = await call(auth, "/admin/delete-user", { user: target });
        if (r.ok) await call(stub, "/wipe?u=" + target, {});
        return r;
      }
    }
    return bad("Not found", 404);
  }

  // fetch a PDF from a pasted link (signed-in users only, PDFs only)
  if (path === "/api/fetch-pdf") {
    const target = url.searchParams.get("url") || "";
    let u; try { u = new URL(target); } catch { return bad("That link isn't valid."); }
    if (!/^https?:$/.test(u.protocol)) return bad("Only http and https links work.");
    const r = await fetch(u.toString(), { headers: { "user-agent": "type-pdf/1.0" }, redirect: "follow" });
    if (!r.ok) return bad(`The site answered ${r.status}.`, 502);
    if (+(r.headers.get("content-length") || 0) > MAX_PDF) return bad("That PDF is too large (40 MB max).", 413);
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_PDF) return bad("That PDF is too large (40 MB max).", 413);
    if (!new TextDecoder().decode(new Uint8Array(buf.slice(0, 1024))).includes("%PDF")) return bad("That link isn't a PDF file.");
    const name = decodeURIComponent((u.pathname.split("/").pop() || "paper.pdf")).slice(0, 120);
    return new Response(buf, { headers: { "content-type": "application/pdf", "x-file-name": encodeURIComponent(name) } });
  }

  // per-user storage + sync
  const store = userStub(env, user);
  const headers = new Headers(req.headers);
  headers.set("x-user", user);
  headers.set("x-quota", who.admin ? "-1" : String(who.quota));
  headers.set("x-global-free", String(Math.max(0, GLOBAL_LIMIT - GLOBAL_SAFETY - knownUsed)));
  return store.fetch(new Request("https://do" + path.slice(4) + url.search, { method: req.method, headers, body: req.body, duplex: "half" }));
}

// ===================== accounts =====================
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
const rand = n => hex(crypto.getRandomValues(new Uint8Array(n)));
async function hashPw(pw, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256));
}
function sameStr(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function addColumn(sql, table, col, def) {
  const cols = sql.exec(`PRAGMA table_info(${table})`).toArray().map(r => r.name);
  if (!cols.includes(col)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

export class AuthStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS users (u TEXT PRIMARY KEY, hash TEXT, salt TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (t TEXT PRIMARY KEY, u TEXT, exp INTEGER);
      CREATE TABLE IF NOT EXISTS limits (k TEXT PRIMARY KEY, n INTEGER, reset INTEGER);
      CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);`);
    addColumn(this.sql, "users", "quota", "INTEGER");
    addColumn(this.sql, "users", "used", "INTEGER DEFAULT 0");
  }
  hit(key, max, windowMs) {
    const now = Date.now();
    const row = this.sql.exec("SELECT n, reset FROM limits WHERE k = ?", key).toArray()[0];
    if (!row || row.reset < now) { this.sql.exec("INSERT OR REPLACE INTO limits VALUES (?, 1, ?)", key, now + windowMs); return true; }
    if (row.n >= max) return false;
    this.sql.exec("UPDATE limits SET n = n + 1 WHERE k = ?", key); return true;
  }
  newSession(u) { const t = rand(32); this.sql.exec("INSERT INTO sessions VALUES (?, ?, ?)", t, u, Date.now() + SESSION_DAYS * 864e5); return t; }
  admin() { const r = this.sql.exec("SELECT u FROM users ORDER BY created, rowid LIMIT 1").toArray()[0]; return r ? r.u : null; }
  defaultQuota() { const r = this.sql.exec("SELECT v FROM settings WHERE k = 'default_quota'").toArray()[0]; return r ? +r.v : DEFAULT_QUOTA; }
  totalUsed() { return this.sql.exec("SELECT COALESCE(SUM(used), 0) AS s FROM users").toArray()[0].s; }
  info(u) {
    const row = this.sql.exec("SELECT quota, used FROM users WHERE u = ?", u).toArray()[0] || {};
    const admin = this.admin() === u;
    return { user: u, admin, quota: admin ? -1 : (row.quota || this.defaultQuota()), used: row.used || 0, globalUsed: this.totalUsed(), globalLimit: GLOBAL_LIMIT };
  }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const b = await req.json().catch(() => ({}));
    const now = Date.now();
    if (path === "/signup") {
      const u = String(b.username || "").trim().toLowerCase(), p = String(b.password || "");
      if (!/^[a-z0-9_.-]{3,24}$/.test(u)) return bad("Usernames are 3–24 characters: letters, numbers, . _ or -.");
      if (p.length < 8) return bad("Passwords need at least 8 characters.");
      if (p.length > 200) return bad("That password is too long.");
      if (!this.hit("signup:" + b.ip, 6, 3600e3)) return bad("Too many new accounts from here. Try again in an hour.", 429);
      if (this.sql.exec("SELECT 1 FROM users WHERE u = ?", u).toArray().length) return bad("That username is taken.", 409);
      const salt = rand(16), hash = await hashPw(p, salt);
      this.sql.exec("INSERT INTO users (u, hash, salt, created, quota, used) VALUES (?, ?, ?, ?, NULL, 0)", u, hash, salt, now);
      return json({ ...this.info(u), token: this.newSession(u) });
    }
    if (path === "/login") {
      const u = String(b.username || "").trim().toLowerCase(), p = String(b.password || "");
      if (!this.hit("login:" + u, 10, 900e3) || !this.hit("loginip:" + b.ip, 40, 900e3)) return bad("Too many attempts. Wait 15 minutes and try again.", 429);
      const row = this.sql.exec("SELECT hash, salt FROM users WHERE u = ?", u).toArray()[0];
      const hash = await hashPw(p, row ? row.salt : "00".repeat(16));
      if (!row || !sameStr(hash, row.hash)) return bad("Wrong username or password.", 401);
      this.sql.exec("DELETE FROM sessions WHERE exp < ?", now);
      return json({ ...this.info(u), token: this.newSession(u) });
    }
    if (path === "/check") {
      const row = this.sql.exec("SELECT u, exp FROM sessions WHERE t = ?", String(b.token || "")).toArray()[0];
      if (!row || row.exp < now) return json({ user: null });
      return json(this.info(row.u));
    }
    if (path === "/usage") { this.sql.exec("UPDATE users SET used = ? WHERE u = ?", Math.max(0, b.used | 0), b.user); return json({ ok: true }); }
    if (path === "/logout") { this.sql.exec("DELETE FROM sessions WHERE t = ?", b.token); return json({ ok: true }); }
    if (path === "/password") {
      const row = this.sql.exec("SELECT hash, salt FROM users WHERE u = ?", b.user).toArray()[0];
      if (!row || !sameStr(await hashPw(String(b.old || ""), row.salt), row.hash)) return bad("Your current password is wrong.", 401);
      if (String(b.password || "").length < 8) return bad("Passwords need at least 8 characters.");
      const salt = rand(16);
      this.sql.exec("UPDATE users SET hash = ?, salt = ? WHERE u = ?", await hashPw(b.password, salt), salt, b.user);
      this.sql.exec("DELETE FROM sessions WHERE u = ? AND t != ?", b.user, b.token);
      return json({ ok: true });
    }
    if (path === "/delete") {
      const row = this.sql.exec("SELECT hash, salt FROM users WHERE u = ?", b.user).toArray()[0];
      if (!row || !sameStr(await hashPw(String(b.password || ""), row.salt), row.hash)) return bad("Your password is wrong.", 401);
      this.sql.exec("DELETE FROM users WHERE u = ?", b.user); this.sql.exec("DELETE FROM sessions WHERE u = ?", b.user);
      return json({ ok: true });
    }
    // ---- admin ----
    if (path === "/admin/overview") {
      const admin = this.admin(), def = this.defaultQuota();
      const users = this.sql.exec("SELECT u, created, quota, used FROM users ORDER BY created").toArray().map(r => ({ user: r.u, created: r.created, used: r.used || 0, quota: r.u === admin ? -1 : (r.quota || def), custom: !!r.quota, admin: r.u === admin }));
      return json({ users, defaultQuota: def, choices: QUOTA_CHOICES, globalUsed: this.totalUsed(), globalLimit: GLOBAL_LIMIT });
    }
    if (path === "/admin/quota") { this.sql.exec("UPDATE users SET quota = ? WHERE u = ?", +b.quota, b.user); return json({ ok: true }); }
    if (path === "/admin/default") { this.sql.exec("INSERT OR REPLACE INTO settings VALUES ('default_quota', ?)", String(+b.quota)); return json({ ok: true }); }
    if (path === "/admin/delete-user") { this.sql.exec("DELETE FROM users WHERE u = ?", b.user); this.sql.exec("DELETE FROM sessions WHERE u = ?", b.user); return json({ ok: true }); }
    return bad("Not found", 404);
  }
}

// ===================== one store per user =====================
export class UserStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, name TEXT, created INTEGER, updated INTEGER, size INTEGER, pages INTEGER, filled INTEGER, total INTEGER, seq INTEGER DEFAULT 0, haspdf INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS kv (doc TEXT, k TEXT, v TEXT, seq INTEGER, PRIMARY KEY (doc, k));
      CREATE INDEX IF NOT EXISTS kv_seq ON kv (doc, seq);
      CREATE TABLE IF NOT EXISTS pdf (doc TEXT, i INTEGER, data BLOB, PRIMARY KEY (doc, i));
      CREATE TABLE IF NOT EXISTS lib (k TEXT PRIMARY KEY, v TEXT, ver INTEGER);
      CREATE TABLE IF NOT EXISTS pdfs (hash TEXT PRIMARY KEY, size INTEGER, created INTEGER);`);
    addColumn(this.sql, "docs", "pdf", "TEXT");          // hash of the PDF (copies of a paper share one PDF)
    addColumn(this.sql, "docs", "folder", "TEXT");
    addColumn(this.sql, "docs", "star", "INTEGER DEFAULT 0");
    addColumn(this.sql, "docs", "deleted", "INTEGER");
    addColumn(this.sql, "docs", "flags", "INTEGER DEFAULT 0");
    addColumn(this.sql, "docs", "opened", "INTEGER");
    // papers stored before copies existed: their id is their PDF's hash
    this.sql.exec("UPDATE docs SET pdf = id WHERE pdf IS NULL AND haspdf = 1");
  }
  docRow(id) { return this.sql.exec("SELECT * FROM docs WHERE id = ?", id).toArray()[0]; }
  ensureDoc(id, name, pdf) {
    if (!this.docRow(id)) this.sql.exec("INSERT INTO docs (id, name, created, updated, size, pages, filled, total, seq, haspdf, pdf) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?)", id, name || "Untitled", Date.now(), Date.now(), pdf || null);
    else if (pdf) this.sql.exec("UPDATE docs SET pdf = ? WHERE id = ? AND pdf IS NULL", pdf, id);
    this.syncPdfFlag(id);
  }
  // PDFs uploaded since PDFs moved to their own objects are listed in `pdfs`; older ones are still in the `pdf` table
  pdfSize(hash) {
    const x = this.sql.exec("SELECT size FROM pdfs WHERE hash = ?", hash).toArray()[0]; if (x) return x.size;
    const r = this.sql.exec("SELECT COALESCE(SUM(length(data)), 0) AS s, COUNT(*) AS n FROM pdf WHERE doc = ?", hash).toArray()[0]; return r.n ? r.s : 0;
  }
  syncPdfFlag(id) { const d = this.docRow(id); if (!d || !d.pdf) return; const s = this.pdfSize(d.pdf); this.sql.exec("UPDATE docs SET haspdf = ?, size = ? WHERE id = ?", s ? 1 : 0, s, id); }
  used() {
    const pdfs = this.sql.exec("SELECT COALESCE(SUM(length(data)), 0) AS s FROM pdf").toArray()[0].s + this.sql.exec("SELECT COALESCE(SUM(size), 0) AS s FROM pdfs").toArray()[0].s;
    const kv = this.sql.exec("SELECT COALESCE(SUM(length(v)), 0) + COALESCE(SUM(length(k)), 0) AS s FROM kv").toArray()[0].s;
    return pdfs + kv;
  }
  async report(user) { if (!user) return; try { await call(authStub(this.env), "/usage", { user, used: this.used() }); } catch (e) {} }
  purgeDoc(id) {
    const d = this.docRow(id); if (!d) return;
    this.sql.exec("DELETE FROM kv WHERE doc = ?", id); this.sql.exec("DELETE FROM docs WHERE id = ?", id);
    if (d.pdf && !this.sql.exec("SELECT 1 FROM docs WHERE pdf = ?", d.pdf).toArray().length) this.dropPdf(d.pdf);
    this.ctx.getWebSockets("doc:" + id).forEach(ws => { try { ws.send(JSON.stringify({ t: "deleted" })); ws.close(4002, "deleted"); } catch {} });
  }
  dropPdf(hash) {
    this.sql.exec("DELETE FROM pdf WHERE doc = ?", hash);
    if (this.sql.exec("SELECT 1 FROM pdfs WHERE hash = ?", hash).toArray().length) {
      this.sql.exec("DELETE FROM pdfs WHERE hash = ?", hash);
      if (this.user) call(pdfStub(this.env, this.user, hash), "/delete", {}).catch(() => {});
    }
  }
  async fetch(req) {
    const url = new URL(req.url), path = url.pathname, user = req.headers.get("x-user") || "";
    if (user) this.user = user;
    const quota = +(req.headers.get("x-quota") || DEFAULT_QUOTA), globalFree = +(req.headers.get("x-global-free") || GLOBAL_LIMIT);
    if (path === "/wipe") {
      this.ctx.getWebSockets().forEach(ws => { try { ws.close(4001, "account deleted"); } catch {} });
      const u = user || this.user || new URL(req.url).searchParams.get("u");
      if (u) for (const r of this.sql.exec("SELECT hash FROM pdfs").toArray()) await call(pdfStub(this.env, u, r.hash), "/delete", {}).catch(() => {});
      await this.ctx.storage.deleteAll(); return json({ ok: true });
    }
    if (path === "/sync") {
      if (req.headers.get("upgrade") !== "websocket") return bad("Expected a WebSocket", 426);
      const doc = url.searchParams.get("doc") || "";
      if (!HEX.test(doc)) return bad("Bad paper id");
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["doc:" + doc]);
      pair[1].serializeAttachment({ doc, user, device: (url.searchParams.get("device") || "").slice(0, 40) });
      this.presence(doc);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (path === "/docs" && req.method === "GET") {
      // empty the bin of anything older than 30 days
      const old = this.sql.exec("SELECT id FROM docs WHERE deleted IS NOT NULL AND deleted < ?", Date.now() - TRASH_DAYS * 864e5).toArray();
      old.forEach(r => this.purgeDoc(r.id)); if (old.length) await this.report(user);
      const rows = this.sql.exec(`SELECT d.id, d.name, d.created, d.updated, d.size, d.pages, d.filled, d.total, d.haspdf, d.pdf, d.folder, d.star, d.deleted, d.flags, d.opened,
        (SELECT COALESCE(SUM(length(v)), 0) FROM kv WHERE kv.doc = d.id) AS data FROM docs d ORDER BY d.updated DESC`).toArray();
      if (user && req.headers.get("x-quota") !== null) await this.report(user);
      const lib = this.sql.exec("SELECT v, ver FROM lib WHERE k = 'folders'").toArray()[0];
      return json({ docs: rows, used: this.used(), quota, folders: lib ? JSON.parse(lib.v) : [], foldersVer: lib ? lib.ver : 0 });
    }
    if (path === "/docs" && req.method === "POST") {            // a new paper record (e.g. a fresh attempt sharing a PDF)
      const b = await req.json().catch(() => ({}));
      if (!HEX.test(b.id || "") || (b.pdf && !HEX.test(b.pdf))) return bad("Bad id");
      this.ensureDoc(b.id, String(b.name || "Untitled").slice(0, 200), b.pdf);
      if (b.folder !== undefined) this.sql.exec("UPDATE docs SET folder = ? WHERE id = ?", b.folder || null, b.id);
      return json({ ok: true });
    }
    if (path === "/library" && req.method === "PUT") {
      const b = await req.json().catch(() => ({}));
      const cur = this.sql.exec("SELECT ver FROM lib WHERE k = 'folders'").toArray()[0];
      if (cur && b.ver !== cur.ver) { const now = this.sql.exec("SELECT v, ver FROM lib WHERE k = 'folders'").toArray()[0]; return json({ conflict: true, folders: JSON.parse(now.v), ver: now.ver }, 409); }
      const folders = Array.isArray(b.folders) ? b.folders.slice(0, 500).map(f => ({ id: String(f.id).slice(0, 40), name: String(f.name || "Folder").slice(0, 80), parent: f.parent ? String(f.parent).slice(0, 40) : null, colour: f.colour ? String(f.colour).slice(0, 12) : undefined })) : [];
      const ver = (cur ? cur.ver : 0) + 1;
      this.sql.exec("INSERT OR REPLACE INTO lib VALUES ('folders', ?, ?)", JSON.stringify(folders), ver);
      return json({ ok: true, ver });
    }
    let m = path.match(/^\/docs\/([a-f0-9]{8,64})(\/pdf)?$/);
    if (m) {
      const id = m[1];
      if (!m[2] && req.method === "PATCH") {
        const b = await req.json().catch(() => ({}));
        if (!this.docRow(id)) return bad("No such paper", 404);
        if (typeof b.name === "string") this.sql.exec("UPDATE docs SET name = ? WHERE id = ?", b.name.slice(0, 200) || "Untitled", id);
        if (b.folder !== undefined) this.sql.exec("UPDATE docs SET folder = ? WHERE id = ?", b.folder || null, id);
        if (b.star !== undefined) this.sql.exec("UPDATE docs SET star = ? WHERE id = ?", b.star ? 1 : 0, id);
        if (b.deleted !== undefined) this.sql.exec("UPDATE docs SET deleted = ? WHERE id = ?", b.deleted ? Date.now() : null, id);
        if (b.opened) this.sql.exec("UPDATE docs SET opened = ? WHERE id = ?", Date.now(), id);
        return json({ ok: true });
      }
      if (!m[2] && req.method === "DELETE") {
        if (url.searchParams.get("purge")) { this.purgeDoc(id); await this.report(user); }
        else this.sql.exec("UPDATE docs SET deleted = ? WHERE id = ?", Date.now(), id);
        return json({ ok: true });
      }
      // old route kept for clients from the previous version
      if (m[2]) { const d = this.docRow(id); const hash = d && d.pdf ? d.pdf : id; return this.pdfRoute(req, hash, url, user, quota, globalFree, id); }
    }
    m = path.match(/^\/pdf\/([a-f0-9]{8,64})$/);
    if (m) return this.pdfRoute(req, m[1], url, user, quota, globalFree, url.searchParams.get("doc"));
    return bad("Not found", 404);
  }
  async pdfRoute(req, hash, url, user, quota, globalFree, docId) {
    if (req.method === "GET" || req.method === "HEAD") {
      const size = this.pdfSize(hash);
      if (!size) return bad("No PDF stored for this paper", 404);
      if (req.method === "HEAD") return new Response(null, { headers: { "content-length": String(size) } });
      if (this.sql.exec("SELECT 1 FROM pdfs WHERE hash = ?", hash).toArray().length) {
        const r = await pdfStub(this.env, user || this.user, hash).fetch(new Request("https://do/get"));
        return new Response(r.body, { headers: { "content-type": "application/pdf", "cache-control": "private, max-age=31536000, immutable" } });
      }
      const parts = this.sql.exec("SELECT data FROM pdf WHERE doc = ? ORDER BY i", hash).toArray().map(r => new Uint8Array(r.data));
      const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
      return new Response(out, { headers: { "content-type": "application/pdf", "cache-control": "private, max-age=31536000, immutable" } });
    }
    if (req.method === "PUT") {
      const buf = await req.arrayBuffer();
      if (buf.byteLength > MAX_PDF) return bad("That PDF is too large to sync (40 MB max).", 413);
      if (hex(await crypto.subtle.digest("SHA-256", buf)).slice(0, 24) !== hash) return bad("The PDF doesn't match its id");
      if (!this.pdfSize(hash)) {
        const used = this.used();
        if (quota >= 0 && used + buf.byteLength > quota) return bad(`Your account is full (${Math.round(quota / MB)} MB). Delete some papers or ask the admin for more space.`, 413);
        if (buf.byteLength > globalFree) return bad("The site's storage is full. Ask the admin to free some space.", 507);
        const r = await pdfStub(this.env, user, hash).fetch(new Request("https://do/put", { method: "PUT", body: buf }));
        if (!r.ok) return bad("Couldn't store the PDF. Try again.", 500);
        this.sql.exec("INSERT OR REPLACE INTO pdfs VALUES (?, ?, ?)", hash, buf.byteLength, Date.now());
      }
      if (docId && HEX.test(docId)) { this.ensureDoc(docId, decodeURIComponent(url.searchParams.get("name") || "Untitled").slice(0, 200), hash); this.sql.exec("UPDATE docs SET pdf = COALESCE(pdf, ?) WHERE id = ?", hash, docId); this.syncPdfFlag(docId); }
      this.sql.exec("UPDATE docs SET haspdf = 1, size = ? WHERE pdf = ?", buf.byteLength, hash);
      await this.report(user);
      return json({ ok: true });
    }
    return bad("Not found", 404);
  }

  presence(doc) {
    const socks = this.ctx.getWebSockets("doc:" + doc);
    const msg = JSON.stringify({ t: "presence", n: socks.length });
    socks.forEach(ws => { try { ws.send(msg); } catch {} });
  }
  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const { doc, user } = ws.deserializeAttachment() || {};
    if (!doc) return;
    if (m.t === "hello") {
      this.ensureDoc(doc, String(m.name || "Untitled").slice(0, 200), HEX.test(m.pdf || "") ? m.pdf : null);
      this.sql.exec("UPDATE docs SET opened = ?, deleted = NULL WHERE id = ?", Date.now(), doc);   // opening a paper takes it out of the bin
      const since = Number(m.since) || 0, row = this.docRow(doc);
      const rows = this.sql.exec("SELECT k, v, seq FROM kv WHERE doc = ? AND seq > ? ORDER BY seq", doc, since).toArray();
      for (let i = 0; i < rows.length; i += 300) ws.send(JSON.stringify({ t: "snap", items: rows.slice(i, i + 300).map(r => [r.k, r.v, r.seq]) }));
      ws.send(JSON.stringify({ t: "ready", seq: row.seq, haspdf: !!row.haspdf, fresh: since === 0 && rows.length === 0 }));
      return;
    }
    if (m.t === "sets" && Array.isArray(m.ops)) {
      const acks = [], out = [];
      let seq = this.docRow(doc)?.seq || 0;
      for (const op of m.ops.slice(0, 500)) {
        if (typeof op.k !== "string" || op.k.length > 200) continue;
        const v = op.v === null || op.v === undefined ? null : String(op.v);
        if (v && v.length > 1_500_000) continue;
        seq++;
        this.sql.exec("INSERT INTO kv (doc, k, v, seq) VALUES (?, ?, ?, ?) ON CONFLICT (doc, k) DO UPDATE SET v = excluded.v, seq = excluded.seq", doc, op.k, v, seq);
        acks.push([op.id, seq]); out.push([op.k, v, seq]);
        if (op.k === "meta" && v) {
          try { const meta = JSON.parse(v); this.sql.exec("UPDATE docs SET name = ?, pages = ?, filled = ?, total = ?, flags = ? WHERE id = ?", String(meta.name || "Untitled").slice(0, 200), meta.pages | 0, meta.filled | 0, meta.total | 0, meta.flags | 0, doc); } catch {}
        }
      }
      this.sql.exec("UPDATE docs SET seq = ?, updated = ? WHERE id = ?", seq, Date.now(), doc);
      ws.send(JSON.stringify({ t: "ack", acks, seq }));
      const msg = JSON.stringify({ t: "snap", items: out, live: true });
      for (const other of this.ctx.getWebSockets("doc:" + doc)) if (other !== ws) { try { other.send(msg); } catch {} }
      // keep the account's usage roughly current without reporting on every keystroke
      if (!this.reportT || Date.now() - this.reportT > 60000) { this.reportT = Date.now(); this.report(user); }
      return;
    }
    if (m.t === "ping") ws.send(JSON.stringify({ t: "pong" }));
  }
  async webSocketClose(ws) { const { doc, user } = ws.deserializeAttachment() || {}; try { ws.close(); } catch {} if (doc) { this.presence(doc); this.report(user); } }
  async webSocketError(ws) { const { doc } = ws.deserializeAttachment() || {}; if (doc) this.presence(doc); }
}

// ===================== one small store per PDF =====================
// Keeps each account's store small (the free plan caps a single Durable Object at 1 GB).
export class PdfStore extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.sql = ctx.storage.sql; this.sql.exec("CREATE TABLE IF NOT EXISTS pdf (i INTEGER PRIMARY KEY, data BLOB)"); }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/put") {
      const u8 = new Uint8Array(await req.arrayBuffer());
      this.sql.exec("DELETE FROM pdf");
      for (let i = 0, k = 0; i < u8.length; i += CHUNK, k++) this.sql.exec("INSERT INTO pdf VALUES (?, ?)", k, u8.slice(i, i + CHUNK));
      return json({ ok: true, size: u8.length });
    }
    if (path === "/get") {
      const parts = this.sql.exec("SELECT data FROM pdf ORDER BY i").toArray().map(r => new Uint8Array(r.data));
      if (!parts.length) return bad("Missing", 404);
      const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
      return new Response(out, { headers: { "content-type": "application/pdf" } });
    }
    if (path === "/delete") { await this.ctx.storage.deleteAll(); return json({ ok: true }); }
    return bad("Not found", 404);
  }
}
