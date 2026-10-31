// type-pdf Worker: serves the app, accounts, per-user storage and live sync.
import { DurableObject } from "cloudflare:workers";

const MAX_PDF = 40 * 1024 * 1024;        // largest PDF we store
const MAX_USER = 400 * 1024 * 1024;      // total PDF storage per account
const CHUNK = 1024 * 1024;               // SQLite value limit is 2 MB; store PDFs in 1 MB chunks
const SESSION_DAYS = 60;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
const bad = (msg, status = 400) => json({ error: msg }, status);

function tokenFrom(req) {
  const h = req.headers.get("authorization") || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  return new URL(req.url).searchParams.get("token") || "";
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
  const auth = env.AUTH.get(env.AUTH.idFromName("auth"));
  const path = url.pathname;
  const ip = req.headers.get("cf-connecting-ip") || "local";

  // ---- account routes (no session needed) ----
  if (path === "/api/auth/signup" || path === "/api/auth/login") {
    if (req.method !== "POST") return bad("Use POST", 405);
    const body = await req.json().catch(() => ({}));
    return auth.fetch(new Request("https://auth" + path.slice(9), { method: "POST", body: JSON.stringify({ ...body, ip }) }));
  }

  // everything else needs a session
  const token = tokenFrom(req);
  if (!token) return bad("Sign in first", 401);
  const who = await (await auth.fetch(new Request("https://auth/check", { method: "POST", body: JSON.stringify({ token }) }))).json();
  if (!who.user) return bad("Your session has ended. Sign in again.", 401);
  const user = who.user;

  if (path === "/api/auth/me") return json({ user });
  if (path === "/api/auth/logout" || path === "/api/auth/password" || path === "/api/auth/delete") {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const res = await auth.fetch(new Request("https://auth" + path.slice(9), { method: "POST", body: JSON.stringify({ ...body, token, user, ip }) }));
    if (path === "/api/auth/delete" && res.ok) {
      const store = env.USERS.get(env.USERS.idFromName("u:" + user));
      await store.fetch(new Request("https://user/wipe", { method: "POST" }));
    }
    return res;
  }

  // fetch a PDF from a pasted link (signed-in users only, PDFs only)
  if (path === "/api/fetch-pdf") {
    const target = url.searchParams.get("url") || "";
    let u; try { u = new URL(target); } catch { return bad("That link isn't valid."); }
    if (!/^https?:$/.test(u.protocol)) return bad("Only http and https links work.");
    const r = await fetch(u.toString(), { headers: { "user-agent": "type-pdf/1.0" }, redirect: "follow" });
    if (!r.ok) return bad(`The site answered ${r.status}.`, 502);
    const len = +(r.headers.get("content-length") || 0);
    if (len > MAX_PDF) return bad("That PDF is too large (40 MB max).", 413);
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_PDF) return bad("That PDF is too large (40 MB max).", 413);
    const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 1024)));
    if (!head.includes("%PDF")) return bad("That link isn't a PDF file.");
    const name = decodeURIComponent((u.pathname.split("/").pop() || "paper.pdf")).slice(0, 120);
    return new Response(buf, { headers: { "content-type": "application/pdf", "x-file-name": encodeURIComponent(name) } });
  }

  // per-user storage + sync
  const store = env.USERS.get(env.USERS.idFromName("u:" + user));
  const fwd = new Request("https://user" + path.slice(4) + url.search, req);
  const headers = new Headers(fwd.headers); headers.set("x-user", user);
  return store.fetch(new Request(fwd, { headers }));
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

