// tests/long.test.js — a very long paper (187 pages, thousands of answer spaces) opens, scrolls, types and exports
// while only the pages near the one you're on are loaded.
//
//   1. python3 docs/examples/make-long-paper.py /tmp/long-paper.pdf
//   2. serve the app:  cd public && python3 -m http.server 8799
//   3. run:            LONG_PDF=/tmp/long-paper.pdf node tests/long.test.js
const { chromium } = require("playwright");
const URL_ = process.env.TYPEPDF_URL || "http://localhost:8799/";
const PDF = process.env.LONG_PDF || "/tmp/long-paper.pdf";
let fails = 0;
const ok = (cond, what, extra) => { console.log((cond ? "  ok   " : "  FAIL ") + what + (extra !== undefined && !cond ? "  → " + JSON.stringify(extra).slice(0, 600) : "")); if (!cond) fails++; };

(async () => {
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1100, height: 850 } });
  const errs = []; pg.on("pageerror", e => errs.push(e.message));
  await pg.goto(URL_);
  const t0 = Date.now();
  await pg.setInputFiles("#file", PDF);
  await pg.waitForSelector("#editor:not([hidden])", { timeout: 600000 });
  const tOpen = Date.now() - t0;
  await pg.waitForTimeout(1500);
  const st = () => pg.evaluate(() => ({
    pages: views.length, regions: doc.pages.reduce((s, P) => s + P.regions.length, 0),
    fields: document.querySelectorAll("#pages .page:not(.tp-measure) .ans, #pages .choice").length,
    live: views.map((v, p) => v.live ? p : -1).filter(p => p >= 0),
    inkPx: views.reduce((s, v) => s + v.ink.width * v.ink.height, 0), cur: currentPage(),
  }));
  let s = await st();
  console.log(`opened in ${(tOpen / 1000).toFixed(1)} s: ${s.pages} pages, ${s.regions} answer spaces`);
  ok(s.pages >= 150 && s.regions > 4000, "the long paper was read", s);
  ok(s.live.length <= 13 && s.live.includes(0), "only the pages near the start are loaded", s.live);
  ok(s.fields < s.regions / 8, "answer boxes exist only on loaded pages", { fields: s.fields });
  const onePage = await pg.evaluate(() => views[0].ink.width * views[0].ink.height);
  ok(s.inkPx <= onePage * 13, "drawing layers only for loaded pages", { inkPx: s.inkPx, onePage });

  // type on page 2, then go far away and come back: the answer is kept and shown
  await pg.evaluate(() => { const r = doc.pages[1].regions.find(r => r.kind === "lines"); r._el.value = "Field strength is force per unit charge"; r._el.dispatchEvent(new Event("input")); window.__r = r.id; });
  await pg.evaluate(() => { const h = $("#pages"); h.scrollTop = views[120].el.offsetTop; });
  await pg.waitForTimeout(700);
  s = await st();
  ok(s.cur >= 118 && s.cur <= 122 && s.live.includes(120) && !s.live.includes(1), "scrolled to page 121: it is loaded, page 2 isn't", s.live);
  ok(await pg.evaluate(() => doc.text[window.__r] === "Field strength is force per unit charge"), "the answer typed on page 2 is kept");
  // type on page 121 too
  await pg.evaluate(() => { const r = doc.pages[120].regions.find(r => r.kind === "cell"); r._el.value = "0.42"; r._el.dispatchEvent(new Event("input")); });
  await pg.evaluate(() => { const h = $("#pages"); h.scrollTop = 0; });
  await pg.waitForTimeout(700);
  ok(await pg.evaluate(() => { const r = findRegion(window.__r); return !!r._el && r._el.value === "Field strength is force per unit charge"; }), "back at the start: the box is there again with its answer");
  // jumping to a far answer loads its page
  ok(await pg.evaluate(() => { const r = doc.pages[150].regions[0]; const el = elFor(r); return !!el && el.isConnected && views[150].live; }), "a far answer space is loaded when it's jumped to");
  // zooming keeps working
  await pg.evaluate(() => setZoom(zoom * 1.3)); await pg.waitForTimeout(400);
  s = await st(); ok(s.fields < s.regions / 4, "after zooming, still only nearby pages loaded", s);
  // export the PDF (every page, including the unloaded ones)
  const bytes = await pg.evaluate(async () => { const out = await exportPDF(false, { bytes: true }); return out ? out.length || out.byteLength : 0; });
  ok(bytes > 100000, "exports the whole paper", bytes);
  // Find: across every page, loaded or not
  await pg.keyboard.press("Escape");
  await pg.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); $("#pages").scrollTop = 0; });
  await pg.waitForTimeout(300);
  await pg.keyboard.press("Control+f");
  ok(await pg.evaluate(() => !$("#findPop").hidden && document.activeElement === $("#findIn")), "Ctrl+F opens Find");
  await pg.keyboard.type("electric fields"); await pg.waitForTimeout(400);
  let f = await pg.evaluate(() => ({ n: Find.hits.length, pages: [...new Set(Find.hits.map(h => h.p))], count: $("#findCount").textContent, items: $$("#findList .fhit").length }));
  ok(f.n >= 40 && f.pages.some(p => p > 150), "finds the phrase on pages far from here", f);
  await pg.keyboard.press("Enter"); await pg.keyboard.press("Enter"); await pg.waitForTimeout(900);
  f = await pg.evaluate(() => ({ at: Find.at, cur: currentPage(), hp: Find.hits[Find.at].p, marks: $$(".findhit.cur").length }));
  ok(f.at === 1 && Math.abs(f.cur - f.hp) <= 1 && f.marks >= 1, "Enter goes to the next match and highlights it", f);
  await pg.evaluate(() => { $("#findIn").value = "Field strength is force"; Find.run(true); });
  f = await pg.evaluate(() => Find.hits.map(h => ({ p: h.p, typed: !!h.typed })));
  ok(f.length === 1 && f[0].typed && f[0].p === 1, "finds words in your typed answers", f);
  await pg.evaluate(() => { $("#findIn").value = "term question gravitational"; Find.run(true); });
  f = await pg.evaluate(() => ({ n: Find.hits.length, note: $("#findList .note") && $("#findList .note").textContent }));
  ok(f.n >= 40 && /all the words/.test(f.note || ""), "not word for word: finds lines with all the words", f);
  await pg.evaluate(() => $("#findIn").focus()); await pg.keyboard.press("Escape");
  ok(await pg.evaluate(() => $("#findPop").hidden && !$$(".findhit").length), "Esc closes Find and clears the highlights");
  // Ask: what goes to the AI, and page numbers in the reply are links
  await pg.evaluate(() => { $("#pages").scrollTop = views[40].el.offsetTop + 100 * zoom; });
  await pg.waitForTimeout(500);
  const sent = await pg.evaluate(async () => {
    window.__sent = null; const ud = Object.getOwnPropertyDescriptor(Sync, "user"); Object.defineProperty(Sync, "user", { get: () => ({ id: "t" }), configurable: true });
    const realApi = Sync.api; Sync.api = async (path, o) => { window.__sent = { path, body: JSON.parse(o.body) }; return new Response(JSON.stringify({ text: "The electric fields questions are on page 1 and page 5 (Q1, Q19).", provider: "Test" }), { status: 200 }); };
    $("#askBtn").click(); $("#askIn").value = "which page is the electric fields question on?"; $("#askForm").requestSubmit();
    for (let i = 0; i < 100 && !(window.__sent && $$("#askLog .pglink").length); i++) await new Promise(r => setTimeout(r, 100));
    Sync.api = realApi; Object.defineProperty(Sync, "user", ud);
    const b = window.__sent.body;
    return { path: window.__sent.path, mode: b.mode, img: (b.image || "").length, ctx: b.context, links: $$("#askLog .pglink").map(x => x.dataset.p), msgs: b.messages.length };
  });
  ok(sent.path === "/api/ai/chat" && sent.mode === "help" && sent.msgs === 1, "asks the free AIs in help mode", sent.path);
  ok(/WHERE THE STUDENT IS NOW: page 41, Q\d+/.test(sent.ctx), "says where you are (page and question)", sent.ctx.slice(0, 200));
  ok(/This question is about/.test(sent.ctx.split("THE WHOLE PAPER")[0]), "includes the printed question you're on", sent.ctx.slice(0, 600));
  ok(/Q37 \(page 10\): (37 )?This question is about electric fields/.test(sent.ctx), "the whole paper's index: each question's page and opening words", sent.ctx.match(/THE WHOLE PAPER[\s\S]{0,300}/)[0]);
  ok(/WHERE THE WORDS[\s\S]*page \d+: Q\d+: (\d+ )?This question is about electric fields/.test(sent.ctx), "the pages with the words asked about", (sent.ctx.match(/WHERE THE WORDS[\s\S]{0,300}/) || [""])[0]);
  ok(sent.img > 5000, "a picture of the question goes too", sent.img);
  ok(sent.ctx.length < 60000, "the context stays a sensible size for free models", sent.ctx.length);
  ok(sent.links.join() === "1,5", "page numbers in the reply are links", sent.links);
  await pg.evaluate(() => $$("#askLog .pglink")[1].click()); await pg.waitForTimeout(1200);
  ok(await pg.evaluate(() => currentPage() === 4), "tapping one goes to that page");
  ok(!errs.length, "no errors", errs);
  await b.close();
  console.log(fails ? `\n${fails} check(s) failed` : "\nAll checks passed");
  process.exit(fails ? 1 : 0);
})();
