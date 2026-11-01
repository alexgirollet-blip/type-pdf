// type-pdf Worker: serves the app, sign-in through the GirolletServer-style hub, per-user storage,
// live sync and shared (collaborative) papers.
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
const REMOVED_DAYS = 30;                 // someone removed from the hub: blocked now, papers deleted after this
const HUB_RECHECK = 5 * 60e3;            // how often a signed-in account is re-checked with the hub
const SHARE_HOURS = 12;                  // how long a join pass lasts before the page asks again (automatic)
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

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
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try { return await api(req, env, url, ctx); }
    catch (e) { console.error(e); return bad("Server error", 500); }
  },
};

// ---------- the hub: accounts live there; TypePDF only trusts its signed passes ----------
const hubOn = env => !!(env.HUB_URL && env.HUB_SSO_SECRET);
// only the hub's address counts: a path pasted on the end (".../api", ".../login") or a missing https:// would
// otherwise send people to the wrong page, which answers {"error":"Sign in first"}
const hubBase = env => {
  let v = String(env.HUB_URL || "").trim().replace(/^["']|["']$/g, "");
  if (v && !/^https?:\/\//i.test(v)) v = "https://" + v;
  try { return new URL(v).origin; } catch { return v.replace(/\/+$/, ""); }
};
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}
async function readSigned(secret, tok) {
  const i = String(tok || "").lastIndexOf("."); if (i < 1) return null;
  const body = tok.slice(0, i), sig = tok.slice(i + 1);
  if (!sameStr(await hmac(secret, body), sig)) return null;
  try { const d = JSON.parse(new TextDecoder().decode(unb64u(body))); return d.exp && d.exp > Date.now() ? d : null; } catch { return null; }
}
async function makeSigned(secret, data) { const body = b64u(new TextEncoder().encode(JSON.stringify(data))); return body + "." + await hmac(secret, body); }
async function hubCheck(env, emails) {
  const r = await fetch(hubBase(env) + "/sso/check", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + env.HUB_SSO_SECRET }, body: JSON.stringify({ emails }) });
  if (!r.ok) throw new Error("hub check failed: " + r.status);
  return (await r.json()).users || {};
}
// accounts removed from the hub more than 30 days ago: delete their papers for good
async function purgeRemoved(env) {
  const due = await (await call(authStub(env), "/due", {})).json();
  for (const u of due.users || []) await call(userStub(env, u), "/wipe?u=" + u, {}).catch(() => {});
}
// signing join passes for shared papers: a random key kept in the accounts store
let shareKey = null;
async function shareSecret(env) { if (!shareKey) shareKey = (await (await call(authStub(env), "/secret", {})).json()).secret; return shareKey; }
const redirectTo = (loc, status = 302) => new Response(null, { status, headers: { location: loc, "cache-control": "no-store" } });

