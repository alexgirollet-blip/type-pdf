// tests/ai.unit.test.mjs — the AI provider layer against fake providers that behave like the real ones do when models
// are retired, free tiers are used up, or a model rejects a setting.   node tests/ai.unit.test.mjs
import * as AI from "../src/ai.js";
let fails = 0;
const ok = (c, what, extra) => { console.log((c ? "  ok   " : "  FAIL ") + what + (!c && extra !== undefined ? "  → " + JSON.stringify(extra).slice(0, 700) : "")); if (!c) fails++; };
const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const body = init.body ? JSON.parse(init.body) : null; calls.push({ url, body });
  // ---- Gemini ----
  if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models?")) return J(200, { models: [
    ...["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.8-flash-image", "gemini-3.5-flash-preview-tts"].map(n => ({ name: "models/" + n, supportedGenerationMethods: ["generateContent"] })),
    { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] }] });
  let m = url.match(/generativelanguage\.googleapis\.com\/v1beta\/models\/([^:]+):generateContent/);
  if (m) {
    const model = decodeURIComponent(m[1]);
    if (/^gemini-2\.5|-latest$/.test(model)) return J(404, { error: { code: 404, message: `This model models/${model} is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements.` } });
    if (/pro/.test(model)) return J(429, { error: { code: 429, message: "You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: " + model } });
    if (model === "gemini-3.8-flash") {
      if (body.generationConfig.maxOutputTokens < 500) return J(200, { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "thinking…", thought: true }] } }] });
      return J(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "OK" }] } }] });
    }
    return J(404, { error: { message: "not found" } });
  }
  // ---- GitHub Models: a thinking model that wants max_completion_tokens and no temperature ----
  if (url === "https://models.github.ai/catalog/models") return J(200, [
    { id: "openai/gpt-5", supported_input_modalities: ["text", "image"], supported_output_modalities: ["text"] },
    { id: "openai/gpt-4.1-mini", supported_input_modalities: ["text", "image"], supported_output_modalities: ["text"] },
    { id: "openai/text-embedding-3-large", supported_input_modalities: ["text"], supported_output_modalities: ["embeddings"] },
    { id: "meta/llama-3.3-70b-instruct", supported_input_modalities: ["text"], supported_output_modalities: ["text"] }]);
  if (url === "https://models.github.ai/inference/chat/completions") {
    if ("max_tokens" in body) return J(400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } });
    if ("temperature" in body) return J(400, { error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported." } });
    if (body.max_completion_tokens < 500) return J(200, { choices: [{ finish_reason: "length", message: { content: "" } }] });
    return J(200, { choices: [{ finish_reason: "stop", message: { content: "OK" } }] });
  }
  // ---- OpenRouter: only the free models ----
  if (url === "https://openrouter.ai/api/v1/models") return J(200, { data: [
    { id: "meta-llama/llama-4-maverick", pricing: { prompt: "0.0000002", completion: "0.0000006" }, architecture: { input_modalities: ["text", "image"] } },
    { id: "google/gemini-3-flash:free", pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text", "image"] }, context_length: 1000000 },
    { id: "deepseek/deepseek-v4:free", pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"] }, context_length: 128000 },
    { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } }] });
  if (url === "https://openrouter.ai/api/v1/chat/completions") {
    if (body.model === "google/gemini-3-flash:free") return J(200, { error: { code: 429, message: "Rate limit exceeded: free-models-per-day" } });
    return J(200, { choices: [{ message: { content: "OK" } }] });
  }
  // ---- Groq: no JSON mode with images ----
  if (url === "https://api.groq.com/openai/v1/models") return J(200, { data: [{ id: "whisper-large-v3" }, { id: "llama-3.3-70b-versatile" }, { id: "meta-llama/llama-4-scout-17b-16e-instruct" }, { id: "openai/gpt-oss-120b" }, { id: "meta-llama/llama-guard-4-12b" }] });
  if (url === "https://api.groq.com/openai/v1/chat/completions") {
    const hasImg = JSON.stringify(body.messages).includes("image_url");
    if (body.response_format && hasImg) return J(400, { error: { message: "response_format json_object is not supported with images" } });
    return J(200, { choices: [{ message: { content: JSON.stringify(body.messages).includes("mark") ? '{"parts":[{"id":"1a","awarded":1,"max":1,"verdict":"correct"}]}' : "OK" } }] });
  }
  return J(404, { error: { message: "unknown " + url } });
};
const only = (id, extra = {}) => Object.fromEntries(AI.PROVIDERS.map(p => [p.id, p.id === id ? { key: "k-" + id, ...extra } : { on: false }]));
const ask = (settings, opts = {}) => AI.run({}, settings, "Reply with exactly: OK", [{ role: "user", text: "Say OK." }], { maxTokens: 1024, deadline: Date.now() + 60000, test: true, ...opts });

console.log("Picking models from each provider's own list");
ok((await AI.LIST.gemini("k")).join() === "gemini-3.1-pro-preview,gemini-3.8-flash,gemini-2.5-flash,gemini-3.5-flash-lite", "Gemini: newest pro, the two newest flash, newest lite (no image/speech/embedding models)", await AI.LIST.gemini("k"));
ok((await AI.LIST.openrouter("k")).join() === "google/gemini-3-flash:free,deepseek/deepseek-v4:free", "OpenRouter: only models that cost nothing, image-reading first", await AI.LIST.openrouter("k"));
ok((await AI.LIST.groq("k"))[0] === "meta-llama/llama-4-scout-17b-16e-instruct" && !(await AI.LIST.groq("k")).some(x => /whisper|guard/.test(x)), "Groq: the vision model first, no speech or guard models", await AI.LIST.groq("k"));
ok((await AI.LIST.github("k"))[0] === "openai/gpt-5" && !(await AI.LIST.github("k")).some(x => /embedding/.test(x)), "GitHub: image-reading OpenAI models first, no embedding models", await AI.LIST.github("k"));

console.log("Gemini (your errors: retired 2.5 models, Pro not free)");
let r = await ask(only("gemini"));
ok(r.model === "gemini-3.8-flash" && r.result === "OK", "answers with the current Flash model", r);
ok(r.tried.some(t => /3\.1-pro-preview/.test(t.k) && /429/.test(t.why)), "the Pro model's free limit (0) is noted and skipped", r.tried);
// a stale default with the list unreadable: Google's "use models/…" is followed
const realList = AI.LIST.gemini; AI.LIST.gemini = async () => { throw new Error("list 403"); };
r = await ask(only("gemini", { key: "other-key-1234567890" }));
AI.LIST.gemini = realList;
ok(r.ok !== false && r.model === "gemini-3.8-flash", "without the list: a retired model's suggested replacement is tried next", r);
ok(calls.some(c => /gemini-3\.8-flash:generateContent/.test(c.url) && c.body.generationConfig.maxOutputTokens >= 1024), "thinking models get room to think (no more empty test replies)", null);

console.log("GitHub Models (your error: empty replies)");
r = await ask(only("github"));
ok(r.model === "openai/gpt-5" && r.result === "OK", "a thinking model answers once its settings are adjusted", r);
const gh = calls.filter(c => c.url.includes("models.github.ai/inference"));
ok(gh.some(c => "max_completion_tokens" in c.body && !("temperature" in c.body)), "max_completion_tokens used and temperature dropped when refused", gh.map(c => Object.keys(c.body)));
r = await AI.run({}, only("github"), "x", [{ role: "user", text: "Say OK." }], { maxTokens: 50, deadline: Date.now() + 60000, test: true });
ok(r.result === "OK", "an empty reply from thinking past its budget is retried with more room", r);

console.log("OpenRouter (your error: the old free models went paid)");
r = await ask(only("openrouter"));
ok(r.model === "deepseek/deepseek-v4:free" && r.tried.some(t => /gemini-3-flash:free/.test(t.k) && /429/.test(t.why)), "a free model at its daily limit (sent as an error inside a 200) moves on to the next free one", r);
ok(!calls.some(c => c.url.includes("openrouter.ai/api/v1/chat") && !/:free$/.test(c.body.model)), "never a paid model", calls.filter(c => c.url.includes("openrouter.ai/api/v1/chat")).map(c => c.body.model));

console.log("Groq (and marking with images)");
r = await AI.run({}, only("groq"), "x", [{ role: "user", text: "mark", images: [{ mime: "image/jpeg", data: "AAAA" }] }], { json: true, maxTokens: 2000, deadline: Date.now() + 60000, test: true, check: t => AI.checkMarking(AI.pullJSON(t), { paperId: "p1" }) });
ok(r.result && r.result.parts && r.result.paperId === "p1", "JSON mode is dropped when the model can't combine it with images, and the reply still parses", r);

console.log("Everything down");
const none = { ...only("gemini"), gemini: { key: "k", models: "gemini-3.1-pro-preview" } };
try { await ask(none); ok(false, "should have failed"); } catch (e) { ok(e.tried && e.tried.length >= 1 && /429/.test(JSON.stringify(e.tried)), "when nothing works: a clear list of what each model said", e.tried); }
ok(!AI.PROVIDERS.some(p => p.id === "mistral"), "Mistral is gone", AI.PROVIDERS.map(p => p.id));
console.log(fails ? `\n${fails} check(s) failed` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
