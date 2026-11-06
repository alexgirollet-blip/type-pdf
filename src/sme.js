// Topic practice: your Save My Exams PDFs, kept on your own server (ZimaOS), reached through a Cloudflare Tunnel
// that only TypePDF can get through (a Cloudflare Access service token).
//
// The folder is served by Caddy's file server, which lists a folder as JSON when asked:
//   SMX AQA A level Physics/
//     2 Particles and Radiation/
//       2-1 Atomic Structure and Decay Equations - Structured.pdf
//       2-1 Atomic Structure and Decay Equations - MCQ.pdf
//     9 Astrophysics/
//       9-1 Telescopes - Exam Questions.pdf
// Settings on this Worker: SME_URL (text), SME_ACCESS_ID and SME_ACCESS_SECRET (secrets).

const TTL = 10 * 60 * 1000;                  // the index is rebuilt at most every 10 minutes
let cache = null;                            // { at, index }

export const smeOn = env => !!(env.SME_URL && env.SME_ACCESS_ID && env.SME_ACCESS_SECRET);
const base = env => String(env.SME_URL).trim().replace(/\/+$/, "") + "/";
const headers = env => ({ "CF-Access-Client-Id": String(env.SME_ACCESS_ID).trim(), "CF-Access-Client-Secret": String(env.SME_ACCESS_SECRET).trim() });

async function listDir(env, rel) {
  const r = await fetch(base(env) + rel.split("/").map(encodeURIComponent).join("/"), { headers: { ...headers(env), accept: "application/json" } });
  if (r.status === 401 || r.status === 403) throw new Error("Your file server turned TypePDF away: check SME_ACCESS_ID and SME_ACCESS_SECRET, and that the Access policy includes the TypePDF service token.");
  if (!r.ok) throw new Error(`Your file server answered ${r.status}.`);
  const type = r.headers.get("content-type") || "";
  if (!type.includes("json")) throw new Error("Your file server didn't send a folder list. It needs Caddy's file-server with --browse (it lists folders as JSON when asked).");
  return r.json();             // [{ name, size, is_dir, mod_time, ... }]
}

// "2 Particles and Radiation" → { n: 2, name }, "2-1 Atomic Structure … - Structured.pdf" → { code: "2-1", topic, type }
const modOf = s => { const m = s.match(/^(\d+)\s*[.\-]?\s*(.+)$/); return m ? { n: +m[1], name: m[2].trim() } : null; };
function fileOf(s) {
  const m = s.replace(/\.pdf$/i, "").match(/^(\d+)\s*[-.]\s*(\d+)\s+(.+?)(?:\s+[-–]\s+(.+))?$/);
  if (!m) return null;
  const t = (m[4] || "").toLowerCase();
  const type = /mark\s*scheme|\bms\b|answers?/.test(t) ? "Mark scheme" : /mcq|multiple/.test(t) ? "MCQ" : /exam/.test(t) ? "Exam questions" : /struct/.test(t) ? "Structured" : (m[4] || "Questions");
  return { code: `${+m[1]}-${+m[2]}`, mod: +m[1], sub: +m[2], topic: m[3].trim(), type };
}

// every PDF in the share, up to three folders deep: [{ module, mod, code, topic, type, path, size }]
export async function smeIndex(env, fresh) {
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache.index;
  const files = [], dirs = [["", 0, null]];
  let reads = 0;
  while (dirs.length && reads < 45) {
    const [rel, depth, mod] = dirs.shift(); reads++;
    const list = await listDir(env, rel);
    for (const it of Array.isArray(list) ? list : []) {
      const name = String(it.name || "").replace(/\/$/, ""); if (!name || name.startsWith(".")) continue;
      const path = rel ? rel + "/" + name : name;
      if (it.is_dir) { if (depth < 3) dirs.push([path, depth + 1, modOf(name) || mod]); continue; }
      if (!/\.pdf$/i.test(name)) continue;
      const f = fileOf(name); if (!f) continue;
      const m = mod && mod.n === f.mod ? mod : (mod || { n: f.mod, name: "" });
      files.push({ module: m.name, mod: f.mod, code: f.code, sub: f.sub, topic: f.topic, type: f.type, path, size: it.size || 0 });
    }
  }
  files.sort((a, b) => a.mod - b.mod || a.sub - b.sub || a.type.localeCompare(b.type));
  const index = { files, at: Date.now() };
  cache = { at: Date.now(), index };
  return index;
}

// one PDF, only if it's in the index (nothing else on the server can be asked for)
export async function smePdf(env, path) {
  const idx = await smeIndex(env);
  const f = idx.files.find(x => x.path === path);
  if (!f) return null;
  const r = await fetch(base(env) + f.path.split("/").map(encodeURIComponent).join("/"), { headers: headers(env) });
  if (!r.ok) throw new Error(`Your file server answered ${r.status}.`);
  return { body: r.body, name: f.path.split("/").pop(), size: f.size };
}