async function api(req, env, url, ctx) {
  const auth = authStub(env);
  const path = url.pathname;
  const ip = req.headers.get("cf-connecting-ip") || "local";

  if (path === "/api/config") return json({ hub: hubOn(env) });
  if (path === "/api/auth/signup" || path === "/api/auth/login" || path === "/api/auth/password") return bad("TypePDF accounts now come from GirolletServer. Use Sign in.", 410);
  // sign in: off to the hub, which sends the person back here with a signed pass
  if (path === "/api/auth/hub-login") {
    if (!hubOn(env)) return new Response("Sign-in isn't set up on this site yet (HUB_URL and HUB_SSO_SECRET).", { status: 503 });
    if (hubBase(env) === url.origin) return new Response("HUB_URL on the TypePDF Worker is set to TypePDF's own address. Set it to the GirolletServer hub's address, e.g. https://girolletserver.com", { status: 503 });
    return redirectTo(hubBase(env) + "/sso/typepdf?return=" + encodeURIComponent(url.origin + "/api/auth/hub-callback"));
  }
  if (path === "/api/auth/hub-callback") {
    if (!hubOn(env)) return redirectTo("/#signinerror=" + encodeURIComponent("Sign-in isn't set up on this site yet."));
    const pass = await readSigned(env.HUB_SSO_SECRET, url.searchParams.get("hubpass"));
    if (!pass || !pass.email) return redirectTo("/#signinerror=" + encodeURIComponent("That sign-in didn't work or took too long. Try again."));
    const r = await (await call(auth, "/sso", pass)).json();
    if (!r.token) return redirectTo("/#signinerror=" + encodeURIComponent(r.error || "Couldn't sign in."));
    return redirectTo("/#signin=" + r.token);
  }

  // ---- shared papers: joining with a code, and the shared paper itself (no account needed) ----
  if (path === "/api/share/join" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 8) return bad("Share codes are 8 letters and numbers.");
    const res = await (await call(auth, "/share/resolve", { code, ip })).json();
    if (res.error) return bad(res.error, res.status || 404);
    // signed in? join as that person (so the paper appears under Shared with me)
    let me = null; const tk = tokenFrom(req);
    if (tk) { const w = await (await call(auth, "/check", { token: tk })).json(); if (w.user) me = w; }
    if (me && me.user === res.owner) return json({ own: true, doc: res.doc });
    const name = me ? (me.name || me.email) : String(b.name || "").trim().slice(0, 40);
    if (!name) return bad("Type your name so the others know who you are.");
    const j = await (await call(userStub(env, res.owner), "/share/join", { doc: res.doc, role: res.role, name, email: me ? me.email : null })).json();
    if (j.error) return bad(j.error, 403);
    const pass = await makeSigned(await shareSecret(env), { o: res.owner, d: res.doc, r: res.role, p: j.pid, n: name, e: me ? me.email : null, exp: Date.now() + SHARE_HOURS * 3600e3 });
    if (me) await call(userStub(env, me.user), "/shared/add", { owner: res.owner, doc: res.doc, role: res.role, name: j.name, code });
    return json({ pass, doc: res.doc, role: res.role, name: j.name, pdf: j.pdf, pid: j.pid, me: name });
  }
  if (path === "/api/share/rejoin" && req.method === "POST") {           // signed-in people reopening a paper shared with them
    const tk = tokenFrom(req); const me = tk ? await (await call(auth, "/check", { token: tk })).json() : {};
    if (!me.user) return bad("Sign in first", 401);
    const b = await req.json().catch(() => ({}));
    if (!/^[a-z0-9_.-]{3,40}$/.test(b.owner || "") || !HEX.test(b.doc || "")) return bad("Bad paper");
    const j = await (await call(userStub(env, b.owner), "/share/rejoin", { doc: b.doc, email: me.email, name: me.name || me.email })).json();
    if (j.error) { if (j.gone) await call(userStub(env, me.user), "/shared/remove", { owner: b.owner, doc: b.doc }); return bad(j.error, 403); }
    const pass = await makeSigned(await shareSecret(env), { o: b.owner, d: b.doc, r: j.role, p: j.pid, n: me.name || me.email, e: me.email, exp: Date.now() + SHARE_HOURS * 3600e3 });
    return json({ pass, doc: b.doc, role: j.role, name: j.name, pdf: j.pdf, pid: j.pid, me: me.name || me.email });
  }
  const sharePass = url.searchParams.get("share") || req.headers.get("x-share") || "";
  if (sharePass && (path === "/api/sync" || path.startsWith("/api/share/pdf"))) {
    const sp = await readSigned(await shareSecret(env), sharePass);
    if (!sp) return bad("This shared paper's pass has expired. Join again with the code.", 401);
    const store = userStub(env, sp.o), headers = new Headers(req.headers);
    headers.set("x-user", sp.o); headers.set("x-share-role", sp.r); headers.set("x-share-pid", sp.p); headers.set("x-share-name", encodeURIComponent(sp.n));
    if (path === "/api/sync") { const u = new URL("https://do/sync"); u.searchParams.set("doc", sp.d); return store.fetch(new Request(u, { headers })); }
    return store.fetch(new Request(`https://do/share/pdf?doc=${sp.d}&pid=${sp.p}`, { headers }));
  }

  const token = tokenFrom(req);
  if (!token) return bad("Sign in first", 401);
  let who = await (await call(auth, "/check", { token })).json();
  if (!who.user) return bad(who.removed ? "Your GirolletServer account no longer has TypePDF, so you've been signed out." : "Your session has ended. Sign in again.", 401);
  // keep in step with the hub: admins come from there, and people removed there lose access here
  if (who.stale && hubOn(env)) {
    try {
      const st = (await hubCheck(env, [who.email]))[who.email] || { exists: false };
      who = await (await call(auth, "/hubstate", { email: who.email, ...st, token })).json();
      if (!who.user) return bad("Your GirolletServer account no longer has TypePDF, so you've been signed out.", 401);
      if (ctx) ctx.waitUntil(purgeRemoved(env));
    } catch (e) { /* hub unreachable: carry on with what we know */ }
  }
  const user = who.user;

  // storage the whole Cloudflare account really uses, when the admin has connected it
  const cf = await cloudflareUsage(env);
  if (cf.configured && cf.value != null) who.cfUsed = cf.value;
  if (who.admin) who.cf = { configured: cf.configured, used: cf.value ?? null, date: cf.date || null, error: cf.error || null };
  const knownUsed = Math.max(who.globalUsed || 0, who.cfUsed || 0);

  if (path === "/api/auth/me") return json(who);
  if (path === "/api/auth/logout") return call(auth, "/logout", { token });
  if (path === "/api/auth/delete") {                 // delete my TypePDF papers (the hub account itself stays)
    const res = await call(auth, "/delete", { user });
    if (res.ok) await call(userStub(env, user), "/wipe?u=" + user, {});
    return res;
  }

  // ---- admin: the first account created ----
  if (path.startsWith("/api/admin/")) {
    if (!who.admin) return bad("Only the admin can do that.", 403);
    if (path === "/api/admin/overview") {
      // bring everyone in line with the hub (removals, admins, names) and delete anyone past their 30 days
      if (hubOn(env)) {
        try {
          const emails = (await (await call(auth, "/emails", {})).json()).emails || [];
          if (emails.length) await call(auth, "/hubstate-all", { users: await hubCheck(env, emails) });
          await purgeRemoved(env);
        } catch (e) {}
      }
      const o = await (await call(auth, "/admin/overview", {})).json(); return json({ ...o, cf: who.cf, hub: hubOn(env) });
    }
    if (path === "/api/admin/quota" || path === "/api/admin/default") {
      const b = await req.json().catch(() => ({}));
      if (!QUOTA_CHOICES.includes(+b.quota)) return bad("Pick one of the listed sizes.");
      return call(auth, path === "/api/admin/quota" ? "/admin/quota" : "/admin/default", b);
    }
    let m = path.match(/^\/api\/admin\/user\/([a-z0-9_.-]{3,40})(?:\/docs(?:\/([a-f0-9]{8,64}))?)?$/);
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

  // ---- sharing my own papers ----
  let sm = path.match(/^\/api\/share\/(codes|reset|people|remove)$/);
  if (sm) {
    const b = req.method === "POST" ? await req.json().catch(() => ({})) : Object.fromEntries(url.searchParams);
    if (!HEX.test(b.doc || "")) return bad("Bad paper id");
    const mine = userStub(env, user);
    if (!(await (await call(mine, "/share/own", { doc: b.doc })).json()).ok) return bad("That paper isn't in your account yet. Wait for it to sync.", 404);
    if (sm[1] === "codes") return call(auth, "/share/get", { owner: user, doc: b.doc });
    if (sm[1] === "reset") return call(auth, "/share/reset", { owner: user, doc: b.doc });
    if (sm[1] === "people") return call(mine, "/share/people", { doc: b.doc });
    if (sm[1] === "remove") return call(mine, "/share/remove", { doc: b.doc, pid: String(b.pid || "") });
  }

  // per-user storage + sync
  const store = userStub(env, user);
  const headers = new Headers(req.headers);
  headers.set("x-user", user);
  headers.set("x-quota", who.admin ? "-1" : String(who.quota));
  headers.set("x-global-free", String(Math.max(0, GLOBAL_LIMIT - GLOBAL_SAFETY - knownUsed)));
  headers.set("x-name", encodeURIComponent(who.name || who.email || ""));
  for (const h of ["x-share-role", "x-share-pid", "x-share-name"]) headers.delete(h);   // only set by the shared-paper route
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
    // accounts come from the hub: an email, the name shown, whether the hub says admin, when last checked,
    // and when a removed account's papers get deleted
    addColumn(this.sql, "users", "email", "TEXT");
    addColumn(this.sql, "users", "name", "TEXT");
    addColumn(this.sql, "users", "hubadmin", "INTEGER DEFAULT 0");
    addColumn(this.sql, "users", "checked", "INTEGER DEFAULT 0");
    addColumn(this.sql, "users", "delete_at", "INTEGER");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS nonces (n TEXT PRIMARY KEY, exp INTEGER);
      CREATE TABLE IF NOT EXISTS shares (code TEXT PRIMARY KEY, owner TEXT, doc TEXT, role TEXT, created INTEGER);
      CREATE INDEX IF NOT EXISTS shares_doc ON shares (owner, doc);`);
  }
  newCode() { let c; do { c = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => CODE_CHARS[b % CODE_CHARS.length]).join(""); } while (this.sql.exec("SELECT 1 FROM shares WHERE code = ?", c).toArray().length); return c; }
  codesFor(owner, doc, fresh) {
    if (fresh) this.sql.exec("DELETE FROM shares WHERE owner = ? AND doc = ?", owner, doc);
    const out = {};
    for (const role of ["edit", "view"]) {
      let r = this.sql.exec("SELECT code FROM shares WHERE owner = ? AND doc = ? AND role = ?", owner, doc, role).toArray()[0];
      if (!r) { const c = this.newCode(); this.sql.exec("INSERT INTO shares VALUES (?, ?, ?, ?, ?)", c, owner, doc, role, Date.now()); r = { code: c }; }
      out[role] = r.code;
    }
    return out;
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
  isAdmin(u) { const r = this.sql.exec("SELECT hubadmin FROM users WHERE u = ?", u).toArray()[0]; return !!(r && r.hubadmin); }
  defaultQuota() { const r = this.sql.exec("SELECT v FROM settings WHERE k = 'default_quota'").toArray()[0]; return r ? +r.v : DEFAULT_QUOTA; }
  totalUsed() { return this.sql.exec("SELECT COALESCE(SUM(used), 0) AS s FROM users").toArray()[0].s; }
  info(u) {
    const row = this.sql.exec("SELECT quota, used, email, name, hubadmin, checked FROM users WHERE u = ?", u).toArray()[0] || {};
    const admin = !!row.hubadmin;
    return { user: u, email: row.email || null, name: row.name || (row.email ? row.email.split("@")[0] : u), admin, quota: admin ? -1 : (row.quota || this.defaultQuota()), used: row.used || 0, globalUsed: this.totalUsed(), globalLimit: GLOBAL_LIMIT, stale: Date.now() - (row.checked || 0) > HUB_RECHECK };
  }
  // a hub account → its TypePDF account (made on first sign-in; the first hub admin to sign in takes over the
  // account that existed before sign-in moved to the hub, papers and all)
  async accountFor(email, name, admin) {
    let row = this.sql.exec("SELECT u FROM users WHERE email = ?", email).toArray()[0];
    if (!row && admin) row = this.sql.exec("SELECT u FROM users WHERE email IS NULL ORDER BY created, rowid LIMIT 1").toArray()[0];
    let u = row && row.u;
    if (!u) {
      u = "h" + hex(await crypto.subtle.digest("SHA-256", enc.encode(email))).slice(0, 16);
      this.sql.exec("INSERT OR IGNORE INTO users (u, hash, salt, created, quota, used) VALUES (?, '', '', ?, NULL, 0)", u, Date.now());
    }
    this.sql.exec("UPDATE users SET email = ?, name = ?, hubadmin = ?, checked = ?, delete_at = NULL WHERE u = ?", email, name || email.split("@")[0], admin ? 1 : 0, Date.now(), u);
    return u;
  }
  hubState(email, st) {
    const row = this.sql.exec("SELECT u, delete_at FROM users WHERE email = ?", email).toArray()[0]; if (!row) return;
    if (st && st.exists) this.sql.exec("UPDATE users SET hubadmin = ?, name = COALESCE(NULLIF(?, ''), name), checked = ?, delete_at = NULL WHERE u = ?", st.admin ? 1 : 0, st.name || "", Date.now(), row.u);
    else {
      if (!row.delete_at) this.sql.exec("UPDATE users SET delete_at = ?, hubadmin = 0, checked = ? WHERE u = ?", Date.now() + REMOVED_DAYS * 864e5, Date.now(), row.u);
      this.sql.exec("DELETE FROM sessions WHERE u = ?", row.u);
    }
  }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const b = await req.json().catch(() => ({}));
    const now = Date.now();
    if (path === "/sso") {
      const email = String(b.email || "").toLowerCase();
      if (!email || !b.n || !b.exp || b.exp < now) return bad("That sign-in has expired.");
      this.sql.exec("DELETE FROM nonces WHERE exp < ?", now);
      if (this.sql.exec("SELECT 1 FROM nonces WHERE n = ?", String(b.n)).toArray().length) return bad("That sign-in link was already used.");
      this.sql.exec("INSERT INTO nonces VALUES (?, ?)", String(b.n), b.exp);
      const u = await this.accountFor(email, String(b.name || "").slice(0, 60), !!b.admin);
      this.sql.exec("DELETE FROM sessions WHERE exp < ?", now);
      return json({ ...this.info(u), token: this.newSession(u) });
    }
    if (path === "/check") {
      const row = this.sql.exec("SELECT s.u, s.exp, u.email, u.delete_at FROM sessions s LEFT JOIN users u ON u.u = s.u WHERE s.t = ?", String(b.token || "")).toArray()[0];
      if (!row || row.exp < now) return json({ user: null });
      if (!row.email) { this.sql.exec("DELETE FROM sessions WHERE t = ?", String(b.token || "")); return json({ user: null }); }   // from before hub sign-in
      if (row.delete_at) return json({ user: null, removed: true });
      return json(this.info(row.u));
    }
    if (path === "/hubstate") {         // one account checked against the hub
      this.hubState(String(b.email || "").toLowerCase(), b);
      const row = this.sql.exec("SELECT u FROM sessions WHERE t = ?", String(b.token || "")).toArray()[0];
      return json(row ? this.info(row.u) : { user: null, removed: true });
    }
    if (path === "/hubstate-all") { for (const [e, st] of Object.entries(b.users || {})) this.hubState(e.toLowerCase(), st); return json({ ok: true }); }
    if (path === "/emails") return json({ emails: this.sql.exec("SELECT email FROM users WHERE email IS NOT NULL").toArray().map(r => r.email) });
    if (path === "/due") {              // removed long enough ago: delete
      const users = this.sql.exec("SELECT u FROM users WHERE delete_at IS NOT NULL AND delete_at < ?", now).toArray().map(r => r.u);
      for (const u of users) { this.sql.exec("DELETE FROM users WHERE u = ?", u); this.sql.exec("DELETE FROM sessions WHERE u = ?", u); this.sql.exec("DELETE FROM shares WHERE owner = ?", u); }
      return json({ users });
    }
    if (path === "/secret") {
      let r = this.sql.exec("SELECT v FROM settings WHERE k = 'share_secret'").toArray()[0];
      if (!r) { r = { v: rand(32) }; this.sql.exec("INSERT INTO settings VALUES ('share_secret', ?)", r.v); }
      return json({ secret: r.v });
    }
    // ---- share codes ----
    if (path === "/share/get") return json(this.codesFor(b.owner, b.doc, false));
    if (path === "/share/reset") return json(this.codesFor(b.owner, b.doc, true));
    if (path === "/share/resolve") {
      if (!this.hit("join:" + b.ip, 30, 600e3)) return json({ error: "Too many tries. Wait 10 minutes.", status: 429 });
      const r = this.sql.exec("SELECT owner, doc, role FROM shares WHERE code = ?", String(b.code || "")).toArray()[0];
      if (!r) return json({ error: "That code doesn't match a shared paper. Check it, or ask for a new one.", status: 404 });
      const o = this.sql.exec("SELECT delete_at FROM users WHERE u = ?", r.owner).toArray()[0];
      if (!o || o.delete_at) return json({ error: "That paper isn't available any more.", status: 404 });
      return json(r);
    }
    if (path === "/usage") { this.sql.exec("UPDATE users SET used = ? WHERE u = ?", Math.max(0, b.used | 0), b.user); return json({ ok: true }); }
    if (path === "/logout") { this.sql.exec("DELETE FROM sessions WHERE t = ?", b.token); return json({ ok: true }); }
    if (path === "/delete") {
      this.sql.exec("DELETE FROM sessions WHERE u = ?", b.user); this.sql.exec("DELETE FROM shares WHERE owner = ?", b.user);
      this.sql.exec("UPDATE users SET used = 0 WHERE u = ?", b.user);     // the hub account stays; papers go
      return json({ ok: true });
    }
    // ---- admin ----
    if (path === "/admin/overview") {
      const def = this.defaultQuota();
      const users = this.sql.exec("SELECT u, created, quota, used, email, name, hubadmin, delete_at FROM users WHERE email IS NOT NULL ORDER BY created").toArray().map(r => ({ user: r.u, email: r.email, name: r.name || r.email, created: r.created, used: r.used || 0, quota: r.hubadmin ? -1 : (r.quota || def), custom: !!r.quota, admin: !!r.hubadmin, deleteAt: r.delete_at || null }));
      return json({ users, defaultQuota: def, choices: QUOTA_CHOICES, globalUsed: this.totalUsed(), globalLimit: GLOBAL_LIMIT });
    }
    if (path === "/admin/quota") { this.sql.exec("UPDATE users SET quota = ? WHERE u = ?", +b.quota, b.user); return json({ ok: true }); }
    if (path === "/admin/default") { this.sql.exec("INSERT OR REPLACE INTO settings VALUES ('default_quota', ?)", String(+b.quota)); return json({ ok: true }); }
    if (path === "/admin/delete-user") { this.sql.exec("DELETE FROM users WHERE u = ?", b.user); this.sql.exec("DELETE FROM sessions WHERE u = ?", b.user); this.sql.exec("DELETE FROM shares WHERE owner = ?", b.user); return json({ ok: true }); }
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
    // people who joined one of this account's papers with a share code; papers shared with this account
    this.sql.exec(`CREATE TABLE IF NOT EXISTS people (doc TEXT, pid TEXT, name TEXT, email TEXT, role TEXT, first INTEGER, last INTEGER, removed INTEGER DEFAULT 0, PRIMARY KEY (doc, pid));
      CREATE TABLE IF NOT EXISTS shared (owner TEXT, doc TEXT, role TEXT, name TEXT, joined INTEGER, opened INTEGER, PRIMARY KEY (owner, doc));`);
  }
  // live sockets for a paper, with who they are
  socks(doc) { return this.ctx.getWebSockets("doc:" + doc).map(ws => ({ ws, a: ws.deserializeAttachment() || {} })); }
  closePerson(doc, pid, code, why) { for (const { ws, a } of this.socks(doc)) if (a.pid === pid) { try { ws.send(JSON.stringify({ t: "removed", why })); ws.close(code, why); } catch {} } }
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
    this.sql.exec("DELETE FROM kv WHERE doc = ?", id); this.sql.exec("DELETE FROM docs WHERE id = ?", id); this.sql.exec("DELETE FROM people WHERE doc = ?", id);
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
      const role = req.headers.get("x-share-role"), pid = req.headers.get("x-share-pid") || "";
      let att;
      if (role) {                       // someone who joined with a share code
        const d = this.docRow(doc), who = this.sql.exec("SELECT name, removed FROM people WHERE doc = ? AND pid = ?", doc, pid).toArray()[0];
        if (!d || d.deleted) return bad("This paper isn't shared any more.", 410);
        if (!who || who.removed) return bad("The owner removed you from this paper.", 403);
        this.sql.exec("UPDATE people SET last = ? WHERE doc = ? AND pid = ?", Date.now(), doc, pid);
        att = { doc, user, role: role === "view" ? "view" : "edit", pid, name: decodeURIComponent(req.headers.get("x-share-name") || who.name || "Guest").slice(0, 40) };
      } else att = { doc, user, role: "owner", pid: "owner", name: decodeURIComponent(req.headers.get("x-name") || "Owner").slice(0, 40), device: (url.searchParams.get("device") || "").slice(0, 40) };
      att.sid = rand(6); att.focus = null;
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["doc:" + doc]);
      pair[1].serializeAttachment(att);
      pair[1].send(JSON.stringify({ t: "welcome", sid: att.sid, role: att.role }));
      this.presence(doc);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    // ---- sharing ----
    if (path.startsWith("/share/") || path.startsWith("/shared/")) {
      const b = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      if (path === "/share/own") { const d = this.docRow(b.doc); return json({ ok: !!d && !d.deleted }); }
      if (path === "/share/join" || path === "/share/rejoin") {
        const d = this.docRow(b.doc);
        if (!d || d.deleted) return json({ error: "That paper isn't available any more.", gone: true });
        let row = b.email ? this.sql.exec("SELECT pid, role, removed FROM people WHERE doc = ? AND email = ?", b.doc, b.email).toArray()[0] : null;
        if (row && row.removed) return json({ error: "The owner removed you from this paper.", gone: true });
        if (path === "/share/rejoin" && !row) return json({ error: "You're no longer on this paper. Ask the owner for a code.", gone: true });
        const role = path === "/share/rejoin" ? row.role : (row && row.role === "edit" ? "edit" : b.role);   // joining with a view code never downgrades an editor
        let pid = row && row.pid;
        if (!pid) { pid = rand(8); this.sql.exec("INSERT INTO people (doc, pid, name, email, role, first, last) VALUES (?, ?, ?, ?, ?, ?, ?)", b.doc, pid, String(b.name || "Guest").slice(0, 40), b.email || null, role, Date.now(), Date.now()); }
        else this.sql.exec("UPDATE people SET role = ?, name = ?, last = ? WHERE doc = ? AND pid = ?", role, String(b.name || "Guest").slice(0, 40), Date.now(), b.doc, pid);
        return json({ pid, role, name: d.name, pdf: d.pdf || d.id, haspdf: !!d.haspdf });
      }
      if (path === "/share/pdf") {
        const doc = url.searchParams.get("doc"), pid = url.searchParams.get("pid"), d = this.docRow(doc || "");
        const who = this.sql.exec("SELECT removed FROM people WHERE doc = ? AND pid = ?", doc, pid).toArray()[0];
        if (!d || d.deleted || !who || who.removed) return bad("Not available", 403);
        return this.pdfRoute(new Request("https://do", { method: "GET" }), d.pdf || d.id, url, user, quota, globalFree, null);
      }
      if (path === "/share/people") {
        const online = new Set(this.socks(b.doc).map(x => x.a.pid));
        const people = this.sql.exec("SELECT pid, name, email, role, first, last, removed FROM people WHERE doc = ? ORDER BY first", b.doc).toArray().map(r => ({ ...r, removed: !!r.removed, online: online.has(r.pid) }));
        return json({ people });
      }
      if (path === "/share/remove") {
        this.sql.exec("UPDATE people SET removed = 1 WHERE doc = ? AND pid = ?", b.doc, b.pid);
        this.closePerson(b.doc, b.pid, 4003, "removed");
        this.presence(b.doc);
        return json({ ok: true });
      }
      // this account's list of papers other people shared with it
      if (path === "/shared/add") { this.sql.exec("INSERT INTO shared (owner, doc, role, name, joined, opened) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (owner, doc) DO UPDATE SET role = excluded.role, name = excluded.name, opened = excluded.opened", b.owner, b.doc, b.role, String(b.name || "Shared paper").slice(0, 200), Date.now(), Date.now()); return json({ ok: true }); }
      if (path === "/shared/remove") { this.sql.exec("DELETE FROM shared WHERE owner = ? AND doc = ?", b.owner, b.doc); return json({ ok: true }); }
      if (path === "/shared/list") return json({ shared: this.sql.exec("SELECT owner, doc, role, name, joined, opened FROM shared ORDER BY opened DESC").toArray() });
      return bad("Not found", 404);
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
        if (b.deleted) for (const { ws, a } of this.socks(id)) if (a.role !== "owner") { try { ws.send(JSON.stringify({ t: "deleted" })); ws.close(4002, "deleted"); } catch {} }
        if (b.opened) this.sql.exec("UPDATE docs SET opened = ? WHERE id = ?", Date.now(), id);
        return json({ ok: true });
      }
      if (!m[2] && req.method === "DELETE") {
        if (url.searchParams.get("purge")) { this.purgeDoc(id); await this.report(user); }
        else { this.sql.exec("UPDATE docs SET deleted = ? WHERE id = ?", Date.now(), id); for (const { ws, a } of this.socks(id)) if (a.role !== "owner") { try { ws.send(JSON.stringify({ t: "deleted" })); ws.close(4002, "deleted"); } catch {} } }
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

  // who's in a paper right now, and which answer space each of them is typing in (that space is locked for others)
  presence(doc) {
    const list = this.socks(doc);
    const people = list.map(({ a }) => ({ sid: a.sid, pid: a.pid, name: a.name, role: a.role, focus: a.focus || null }));
    const msg = JSON.stringify({ t: "presence", n: list.length, people });
    list.forEach(({ ws }) => { try { ws.send(msg); } catch {} });
  }
  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const { doc, user } = ws.deserializeAttachment() || {};
    if (!doc) return;
    const att = ws.deserializeAttachment() || {};
    if (m.t === "focus") {
      // one person per answer space at a time
      const rid = typeof m.rid === "string" ? m.rid.slice(0, 80) : null;
      if (rid && att.role === "view") return;
      if (rid) { const holder = this.socks(doc).find(x => x.ws !== ws && x.a.focus === rid); if (holder) { ws.send(JSON.stringify({ t: "locked", rid, by: holder.a.name })); return; } }
      att.focus = rid; ws.serializeAttachment(att); this.presence(doc);
      return;
    }
    if (m.t === "hello") {
      if (att.role && att.role !== "owner") {           // collaborators never create, rename or restore the paper
        const row = this.docRow(doc); if (!row || row.deleted) { ws.send(JSON.stringify({ t: "deleted" })); try { ws.close(4002, "deleted"); } catch {} return; }
        const since = Number(m.since) || 0;
        const rows = this.sql.exec("SELECT k, v, seq FROM kv WHERE doc = ? AND seq > ? ORDER BY seq", doc, since).toArray();
        for (let i = 0; i < rows.length; i += 300) ws.send(JSON.stringify({ t: "snap", items: rows.slice(i, i + 300).map(r => [r.k, r.v, r.seq]) }));
        ws.send(JSON.stringify({ t: "ready", seq: row.seq, haspdf: true, fresh: false, shared: true }));
        return;
      }
      this.ensureDoc(doc, String(m.name || "Untitled").slice(0, 200), HEX.test(m.pdf || "") ? m.pdf : null);
      this.sql.exec("UPDATE docs SET opened = ?, deleted = NULL WHERE id = ?", Date.now(), doc);   // opening a paper takes it out of the bin
      const since = Number(m.since) || 0, row = this.docRow(doc);
      const rows = this.sql.exec("SELECT k, v, seq FROM kv WHERE doc = ? AND seq > ? ORDER BY seq", doc, since).toArray();
      for (let i = 0; i < rows.length; i += 300) ws.send(JSON.stringify({ t: "snap", items: rows.slice(i, i + 300).map(r => [r.k, r.v, r.seq]) }));
      ws.send(JSON.stringify({ t: "ready", seq: row.seq, haspdf: !!row.haspdf, fresh: since === 0 && rows.length === 0 }));
      return;
    }
    if (m.t === "sets" && Array.isArray(m.ops)) {
      if (att.role === "view") { ws.send(JSON.stringify({ t: "ack", acks: m.ops.map(o => [o.id, 0]), seq: this.docRow(doc)?.seq || 0, readonly: true })); return; }
      if (att.role && att.role !== "owner" && !this.docRow(doc)) return;
      const acks = [], out = [], refused = [];
      let seq = this.docRow(doc)?.seq || 0;
      for (const op of m.ops.slice(0, 500)) {
        if (typeof op.k !== "string" || op.k.length > 200) continue;
        if (att.role && att.role !== "owner" && op.k === "meta") { acks.push([op.id, seq]); continue; }   // only the owner names the paper
        // an answer space someone else is typing in can't be overwritten
        if (op.k.startsWith("text:") && this.socks(doc).some(x => x.ws !== ws && x.a.focus === op.k.slice(5))) { acks.push([op.id, seq]); refused.push(op.k); continue; }
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
      if (refused.length) {             // put back what's really there
        const items = refused.map(k => { const r = this.sql.exec("SELECT v, seq FROM kv WHERE doc = ? AND k = ?", doc, k).toArray()[0]; return [k, r ? r.v : null, r ? r.seq : seq]; });
        ws.send(JSON.stringify({ t: "snap", items, live: true }));
      }
      const msg = JSON.stringify({ t: "snap", items: out, live: true });
      for (const other of this.ctx.getWebSockets("doc:" + doc)) if (other !== ws) { try { other.send(msg); } catch {} }
      // keep the account's usage roughly current without reporting on every keystroke
      if (!this.reportT || Date.now() - this.reportT > 60000) { this.reportT = Date.now(); this.report(user); }
      return;
    }
    if (m.t === "ping") ws.send(JSON.stringify({ t: "pong" }));
  }
  async webSocketClose(ws) { const { doc, user } = ws.deserializeAttachment() || {}; try { ws.close(); } catch {} if (doc) { setTimeout(() => this.presence(doc), 50); this.report(user); } }
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
