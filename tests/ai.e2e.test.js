// tests/ai.e2e.test.js — Mark with AI, the chat, the Claude connector and drop links, end to end against the real
// Worker running locally (wrangler dev) and a fake AI provider (no real keys or quota used).
//
//   npm install
//   node tests/ai.e2e.test.js            (starts wrangler dev on :8787 and a fake AI on :8788, then a browser)
const { chromium } = require("playwright");
const http = require("http"), crypto = require("crypto"), path = require("path"), fs = require("fs"), { spawn } = require("child_process");
const ROOT = path.resolve(__dirname, ".."), BASE = "http://127.0.0.1:8787", SECRET = "test-hub-secret";
let fails = 0;
const ok = (c, what, extra) => { console.log((c ? "  ok   " : "  FAIL ") + what + (!c && extra !== undefined ? "  → " + JSON.stringify(extra).slice(0, 600) : "")); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- a fake OpenAI-compatible AI: "fail-1" is always at its limit; "mock-1" marks every answer it's given ----
const seen = [];
const fake = http.createServer((req, res) => {
  let body = ""; req.on("data", d => body += d); req.on("end", () => {
    const b = JSON.parse(body || "{}"); seen.push({ model: b.model, images: JSON.stringify(b.messages).split("image_url").length - 1 });
    if (b.model === "fail-1") { res.writeHead(429, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "Rate limit reached" } })); }
    const user = b.messages.filter(m => m.role === "user").pop(), txt = typeof user.content === "string" ? user.content : user.content.map(c => c.text || "").join("");
    let content;
    if (/Say OK/.test(txt)) content = "OK";
    else if (/answers\.json/.test(txt)) {
      const ans = JSON.parse(txt.split("## answers.json\n")[1].split("\n\n## The images")[0].split("\n\n(No handwriting")[0]);
      content = "Here you go:\n```json\n" + JSON.stringify({ summary: { score: 3, outOf: 5, grade: "B", comment: "Mock marking." }, parts: ans.answers.map(a => ({ id: a.id, q: a.q, awarded: 1, max: 1, verdict: "correct", annotations: [{ type: "tick", anchor: { kind: "part" } }] })) }) + "\n```";
    } else content = "Mock tutor: you lost the mark because you didn't say 'resultant'.";
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
  });
});

const b64u = b => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function hubPass(email, admin) {
  const body = b64u(JSON.stringify({ email, name: "Tester", admin, exp: Date.now() + 60000, n: crypto.randomBytes(8).toString("hex") }));
  return body + "." + b64u(crypto.createHmac("sha256", SECRET).update(body).digest());
}
const mcp = async (url, method, params, id = 1) => (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })).json());

