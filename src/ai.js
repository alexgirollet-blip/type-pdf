// ai.js — "Mark with AI" and the chat on a marked paper, answered by whichever free AI is available.
//
// The page sees one AI. Behind it is a list of providers, best first; each request goes to the first one that's set
// up and not resting after a limit, and moves down the list on any error, limit or unusable reply. Every provider
// here has a free tier that refuses requests at its limit instead of charging, as long as no billing is attached
// (see docs/ai-setup.md). Keys are entered by the admin in TypePDF (stored server-side, never sent to browsers) or
// set as Worker secrets.
//
// Marking replies must be a TypePDF marking (format typepdf-marking): JSON is asked for, pulled out of whatever the
// model sends, and checked before it's accepted.

// best first. Each entry can be tried with several models (a model's own free limit runs out separately)
export const PROVIDERS = [
  { id: "claude", name: "Claude (Anthropic API)", env: "ANTHROPIC_API_KEY", models: ["claude-sonnet-5-5"], images: 20, kind: "anthropic", paid: true },
  { id: "gemini", name: "Google Gemini", env: "GEMINI_API_KEY", models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"], images: 40, kind: "gemini" },
  { id: "github", name: "GitHub Models", env: "GITHUB_MODELS_TOKEN", models: ["openai/gpt-4.1", "openai/gpt-4o"], images: 8, kind: "openai", url: "https://models.github.ai/inference/chat/completions" },
  { id: "mistral", name: "Mistral", env: "MISTRAL_API_KEY", models: ["mistral-medium-latest", "pixtral-large-latest"], images: 8, kind: "openai", url: "https://api.mistral.ai/v1/chat/completions", imageAsString: true },
  { id: "openrouter", name: "OpenRouter (free models)", env: "OPENROUTER_API_KEY", models: ["meta-llama/llama-4-maverick:free", "qwen/qwen2.5-vl-72b-instruct:free", "google/gemma-3-27b-it:free"], images: 6, kind: "openai", url: "https://openrouter.ai/api/v1/chat/completions" },
  { id: "groq", name: "Groq", env: "GROQ_API_KEY", models: ["meta-llama/llama-4-maverick-17b-128e-instruct", "meta-llama/llama-4-scout-17b-16e-instruct"], images: 5, kind: "openai", url: "https://api.groq.com/openai/v1/chat/completions" },
  { id: "custom", name: "Any other OpenAI-compatible API", env: "CUSTOM_AI_KEY", models: [], images: 4, kind: "openai", custom: true },
  { id: "cloudflare", name: "Cloudflare Workers AI", env: "", models: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"], images: 0, kind: "workers-ai", optIn: true },
];

// a provider that just said "limit reached" rests for a while (per server instance; it's only a shortcut)
const resting = new Map();     // "provider/model" → until
const rest = (k, ms) => resting.set(k, Date.now() + ms);
const isResting = k => (resting.get(k) || 0) > Date.now();

// the providers that can be used now, in order, from the admin's settings (keys, extra models, on/off) and secrets
export function available(env, settings) {
  const out = [];
  for (const p of PROVIDERS) {
    const s = (settings && settings[p.id]) || {};
    if (s.on === false) continue;
    const key = String(s.key || (p.env && env[p.env]) || "").trim();
    if (p.kind === "workers-ai") { if (!env.AI || !s.on) continue; }
    else if (!key) continue;
    const models = String(s.models || "").split(/[\s,]+/).filter(Boolean);
    if (p.custom) { const url = String(s.url || env.CUSTOM_AI_URL || "").trim(); if (!/^https?:\/\//.test(url) || !models.length) continue; for (const model of models) out.push({ ...p, key, model, url, images: +s.images || p.images }); continue; }
    for (const model of models.length ? models : p.models) out.push({ ...p, key, model });
  }
  return out;
}
// what the settings panel shows: which are set up (never the keys themselves)
export function status(env, settings) {
  return PROVIDERS.map(p => {
    const s = (settings && settings[p.id]) || {};
    const fromEnv = !!(p.env && env[p.env]);
    return { id: p.id, url: p.custom ? (s.url || "") : undefined, name: p.name, set: p.kind === "workers-ai" ? !!env.AI : !!(s.key || fromEnv), fromEnv, on: p.kind === "workers-ai" ? !!s.on : s.on !== false, models: s.models || "", defaults: p.models.join(", "), paid: !!p.paid, optIn: !!p.optIn, images: p.images };
  });
}

// ---- one request to one provider. msgs: [{ role: "user"|"assistant", text, images?: [{ mime, data }] }] ----
async function ask(env, p, system, msgs, { json, maxTokens = 12000, timeout = 120000 }) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  try {
    let res, out;
    if (p.kind === "gemini") {
      const body = { systemInstruction: { parts: [{ text: system }] }, contents: msgs.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }, ...(m.images || []).map(i => ({ inline_data: { mime_type: i.mime, data: i.data } }))] })), generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: "application/json" } : {}) } };
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent`, { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json", "x-goog-api-key": p.key }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw err(res.status, j.error && j.error.message);
      out = ((j.candidates || [])[0] || {}).content; out = out && (out.parts || []).map(x => x.text || "").join("");
      if (!out) throw err(502, "empty reply" + (j.promptFeedback ? " (" + JSON.stringify(j.promptFeedback).slice(0, 120) + ")" : ""));
    } else if (p.kind === "anthropic") {
      const body = { model: p.model, max_tokens: maxTokens, system, messages: msgs.map(m => ({ role: m.role, content: [...(m.images || []).map(i => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })), { type: "text", text: m.text }] })) };
      res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json", "x-api-key": p.key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw err(res.status, j.error && j.error.message);
      out = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    } else if (p.kind === "openai") {
      const content = m => (m.images || []).length ? [{ type: "text", text: m.text }, ...m.images.map(i => ({ type: "image_url", image_url: p.imageAsString ? `data:${i.mime};base64,${i.data}` : { url: `data:${i.mime};base64,${i.data}` } }))] : m.text;
      const body = { model: p.model, temperature: 0.2, max_tokens: Math.min(maxTokens, 8000), messages: [{ role: "system", content: system }, ...msgs.map(m => ({ role: m.role, content: content(m) }))], ...(json ? { response_format: { type: "json_object" } } : {}) };
      const headers = { "content-type": "application/json", authorization: "Bearer " + p.key };
      if (p.id === "openrouter") { headers["HTTP-Referer"] = "https://typepdf.app"; headers["X-Title"] = "TypePDF"; }
      res = await fetch(p.url, { method: "POST", signal: ctl.signal, headers, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw err(res.status, (j.error && (j.error.message || j.error)) || j.message);
      out = (((j.choices || [])[0] || {}).message || {}).content;
      if (Array.isArray(out)) out = out.map(x => x.text || "").join("");
    } else if (p.kind === "workers-ai") {
      const r = await env.AI.run(p.model, { messages: [{ role: "system", content: system }, ...msgs.map(m => ({ role: m.role, content: m.text }))], max_tokens: Math.min(maxTokens, 4000) });
      out = r && (r.response || r.result || "");
      if (typeof out !== "string") out = JSON.stringify(out);
    }
    if (!out || !String(out).trim()) throw err(502, "empty reply");
    return String(out);
  } catch (e) {
    if (e.name === "AbortError") throw err(504, "took too long");
    throw e;
  } finally { clearTimeout(t); }
}
const err = (status, msg) => Object.assign(new Error(String(msg || "error " + status).slice(0, 300)), { status });

// the JSON object in a reply: fenced or not, with chatter around it
export function pullJSON(text) {
  let s = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  try { return JSON.parse(s); } catch (e) {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
  return null;
}
// a marking good enough to import (TypePDF checks the details when it imports)
export function checkMarking(j, meta = {}) {
  if (!j || typeof j !== "object") return "not JSON";
  if (Array.isArray(j)) j = { parts: j };
  if (!Array.isArray(j.parts) || !j.parts.length) return "no parts";
  if (!j.parts.every(p => p && (p.id || p.q))) return "parts without ids";
  j.format = "typepdf-marking"; j.version = 1;
  if (meta.paperId) j.paperId = meta.paperId;
  if (meta.exported) j.exported = meta.exported;
  if (meta.paperTitle && !j.paperTitle) j.paperTitle = meta.paperTitle;
  j.markedAt ||= new Date().toISOString();
  return j;
}

// try each provider in turn until one gives a usable answer. check(text) returns the result, or a string saying why not
export async function run(env, settings, system, msgs, { json, check, maxTokens, deadline = Date.now() + 240000 } = {}) {
  const list = available(env, settings), tried = [];
  if (!list.length) throw err(503, "No AI is set up yet. The admin can add free API keys in TypePDF: Export for AI → AI settings.");
  for (const p of list) {
    const k = p.id + "/" + p.model;
    if (isResting(k)) { tried.push({ k, why: "resting after a limit" }); continue; }
    if (Date.now() > deadline - 15000) { tried.push({ k, why: "out of time" }); break; }
    const trimmed = msgs.map(m => ({ ...m, images: (m.images || []).slice(0, p.images) }));
    try {
      const text = await ask(env, p, system, trimmed, { json, maxTokens, timeout: Math.min(150000, deadline - Date.now()) });
      const r = check ? check(text) : text;
      if (typeof r === "string" && check) { tried.push({ k, why: "unusable reply: " + r }); continue; }
      return { result: r, provider: p.name, model: p.model, tried };
    } catch (e) {
      const st = e.status || 0;
      if (st === 429 || /quota|rate.?limit|exhaust|limit/i.test(e.message)) rest(k, 15 * 60e3);
      else if (st === 401 || st === 403) rest(k, 60 * 60e3);
      else if (st === 404 || st === 400) rest(k, 30 * 60e3);
      tried.push({ k, why: `${st || ""} ${e.message}`.trim() });
    }
  }
  const e = err(503, "Every AI was busy or at its free limit. Try again later, or use Export for AI."); e.tried = tried; throw e;
}

// ---- marking: the instructions and the answers (text) plus the handwriting (images) ----
export async function mark(env, settings, b) {
  const meta = { paperId: b.paperId, exported: b.exported, paperTitle: b.paperTitle };
  const system = "You are an experienced, strict but fair exam marker. You reply with ONLY a JSON object (no prose, no code fences) in the TypePDF marking format described in the instructions.";
  const images = (Array.isArray(b.images) ? b.images : []).filter(i => i && /^image\/(jpeg|png|webp)$/.test(i.mime) && typeof i.data === "string").slice(0, 40);
  const labels = images.map((i, k) => `Image ${k + 1}: ${String(i.label || "").slice(0, 80)}`).join("\n");
  const text = `${String(b.prompt || "").slice(0, 30000)}\n\n## answers.json\n${String(b.answers || "").slice(0, 400000)}\n\n${labels ? "## The images attached (in this order)\n" + labels : "(No handwriting images.)"}\n\nReply with only the marking JSON.`;
  return run(env, settings, system, [{ role: "user", text, images }], { json: true, maxTokens: 16000, check: t => { const j = pullJSON(t); const c = checkMarking(j, meta); return c; } });
}
// ---- the chat on a marked paper ----
export async function chat(env, settings, b) {
  const ctx = String(b.context || "").slice(0, 120000);
  const system = `You are a friendly, precise tutor helping a student understand how their exam paper was marked and how to improve. Be concise (a few sentences or short steps), use the exam board's language, and be honest about mistakes. Use plain text with simple maths notation.\n\nThe paper, the student's answers and the marking:\n${ctx}`;
  const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-16).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", text: String(m.text || "").slice(0, 8000) })).filter(m => m.text);
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") throw err(400, "Ask a question first.");
  return run(env, settings, system, msgs, { maxTokens: 1500, deadline: Date.now() + 90000 });
}