export class AuthStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS users (u TEXT PRIMARY KEY, hash TEXT, salt TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (t TEXT PRIMARY KEY, u TEXT, exp INTEGER);
      CREATE TABLE IF NOT EXISTS limits (k TEXT PRIMARY KEY, n INTEGER, reset INTEGER);`);
  }
  // simple fixed-window rate limit
  hit(key, max, windowMs) {
    const now = Date.now();
    const row = this.sql.exec("SELECT n, reset FROM limits WHERE k = ?", key).toArray()[0];
    if (!row || row.reset < now) { this.sql.exec("INSERT OR REPLACE INTO limits VALUES (?, 1, ?)", key, now + windowMs); return true; }
    if (row.n >= max) return false;
    this.sql.exec("UPDATE limits SET n = n + 1 WHERE k = ?", key); return true;
  }
  newSession(u) {
    const t = rand(32);
    this.sql.exec("INSERT INTO sessions VALUES (?, ?, ?)", t, u, Date.now() + SESSION_DAYS * 864e5);
    return t;
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
      this.sql.exec("INSERT INTO users VALUES (?, ?, ?, ?)", u, hash, salt, now);
      return json({ user: u, token: this.newSession(u) });
    }
    if (path === "/login") {
      const u = String(b.username || "").trim().toLowerCase(), p = String(b.password || "");
      if (!this.hit("login:" + u, 10, 900e3) || !this.hit("loginip:" + b.ip, 40, 900e3)) return bad("Too many attempts. Wait 15 minutes and try again.", 429);
      const row = this.sql.exec("SELECT hash, salt FROM users WHERE u = ?", u).toArray()[0];
      const hash = await hashPw(p, row ? row.salt : "00".repeat(16));
      if (!row || !sameStr(hash, row.hash)) return bad("Wrong username or password.", 401);
      this.sql.exec("DELETE FROM sessions WHERE exp < ?", now);
      return json({ user: u, token: this.newSession(u) });
    }
    if (path === "/check") {
      const row = this.sql.exec("SELECT u, exp FROM sessions WHERE t = ?", String(b.token || "")).toArray()[0];
      if (!row || row.exp < now) return json({ user: null });
      return json({ user: row.u });
    }
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
      this.sql.exec("DELETE FROM users WHERE u = ?", b.user);
      this.sql.exec("DELETE FROM sessions WHERE u = ?", b.user);
      return json({ ok: true });
    }
    return bad("Not found", 404);
  }
}

// ===================== one store per user =====================
export class UserStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, name TEXT, created INTEGER, updated INTEGER, size INTEGER, pages INTEGER, filled INTEGER, total INTEGER, seq INTEGER DEFAULT 0, haspdf INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS kv (doc TEXT, k TEXT, v TEXT, seq INTEGER, PRIMARY KEY (doc, k));
      CREATE INDEX IF NOT EXISTS kv_seq ON kv (doc, seq);
      CREATE TABLE IF NOT EXISTS pdf (doc TEXT, i INTEGER, data BLOB, PRIMARY KEY (doc, i));`);
  }
  docRow(id) { return this.sql.exec("SELECT * FROM docs WHERE id = ?", id).toArray()[0]; }
  ensureDoc(id, name) {
    if (!this.docRow(id)) this.sql.exec("INSERT INTO docs (id, name, created, updated, size, pages, filled, total, seq, haspdf) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0)", id, name || "Untitled", Date.now(), Date.now());
  }
  async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    if (path === "/wipe") { this.ctx.getWebSockets().forEach(ws => { try { ws.close(4001, "account deleted"); } catch {} }); await this.ctx.storage.deleteAll(); return json({ ok: true }); }
    if (path === "/sync") {
      if (req.headers.get("upgrade") !== "websocket") return bad("Expected a WebSocket", 426);
      const doc = url.searchParams.get("doc") || "";
      if (!/^[a-f0-9]{8,64}$/.test(doc)) return bad("Bad paper id");
      const pair = new WebSocketPair();
      const device = (url.searchParams.get("device") || "").slice(0, 40);
      this.ctx.acceptWebSocket(pair[1], ["doc:" + doc]);
      pair[1].serializeAttachment({ doc, device });
      this.presence(doc);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (path === "/docs" && req.method === "GET") {
      const rows = this.sql.exec("SELECT id, name, created, updated, size, pages, filled, total, haspdf FROM docs ORDER BY updated DESC").toArray();
      const used = rows.reduce((s, r) => s + (r.size || 0), 0);
      return json({ docs: rows, used, limit: MAX_USER });
    }
    let m = path.match(/^\/docs\/([a-f0-9]{8,64})(\/pdf)?$/);
    if (m) {
      const id = m[1];
      if (!m[2] && req.method === "DELETE") {
        this.sql.exec("DELETE FROM kv WHERE doc = ?", id); this.sql.exec("DELETE FROM pdf WHERE doc = ?", id); this.sql.exec("DELETE FROM docs WHERE id = ?", id);
        this.ctx.getWebSockets("doc:" + id).forEach(ws => { try { ws.send(JSON.stringify({ t: "deleted" })); ws.close(4002, "deleted"); } catch {} });
        return json({ ok: true });
      }
      if (m[2] && (req.method === "GET" || req.method === "HEAD")) {
        const row = this.docRow(id);
        if (!row || !row.haspdf) return bad("No PDF stored for this paper", 404);
        if (req.method === "HEAD") return new Response(null, { headers: { "content-length": String(row.size) } });
        const parts = this.sql.exec("SELECT data FROM pdf WHERE doc = ? ORDER BY i", id).toArray().map(r => new Uint8Array(r.data));
        const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
        return new Response(out, { headers: { "content-type": "application/pdf", "cache-control": "private, max-age=31536000, immutable" } });
      }
      if (m[2] && req.method === "PUT") {
        const buf = await req.arrayBuffer();
        if (buf.byteLength > MAX_PDF) return bad("That PDF is too large to sync (40 MB max).", 413);
        const digest = hex(await crypto.subtle.digest("SHA-256", buf)).slice(0, 24);
        if (digest !== id) return bad("The PDF doesn't match its id", 400);
        const used = this.sql.exec("SELECT COALESCE(SUM(size), 0) AS s FROM docs WHERE id != ?", id).toArray()[0].s;
        if (used + buf.byteLength > MAX_USER) return bad("Your account is full (400 MB). Delete some papers first.", 413);
        this.ensureDoc(id, decodeURIComponent(url.searchParams.get("name") || "Untitled").slice(0, 200));
        this.sql.exec("DELETE FROM pdf WHERE doc = ?", id);
        const u8 = new Uint8Array(buf);
        for (let i = 0, k = 0; i < u8.length; i += CHUNK, k++) this.sql.exec("INSERT INTO pdf VALUES (?, ?, ?)", id, k, u8.slice(i, i + CHUNK));
        this.sql.exec("UPDATE docs SET size = ?, haspdf = 1, updated = ? WHERE id = ?", buf.byteLength, Date.now(), id);
        return json({ ok: true });
      }
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
    const { doc } = ws.deserializeAttachment() || {};
    if (!doc) return;
    if (m.t === "hello") {
      this.ensureDoc(doc, String(m.name || "Untitled").slice(0, 200));
      const since = Number(m.since) || 0;
      const row = this.docRow(doc);
      // send changes since the client's last seen sequence number, in batches
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
          try { const meta = JSON.parse(v); this.sql.exec("UPDATE docs SET name = ?, pages = ?, filled = ?, total = ? WHERE id = ?", String(meta.name || "Untitled").slice(0, 200), meta.pages | 0, meta.filled | 0, meta.total | 0, doc); } catch {}
        }
      }
      this.sql.exec("UPDATE docs SET seq = ?, updated = ? WHERE id = ?", seq, Date.now(), doc);
      ws.send(JSON.stringify({ t: "ack", acks, seq }));
      const msg = JSON.stringify({ t: "snap", items: out, live: true });
      for (const other of this.ctx.getWebSockets("doc:" + doc)) if (other !== ws) { try { other.send(msg); } catch {} }
      return;
    }
    if (m.t === "ping") ws.send(JSON.stringify({ t: "pong" }));
  }
  async webSocketClose(ws) { const { doc } = ws.deserializeAttachment() || {}; try { ws.close(); } catch {} if (doc) this.presence(doc); }
  async webSocketError(ws) { const { doc } = ws.deserializeAttachment() || {}; if (doc) this.presence(doc); }
}