(async () => {
  await new Promise(r => fake.listen(8788, "127.0.0.1", r));
  // the Worker, without the Workers AI binding (that needs a Cloudflare login)
  const conf = fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8").replace(/\[ai\][^\[]*/, "");
  const confPath = path.join(ROOT, ".wrangler-test.toml"); fs.writeFileSync(confPath, conf);
  const persist = fs.mkdtempSync(path.join(require("os").tmpdir(), "typepdf-test-"));
  const wr = spawn(path.join(ROOT, "node_modules/.bin/wrangler"), ["dev", "-c", confPath, "--port", "8787", "--ip", "127.0.0.1", "--persist-to", persist, "--var", "HUB_URL:http://127.0.0.1:9", "--var", "HUB_SSO_SECRET:" + SECRET, "--show-interactive-dev-session=false"], { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  let log = ""; wr.stdout.on("data", d => log += d); wr.stderr.on("data", d => log += d);
  for (let i = 0; i < 120 && !/Ready on/.test(log); i++) await sleep(500);
  if (!/Ready on/.test(log)) { console.log(log); throw new Error("wrangler didn't start"); }
  const b = await chromium.launch();
  try {
    // sign in (as the admin) through a hub pass
    const r = await fetch(BASE + "/api/auth/hub-callback?hubpass=" + hubPass("tester@example.com", true), { redirect: "manual" });
    const token = (r.headers.get("location") || "").split("#signin=")[1];
    ok(!!token, "signed in through the hub", r.headers.get("location"));
    const authed = (p, o = {}) => fetch(BASE + p, { ...o, headers: { ...(o.headers || {}), authorization: "Bearer " + token, "content-type": "application/json" } }).then(r => r.json());

    console.log("AI settings");
    let st = await authed("/api/ai/providers");
    ok(st.ready === false && st.providers.length >= 7, "no AI set up at first; every provider listed", st);
    st = await authed("/api/ai/providers", { method: "POST", body: JSON.stringify({ id: "custom", key: "test-key", url: "http://127.0.0.1:8788/v1/chat/completions", models: "fail-1, mock-1", on: true }) });
    const cu = st.providers.find(p => p.id === "custom");
    ok(cu.set && cu.on && !("key" in cu), "a key is saved (and never sent back)", cu);
    const t = await authed("/api/ai/test", { method: "POST", body: JSON.stringify({ id: "custom" }) });
    ok(t.ok && t.model === "mock-1" && t.tried.some(x => /fail-1/.test(x.k)), "Test: the first model's at its limit, so the next one answers", t);

    console.log("Mark with AI");
    const pg = await b.newPage({ viewport: { width: 1200, height: 900 } });
    const errs = []; pg.on("pageerror", e => errs.push(e.message));
    await pg.goto(BASE + "/#signin=" + token); await pg.waitForTimeout(1500);
    await pg.setInputFiles("#file", path.join(ROOT, "docs/examples/test-paper.pdf"));
    await pg.waitForSelector("#editor:not([hidden])"); await pg.waitForTimeout(3000);
    await pg.evaluate(() => {
      const L = (p, k) => doc.pages[p].regions.filter(r => r.kind === "lines")[k];
      const set = (r, t) => { r._el.value = t; r._el.dispatchEvent(new Event("input")); };
      set(L(1, 0), "Force is equal to mass times acceleration, F = ma"); set(L(1, 1), "F = 2.0 x 3.0 = 6 N");
      doc.strokes[1] = [{ id: "s1", t: "pen", c: "#111418", w: 1.3, pts: [[230, 360], [300, 420], [370, 450], [420, 520]] }]; layoutPage(1); emit("s:1:s1");
    });
    await pg.waitForTimeout(2500);                                           // let it sync to the account
    await pg.evaluate(() => AIMark.markWithAI());
    await pg.waitForFunction(() => doc.marking, null, { timeout: 60000 }).catch(() => {});
    const m1 = await pg.evaluate(() => doc.marking && { marker: doc.marking.marker, parts: doc.marking.parts.length, score: doc.marking.summary.score });
    ok(m1 && /AI \(Any other/.test(m1.marker) && m1.parts >= 3 && m1.score === 3, "Mark with AI: marked by the provider that answered, on the paper", m1);
    ok(seen.some(s => s.model === "mock-1" && s.images >= 1), "the handwriting went to the AI as an image", seen);

    console.log("Chat");
    await pg.fill("#mkChatIn", "why did I lose a mark on 1(a)?"); await pg.press("#mkChatIn", "Enter");
    await pg.waitForFunction(() => /Mock tutor/.test(document.querySelector("#mkChatLog").textContent), null, { timeout: 30000 }).catch(() => {});
    ok(/Mock tutor/.test(await pg.textContent("#mkChatLog")), "the chat answers about the marks", await pg.textContent("#mkChatLog"));

    console.log("Claude connector");
    const prep = await pg.evaluate(async () => { const r = await AIMark.uploadPack(); return r; });
    ok(/\/api\/drop\/[a-f0-9]{40}$/.test(prep.drop || ""), "preparing the paper gives a drop link", prep);
    const conn = (await authed("/api/connector")).url.replace(/^https?:\/\/[^/]+/, BASE);
    ok(/\/mcp\/[a-f0-9]{40}$/.test(conn), "a connector link", conn);
    const init = await mcp(conn, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    ok(init.result && init.result.serverInfo.name === "TypePDF" && init.result.capabilities.tools, "MCP initialize", init);
    const tl = await mcp(conn, "tools/list", {});
    ok(["list_papers", "get_paper_for_marking", "get_page", "get_marking", "submit_marking", "add_paper", "get_paper_pdf"].every(n => tl.result.tools.some(x => x.name === n)), "the seven tools are listed", tl.result && tl.result.tools.map(x => x.name));
    const lp = await mcp(conn, "tools/call", { name: "list_papers", arguments: {} });
    ok(/test-paper.*ready to mark/.test(lp.result.content[0].text), "list_papers shows the paper, ready to mark", lp.result.content[0].text);
    const gp = await mcp(conn, "tools/call", { name: "get_paper_for_marking", arguments: {} });
    const gpText = gp.result.content[0].text, imgs = gp.result.content.filter(c => c.type === "image");
    ok(/submit_marking/.test(gpText) && /answers\.json/.test(gpText) && imgs.length >= 1, "get_paper_for_marking: instructions, answers and handwriting images", { text: gpText.slice(0, 200), imgs: imgs.length });
    const page = await mcp(conn, "tools/call", { name: "get_page", arguments: { page: 2 } });
    ok(page.result.content.some(c => c.type === "image" && c.data.length > 1000), "get_page returns a picture of the page", page.result.content.map(c => c.type));
    const ans = JSON.parse(gpText.split("## answers.json\n")[1].split("\n\nThe paper has")[0]);
    const marking = { summary: { score: 2, outOf: 4, grade: "C", comment: "Marked by Claude through the connector." }, parts: ans.answers.map(a => ({ id: a.id, q: a.q, awarded: 0, max: 1, verdict: "wrong", comment: "Try again.", annotations: [{ type: "cross", anchor: { kind: "part" } }] })) };
    const sub = await mcp(conn, "tools/call", { name: "submit_marking", arguments: { marking } });
    ok(/Sent to TypePDF: 2\/4/.test(sub.result.content[0].text), "submit_marking accepts it", sub.result);
    await pg.waitForFunction(() => doc.marking && /Claude/.test(doc.marking.marker || "") && doc.marking.summary.score === 2, null, { timeout: 20000 }).catch(() => {});
    await pg.waitForTimeout(500);
    const m2 = await pg.evaluate(() => ({ marker: doc.marking.marker, score: doc.marking.summary.score, inbox: Object.keys(doc.inbox || {}).length }));
    ok(m2.score === 2 && /Claude/.test(m2.marker) && !m2.inbox, "the marks appear on the open paper straight away (and the inbox empties)", m2);
    await pg.waitForTimeout(2500);                                           // the marking syncs back to the account
    const gm = await mcp(conn, "tools/call", { name: "get_marking", arguments: {} });
    ok(/Marked by Claude through the connector/.test(gm.result.content[0].text), "get_marking returns the marking on the paper", gm.result.content[0].text.slice(0, 120));
    const bad = await mcp(conn.replace(/[a-f0-9]{40}$/, "0".repeat(40)), "tools/list", {});
    ok(bad.error && /reset/.test(bad.error.message), "a wrong connector link is refused", bad);

    console.log("Drop link");
    const dropUrl = prep.drop.replace(/^https?:\/\/[^/]+/, BASE);
    // two in quick succession: the second must not be lost while the first is being cleared
    await fetch(dropUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ marker: "Gemini", summary: { score: 1, outOf: 4 }, parts: ans.answers.map(a => ({ id: a.id, awarded: 0, max: 1, verdict: "wrong" })) }) });
    await sleep(150);
    const dr = await (await fetch(dropUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "```json\n" + JSON.stringify({ marker: "ChatGPT", summary: { score: 4, outOf: 4 }, parts: ans.answers.map(a => ({ id: a.id, awarded: 1, max: 1, verdict: "correct" })) }) + "\n```" })).json();
    ok(dr.ok, "an AI POSTs the marking to the drop link", dr);
    await pg.waitForFunction(() => doc.marking && doc.marking.summary.score === 4, null, { timeout: 20000 }).catch(() => {});
    ok(await pg.evaluate(() => doc.marking.summary.score === 4 && /ChatGPT/.test(doc.marking.marker)), "and it appears on the paper", await pg.evaluate(() => ({ marker: doc.marking.marker, inbox: doc.markingInbox, dirty: Object.keys(doc.dirty || {}), toast: document.querySelector("#toast").textContent })));
    const junk = await fetch(dropUrl, { method: "POST", body: "not json" });
    ok(junk.status === 400, "junk sent to a drop link is refused", junk.status);

    console.log("Limits");
    const notAdmin = (await fetch(BASE + "/api/auth/hub-callback?hubpass=" + hubPass("student@example.com", false), { redirect: "manual" })).headers.get("location").split("#signin=")[1];
    const st2 = await (await fetch(BASE + "/api/ai/providers", { headers: { authorization: "Bearer " + notAdmin } })).json();
    ok(st2.ready === true && !st2.providers, "other accounts only see that AI is ready (not the settings)", st2);
    const set2 = await fetch(BASE + "/api/ai/providers", { method: "POST", headers: { authorization: "Bearer " + notAdmin }, body: JSON.stringify({ id: "custom", key: "x" }) });
    ok(set2.status === 403, "only the admin can change the AI settings", set2.status);
    ok(!errs.length, "no page errors", errs);
  } finally {
    await b.close(); wr.kill("SIGINT"); fake.close(); try { fs.unlinkSync(confPath); } catch (e) {}
  }
  console.log(fails ? `\n${fails} check(s) failed` : "\nAll checks passed");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
