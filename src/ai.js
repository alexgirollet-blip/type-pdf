// ai.js — "Mark with AI" and the chat on a marked paper, answered by whichever free AI is available.
//
// The page sees one AI. Behind it is a list of providers, best first; each request goes to the first one that's set
// up and not resting after a limit, and moves down the list on any error, limit or unusable reply. Every provider
// here has a free tier that refuses requests at its limit instead of charging, as long as no billing is attached
// (see docs/ai-setup.md). Keys are entered by the admin in TypePDF (stored server-side, never sent to browsers) or
// set as Worker secrets.
//
// Models aren't fixed: providers retire and rename them all the time, so each provider is asked which models it
// offers right now (cached for a few hours) and the best ones still free are picked. When a provider says a model is
// gone and names its replacement, that's tried next. A request a model rejects for a setting (token limit name,
// temperature, JSON mode, images) is adjusted and sent again.
//
// Marking replies must be a TypePDF marking (format typepdf-marking): JSON is asked for, pulled out of whatever the
// model sends, and checked before it's accepted.

// best first. models: used only if the provider's model list can't be read (or the admin names models)
export const PROVIDERS = [
  { id: "claude", name: "Claude (Anthropic API)", env: "ANTHROPIC_API_KEY", models: ["claude-sonnet-5-5"], images: 20, kind: "anthropic", paid: true },
  { id: "gemini", name: "Google Gemini", env: "GEMINI_API_KEY", models: ["gemini-flash-latest", "gemini-flash-lite-latest"], images: 40, kind: "gemini" },
  { id: "github", name: "GitHub Models", env: "GITHUB_MODELS_TOKEN", models: ["openai/gpt-4.1", "openai/gpt-4o"], images: 8, kind: "openai", url: "https://models.github.ai/inference/chat/completions", tokParam: "max_completion_tokens" },
  { id: "openrouter", name: "OpenRouter (free models)", env: "OPENROUTER_API_KEY", models: ["openrouter/free"], images: 6, kind: "openai", url: "https://openrouter.ai/api/v1/chat/completions", tokParam: "max_tokens" },
  { id: "groq", name: "Groq", env: "GROQ_API_KEY", models: ["meta-llama/llama-4-scout-17b-16e-instruct", "llama-3.3-70b-versatile"], images: 5, kind: "openai", url: "https://api.groq.com/openai/v1/chat/completions", tokParam: "max_completion_tokens" },
  { id: "custom", name: "Any other OpenAI-compatible API", env: "CUSTOM_AI_KEY", models: [], images: 4, kind: "openai", custom: true, tokParam: "max_tokens" },
  { id: "cloudflare", name: "Cloudflare Workers AI", env: "", models: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"], images: 0, kind: "workers-ai", optIn: true },
];

// a provider that just said "limit reached" rests for a while (per server instance; it's only a shortcut)
const resting = new Map();     // "provider/model" → until
const rest = (k, ms) => resting.set(k, Date.now() + ms);
const isResting = k => (resting.get(k) || 0) > Date.now();

// ---- which models each provider offers now, best (and still free) first ----
const discovered = new Map();  // "provider:…key tail" → { at, models }
const verOf = s => { const m = String(s).match(/(\d+(?:\.\d+)?)/); return m ? +m[1] : 0; };
const getJSON = async (u, headers) => { const r = await fetch(u, { headers }); if (!r.ok) throw new Error("list " + r.status); return r.json(); };
export const LIST = {
  // Gemini: the newest of each tier (pro, flash, flash-lite), then the next newest; no image/speech/embedding models
  async gemini(key) {
    const j = await getJSON("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { "x-goog-api-key": key });
    const ms = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => String(m.name).replace(/^models\//, ""))
      .filter(n => /^gemini-/.test(n) && !/(tts|image|embed|live|audio|native|computer|robotics|aqa|learnlm|veo|imagen|thinking-exp|vision|-latest$)/.test(n));
    const tier = n => /flash-lite/.test(n) ? 1 : /flash/.test(n) ? 2 : /pro/.test(n) ? 3 : 0;
    const score = n => verOf(n) * 10 + tier(n) * 2 + (/preview|exp/.test(n) ? 0 : 1) - (/-\d{2}-\d{2}|\d{3,}$/.test(n) ? 0.5 : 0);
    const sorted = ms.filter(n => tier(n)).sort((a, b) => score(b) - score(a));
    const best = t => sorted.filter(n => tier(n) === t);
    // the best pro (often not on the free tier, so it's tried once and rests), then the best flash models, then lite
    return [...best(3).slice(0, 1), ...best(2).slice(0, 2), ...best(1).slice(0, 1)].filter((v, i, a) => a.indexOf(v) === i);
  },
  // OpenRouter: only models that cost nothing, preferring ones that read images, then by family and context
  async openrouter(key) {
    const j = await getJSON("https://openrouter.ai/api/v1/models", { authorization: "Bearer " + key });
    const free = (j.data || []).filter(m => m.pricing && +m.pricing.prompt === 0 && +m.pricing.completion === 0 && !/^openrouter\/auto$/.test(m.id));
    const fam = id => /gemini/.test(id) ? 40 : /qwen.*vl|llama-4|gemma-3/.test(id) ? 30 : /deepseek|qwen3|gpt-oss|kimi|glm|mistral/.test(id) ? 20 : 0;
    const score = m => ((m.architecture && (m.architecture.input_modalities || []).includes("image")) ? 100 : 0) + fam(m.id) + Math.min(20, (m.context_length || 0) / 32000);
    return free.sort((a, b) => score(b) - score(a)).slice(0, 4).map(m => m.id);
  },
  // Groq: vision models first (they read handwriting), then the strongest text models; no speech/guard models
  async groq(key) {
    const j = await getJSON("https://api.groq.com/openai/v1/models", { authorization: "Bearer " + key });
    const ids = (j.data || []).filter(m => m.active !== false).map(m => m.id).filter(id => !/(whisper|tts|guard|playai|distil|orpheus|compound|allam)/i.test(id));
    const score = id => (/llama-4-maverick/.test(id) ? 100 : /llama-4-scout/.test(id) ? 95 : /vision|vl/.test(id) ? 90 : /gpt-oss-120b/.test(id) ? 80 : /kimi|qwen3|deepseek/.test(id) ? 75 : /llama-3\.3-70b/.test(id) ? 70 : 10) + verOf(id) / 100;
    return ids.sort((a, b) => score(b) - score(a)).slice(0, 4);
  },
  // GitHub Models: from its catalogue, models that read images first, newest OpenAI models ahead of the rest
  async github(key) {
    const j = await getJSON("https://models.github.ai/catalog/models", { authorization: "Bearer " + key, accept: "application/vnd.github+json" });
    const list = Array.isArray(j) ? j : (j.models || j.data || []);
    const ok = list.filter(m => m.id && !/(embed|whisper|tts|dall|image-gen)/i.test(m.id) && (!m.supported_output_modalities || m.supported_output_modalities.includes("text")));
    const score = m => ((m.supported_input_modalities || []).includes("image") ? 100 : 0) + (/^openai\/gpt-5/.test(m.id) ? 40 : /^openai\/gpt-4\.1$/.test(m.id) ? 35 : /^openai\/gpt-4o$/.test(m.id) ? 30 : /^openai\//.test(m.id) ? 20 : /llama-4|grok|deepseek|mistral-medium/.test(m.id) ? 15 : 0) - (/mini|nano/.test(m.id) ? 8 : 0);
    return ok.sort((a, b) => score(b) - score(a)).slice(0, 4).map(m => m.id);
  },
};
async function modelsFor(p, key, fresh) {
  if (!LIST[p.id]) return p.models;
  const ck = p.id + ":" + key.slice(-10), c = discovered.get(ck);
  if (!fresh && c && Date.now() - c.at < 6 * 3600e3) return c.models;
  try { const ms = await LIST[p.id](key); if (ms.length) { discovered.set(ck, { at: Date.now(), models: ms }); return ms; } } catch (e) { /* the list couldn't be read: fall back */ }
  return c ? c.models : p.models;
}

// the providers that can be used now, in order, from the admin's settings (keys, models, on/off) and secrets
export async function available(env, settings, fresh) {
  const out = [];
  for (const p of PROVIDERS) {
    const s = (settings && settings[p.id]) || {};
    if (s.on === false) continue;
    const key = String(s.key || (p.env && env[p.env]) || "").trim();
    if (p.kind === "workers-ai") { if (!env.AI || !s.on) continue; }
    else if (!key) continue;
    const named = String(s.models || "").split(/[\s,]+/).filter(Boolean);
    if (p.custom) { const url = String(s.url || env.CUSTOM_AI_URL || "").trim(); if (!/^https?:\/\//.test(url) || !named.length) continue; for (const model of named) out.push({ ...p, key, model, url, images: +s.images || p.images }); continue; }
    for (const model of named.length ? named : await modelsFor(p, key, fresh)) out.push({ ...p, key, model });
  }
  return out;
}
// whether anything at all is set up (without asking anyone for model lists)
export function configured(env, settings) {
  return PROVIDERS.some(p => { const s = (settings && settings[p.id]) || {}; if (s.on === false) return false; if (p.kind === "workers-ai") return !!(env.AI && s.on); if (p.custom) return !!((s.key || env.CUSTOM_AI_KEY) && (s.url || env.CUSTOM_AI_URL) && s.models); return !!(s.key || (p.env && env[p.env])); });
}
// what the settings panel shows: which are set up (never the keys themselves), and the models picked last time
export function status(env, settings) {
  return PROVIDERS.map(p => {
    const s = (settings && settings[p.id]) || {};
    const fromEnv = !!(p.env && env[p.env]), key = String(s.key || (p.env && env[p.env]) || "");
    const auto = key && discovered.get(p.id + ":" + key.slice(-10));
    return { id: p.id, url: p.custom ? (s.url || "") : undefined, name: p.name, set: p.kind === "workers-ai" ? !!env.AI : !!(s.key || fromEnv), fromEnv, on: p.kind === "workers-ai" ? !!s.on : s.on !== false, models: s.models || "", defaults: LIST[p.id] ? "picked automatically" : p.models.join(", "), auto: auto ? auto.models : null, paid: !!p.paid, optIn: !!p.optIn, images: p.images };
  });
}

// ---- one request to one provider. msgs: [{ role: "user"|"assistant", text, images?: [{ mime, data }] }] ----
// Settings a model rejects are dropped and the request sent again (up to 4 times): the name of the token limit,
// temperature, JSON mode, images. A thinking model that used its whole budget thinking gets more room once.
async function ask(env, p, system, msgs, { json, maxTokens = 12000, timeout = 120000 }) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  const o = { json, temp: true, images: true, tokParam: p.tokParam || "max_tokens", max: maxTokens, thinkingBig: false };
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const ms = o.images ? msgs : msgs.map(m => ({ ...m, images: [] }));
      let res, j, out, finish = "";
      if (p.kind === "gemini") {
        const body = { systemInstruction: { parts: [{ text: system }] }, contents: ms.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }, ...(m.images || []).map(i => ({ inline_data: { mime_type: i.mime, data: i.data } }))] })), generationConfig: { maxOutputTokens: o.max, ...(o.temp ? { temperature: 0.2 } : {}), ...(o.json ? { responseMimeType: "application/json" } : {}) } };
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent`, { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json", "x-goog-api-key": p.key }, body: JSON.stringify(body) });
        j = await res.json().catch(() => ({}));
        if (res.ok) { const c = (j.candidates || [])[0] || {}; finish = c.finishReason || ""; out = ((c.content || {}).parts || []).filter(x => !x.thought).map(x => x.text || "").join(""); }
      } else if (p.kind === "anthropic") {
        const body = { model: p.model, max_tokens: o.max, system, messages: ms.map(m => ({ role: m.role, content: [...(m.images || []).map(i => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })), { type: "text", text: m.text }] })) };
        res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json", "x-api-key": p.key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
        j = await res.json().catch(() => ({}));
        if (res.ok) { out = (j.content || []).filter(c => c.type === "text").map(c => c.text).join(""); finish = j.stop_reason || ""; }
      } else if (p.kind === "openai") {
        const content = m => (m.images || []).length ? [{ type: "text", text: m.text }, ...m.images.map(i => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } }))] : m.text;
        const body = { model: p.model, [o.tokParam]: o.max, ...(o.temp ? { temperature: 0.2 } : {}), messages: [{ role: "system", content: system }, ...ms.map(m => ({ role: m.role, content: content(m) }))], ...(o.json ? { response_format: { type: "json_object" } } : {}) };
        const headers = { "content-type": "application/json", authorization: "Bearer " + p.key };
        if (p.id === "openrouter") { headers["HTTP-Referer"] = "https://typepdf.app"; headers["X-Title"] = "TypePDF"; }
        res = await fetch(p.url, { method: "POST", signal: ctl.signal, headers, body: JSON.stringify(body) });
        j = await res.json().catch(() => ({}));
        if (res.ok) {
          if (j.error) { res = { ok: false, status: +(j.error.code) || 502 }; }     // OpenRouter can send an error with a 200
          else { const c = (j.choices || [])[0] || {}; finish = c.finish_reason || ""; out = (c.message || {}).content; if (Array.isArray(out)) out = out.map(x => x.text || "").join(""); }
        }
      } else if (p.kind === "workers-ai") {
        const r = await env.AI.run(p.model, { messages: [{ role: "system", content: system }, ...ms.map(m => ({ role: m.role, content: m.text }))], max_tokens: Math.min(o.max, 4000) });
        out = r && (r.response || r.result || ""); if (typeof out !== "string") out = JSON.stringify(out);
        res = { ok: true };
      }
      if (res.ok) {
        if (out && String(out).trim()) return String(out);
        // nothing but thinking: give it more room once
        if (!o.thinkingBig && /length|max_tokens|MAX_TOKENS/i.test(finish || "length")) { o.thinkingBig = true; o.max = Math.max(o.max * 4, 4096); continue; }
        throw err(502, "empty reply" + (finish ? ` (${finish})` : "") + (j && j.promptFeedback ? " " + JSON.stringify(j.promptFeedback).slice(0, 120) : ""));
      }
      const msg = String((j && j.error && (j.error.message || (typeof j.error === "string" ? j.error : JSON.stringify(j.error)))) || (j && j.message) || "").slice(0, 400);
      // a setting this model doesn't take: change it and ask again
      if (res.status === 400 || res.status === 422) {
        if (/max_completion_tokens/.test(msg) && o.tokParam !== "max_completion_tokens") { o.tokParam = "max_completion_tokens"; continue; }
        if (/max_tokens/.test(msg) && o.tokParam !== "max_tokens") { o.tokParam = "max_tokens"; continue; }
        if (/temperature/i.test(msg) && o.temp) { o.temp = false; continue; }
        if (/response_format|json_object|json mode|responseMimeType|mime/i.test(msg) && o.json) { o.json = false; continue; }
        if (/image|vision|multimodal|image_url|inline_data|content type/i.test(msg) && o.images && msgs.some(m => (m.images || []).length)) { o.images = false; continue; }
      }
      const e = err(res.status, msg || "error " + res.status);
      const use = res.status === 404 && p.kind === "gemini" && msg.match(/use (?:models\/)?(gemini-[a-z0-9.\-]+)/i);
      if (use) e.suggest = use[1];                                              // "…no longer available… use models/gemini-…"
      throw e;
    }
    throw err(502, "the model kept refusing the request");
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

// try each provider in turn until one gives a usable answer. check(text) returns the result, or a string saying why not.
// test: a check from the settings panel (fresh model lists, nothing skipped for resting)
export async function run(env, settings, system, msgs, { json, check, maxTokens, deadline = Date.now() + 240000, test = false } = {}) {
  const list = await available(env, settings, test), tried = [], seen = new Set();
  if (!list.length) throw err(503, "No AI is set up yet. The admin can add free API keys in TypePDF: Export for AI → AI settings.");
  for (let i = 0; i < list.length; i++) {
    const p = list[i], k = p.id + "/" + p.model;
    if (seen.has(k)) continue; seen.add(k);
    if (!test && isResting(k)) { tried.push({ k, why: "resting after a limit" }); continue; }
    if (Date.now() > deadline - 15000) { tried.push({ k, why: "out of time" }); break; }
    const trimmed = msgs.map(m => ({ ...m, images: (m.images || []).slice(0, p.images) }));
    try {
      const text = await ask(env, p, system, trimmed, { json, maxTokens, timeout: Math.min(150000, deadline - Date.now()) });
      const r = check ? check(text) : text;
      if (typeof r === "string" && check) { tried.push({ k, why: "unusable reply: " + r }); continue; }
      return { result: r, provider: p.name, model: p.model, tried };
    } catch (e) {
      const st = e.status || 0;
      if (st === 429 || /quota|rate.?limit|exhaust/i.test(e.message)) rest(k, 15 * 60e3);
      else if (st === 401 || st === 403) rest(k, 30 * 60e3);
      else if (st === 404) rest(k, 6 * 3600e3);
      // the provider named the model to use instead: try it straight after
      if (e.suggest && !seen.has(p.id + "/" + e.suggest)) list.splice(i + 1, 0, { ...p, model: e.suggest });
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
