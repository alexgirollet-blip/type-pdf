// tests/replace.test.js — Replace page: swap one page of a paper for a page of another PDF.
//   serve the app:  cd public && python3 -m http.server 8799      then:  node tests/replace.test.js
const { chromium } = require("playwright");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const URL_ = process.env.TYPEPDF_URL || "http://localhost:8799/";
let fails = 0;
const ok = (cond, what, extra) => { console.log((cond ? "  ok   " : "  FAIL ") + what + (extra !== undefined && !cond ? "  → " + JSON.stringify(extra).slice(0, 600) : "")); if (!cond) fails++; };

(async () => {
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1200, height: 900 } });
  const errs = []; pg.on("pageerror", e => errs.push(e.message));
  await pg.goto(URL_);
  const paper = path.join(ROOT, "docs/examples/test-paper.pdf"), cover = path.join(ROOT, "docs/examples/aqa-cover.pdf");
  await pg.setInputFiles("#file", paper);
  await pg.waitForSelector("#editor:not([hidden])"); await pg.waitForTimeout(1500);

  // something written on page 2
  const before = await pg.evaluate(() => {
    const r = doc.pages[1].regions.find(r => r.kind === "lines"); r._el.value = "F = ma"; r._el.dispatchEvent(new Event("input"));
    doc.strokes[1] = [{ id: "s1", t: "pen", c: "#111418", w: 1.3, pts: [[200, 300], [260, 340]] }];
    return { n: doc.pages.length, hash: doc.pdf, regions: doc.pages[1].regions.length, page3: doc.pages[2].regions.length };
  });

  console.log("Keep: page 2 swapped for an identical copy of itself (a 'clearer scan')");
  await pg.click("#boxesBtn").catch(() => pg.evaluate(() => setTool("boxes")));
  await pg.evaluate(() => { const h = $("#pages"); h.scrollTop = views[1].el.offsetTop; }); await pg.waitForTimeout(300);
  await pg.evaluate(() => $("#replaceBtn").click());
  ok(await pg.evaluate(() => $("#replDlg").open && +$("#replAt").value === currentPage() + 1), "the dialog opens on the page you're on");
  await pg.evaluate(() => { $("#replAt").value = 2; });
  await pg.setInputFiles("#replFile", paper); await pg.waitForTimeout(800);
  ok(await pg.evaluate(() => !$("#replPick").hidden && !$("#replPrev").hidden && $("#replOf").textContent === "of 5"), "a several-page PDF asks which page, with a preview");
  await pg.evaluate(() => { $("#replK").value = 2; $("#replK").dispatchEvent(new Event("change")); $("#replKeep").checked = true; });
  await pg.waitForTimeout(300);
  await pg.evaluate(() => $("#replGo").click());
  await pg.waitForFunction(() => $("#busy").hidden, null, { timeout: 30000 }); await pg.waitForTimeout(500);
  let s = await pg.evaluate(() => ({ n: doc.pages.length, hash: doc.pdf, pdfPages: pdf.numPages, texts: doc.pages[1].regions.map(r => doc.text[r.id]).filter(Boolean), strokes: (doc.strokes[1] || []).length, regions: doc.pages[1].regions.length }));
  ok(s.n === before.n && s.pdfPages === before.n, "same number of pages", s);
  ok(s.hash !== before.hash, "the paper's PDF changed (new id for syncing)", s);
  ok(s.texts.includes("F = ma"), "the typed answer moved to the new page's matching space", s.texts);
  ok(s.strokes === 1, "drawings kept", s);
  ok(s.regions === before.regions, "the same answer spaces were found again", s);

  console.log("Clear: page 3 swapped for a page from another PDF");
  await pg.evaluate(() => $("#replaceBtn").click());
  await pg.evaluate(() => { $("#replAt").value = 3; $("#replKeep").checked = false; });
  await pg.setInputFiles("#replFile", cover); await pg.waitForTimeout(800);
  ok(await pg.evaluate(() => +$("#replK").value === 2), "the other PDF's page defaults to the same page number (a corrected copy of the same paper)");
  await pg.evaluate(() => { $("#replK").value = 1; $("#replK").dispatchEvent(new Event("change")); }); await pg.waitForTimeout(300);
  await pg.evaluate(() => $("#replGo").click());
  await pg.waitForFunction(() => $("#busy").hidden, null, { timeout: 30000 }); await pg.waitForTimeout(500);
  s = await pg.evaluate(() => ({ text: (doc.pages[2].items || []).map(i => i.s).join(" ").slice(0, 300), p2: doc.pages[1].regions.map(r => doc.text[r.id]).filter(Boolean), strokes: (doc.strokes[2] || []).length }));
  ok(/examiner|candidate|aqa/i.test(s.text), "page 3 now shows the other PDF's page", s.text);
  ok(s.p2.includes("F = ma"), "other pages untouched", s.p2);
  // export: the replaced pages are in the exported PDF
  const ex = await pg.evaluate(async () => { const out = await exportPDF(false, { bytes: true }); const d = await pdfjsLib.getDocument({ data: out }).promise; const t = (await (await d.getPage(3)).getTextContent()).items.map(i => i.str).join(" "); return { n: d.numPages, t: t.slice(0, 200) }; });
  ok(ex.n === before.n && /examiner|candidate|aqa/i.test(ex.t), "the exported PDF has the new page", ex);
  ok(!errs.length, "no errors", errs);
  await b.close();
  console.log(fails ? `\n${fails} check(s) failed` : "\nAll checks passed");
  process.exit(fails ? 1 : 0);
})();
