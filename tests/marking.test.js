// tests/marking.test.js — marking import, end to end in a real browser.
//
//   1. serve the app:  cd public && python3 -m http.server 8799
//   2. run:            node tests/marking.test.js            (uses the pre-installed Playwright + Chromium)
//
// Opens docs/examples/test-paper.pdf, types answers, draws on Figure 1, picks C, exports for AI, then imports
// docs/examples/"test-paper - marking.json" (which uses every anchor kind and every mark type) and checks that each
// mark is drawn where it should be, that unknown ids and unfound text are reported, that the excluded part is grey
// and out of the total, that the summary and the score land on the cover, and that the marked PDF exports.
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const URL_ = process.env.TYPEPDF_URL || "http://localhost:8799/";
let fails = 0;
const ok = (cond, what, extra) => { console.log((cond ? "  ok   " : "  FAIL ") + what + (extra !== undefined && !cond ? "  → " + JSON.stringify(extra) : "")); if (!cond) fails++; };

(async () => {
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
  const errs = []; pg.on("pageerror", e => errs.push(e.message));
  await pg.goto(URL_);
  await pg.setInputFiles("#file", path.join(ROOT, "docs/examples/test-paper.pdf"));
  await pg.waitForSelector("#editor:not([hidden])"); await pg.waitForTimeout(2500);

  // answer it
  await pg.evaluate(() => {
    const L = (p, k) => doc.pages[p].regions.filter(r => r.kind === "lines")[k];
    const set = (r, t) => { r._el.value = t; r._el.dispatchEvent(new Event("input")); };
    set(L(1, 0), "Force is equal to mass times acceleration, F = ma");
    set(L(1, 1), "F = 2.0 x 3.0 = 6 N");
    set(L(2, 0), "The skydiver speeds up until air resistance equals weight.");
    toggleChoice(2, doc.pages[2].regions.find(r => r.kind === "choice" && r.L === "B"));          // the wrong one
    doc.strokes[1] = [{ id: "s1", t: "pen", c: "#111418", w: 1.3, pts: [[230, 360], [300, 420], [370, 450], [420, 520]] }]; layoutPage(1);
    // page 4: the truth table (one wrong) and a circuit drawn by hand (an AND gate, not the NAND asked for)
    doc.pages[3].regions.filter(r => r.kind === "cell").forEach((r, k) => set(r, ["0", "0", "1", "1"][k]));
    doc.strokes[3] = [[[180, 400], [240, 400]], [[180, 440], [240, 440]], [[240, 380], [240, 460], [300, 420], [240, 380]], [[300, 420], [360, 420]]].map((pts, k) => ({ id: "g" + k, t: "pen", c: "#111418", w: 1.3, pts }));
    layoutPage(3);
  });
  await pg.waitForTimeout(400);

  // export for AI: ids, paperId, crop rectangle
  const ex = await pg.evaluate(async () => { await aiPrep(); const o = rememberExport(aiJSON(false)); return JSON.parse(JSON.stringify(o)); });
  console.log("Export for AI");
  ok(ex.paperId && ex.exported, "has paperId and exported");
  const ids = ex.answers.map(a => a.id);
  ok(new Set(ids).size === ids.length, "ids are unique", ids);
  ok(["1a", "1b", "2-drawn", "3", "4", "5-gap1", "5-gap2", "5-gap3", "5-gap4", "6"].every(i => ids.includes(i)), "ids are the expected ones", ids);
  const drawn = ex.answers.find(a => a.id === "2-drawn");
  ok(drawn && drawn.workings && drawn.workings.crops[0].page === 2 && drawn.workings.crops[0].y1 > drawn.workings.crops[0].y0, "handwritten part records its crop rectangle", drawn && drawn.workings);

  // import the example marking (pasted, as on an iPad)
  const marking = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/examples/test-paper - marking.json"), "utf8"));
  marking.paperId = ex.paperId;                       // it's for this paper (the example's id is the same PDF's, but be sure)
  await pg.click("#marksBtn"); await pg.click('#marksHead [data-a="import"]');
  await pg.fill("#markPaste", JSON.stringify(marking)); await pg.click("#markGo");
  await pg.waitForTimeout(800);
  console.log("Import");
  const st = await pg.evaluate(() => ({ warn: Marking.layout().warn, svg: [...document.querySelectorAll("svg.marks")].map(s => +s.dataset.p) }));
  ok(st.warn.some(w => /9z/.test(w)), "unknown id is reported", st.warn);
  ok(st.warn.some(w => /not in the answer/.test(w)), "text that isn't there is reported (and placed beside the part)", st.warn);
  ok(st.warn.some(w => /export made/.test(w)), "an older export is warned about", st.warn);
  ok(st.svg.join() === "0,1,2,3", "a marks layer on every page", st.svg);

  // where each mark is
  const g = await pg.evaluate(() => {
    const L = Marking.layout(), out = {};
    L.pages.forEach((shapes, p) => shapes.forEach(s => { (out[s.g] ||= { p, shapes: [] }).shapes.push(s); }));
    const rect = (p, k) => { const r = doc.pages[p].regions.filter(r => r.kind === "lines")[k]; return regionRect(p, r); };
    return { out, a1: rect(1, 0), b1: rect(1, 1), q4: rect(2, 0), fig: doc.pages[1].regions.find(r => r.kind === "box"), choice: regionRect(2, doc.pages[2].regions.find(r => r.L === "C")), w: doc.pages[0].w, H2: doc.pages[2].h };
  });
  const S = k => (g.out[k] || { shapes: [] }).shapes, P = k => (g.out[k] || {}).p;
  const parts = marking.parts.map(p => p.id);
  const pi = id => parts.indexOf(id);
  console.log("Anchors");
  const ul = S(`a:${pi("1a")}:0`)[0];
  ok(P(`a:${pi("1a")}:0`) === 1 && ul && ul.k === "path" && /^M/.test(ul.d), "underline (text anchor) drawn on page 2", ul);
  const ulY = ul && +ul.d.split(" ")[1];
  ok(ul && ulY > g.a1.y0 && ulY < g.a1.y1, "underline sits on the answer's first line", { ulY, a1: g.a1 });
  const tk = S(`a:${pi("1a")}:1`)[0];
  ok(tk && tk.stroke === "#17853b", "tick is green", tk);
  const cr = S(`a:${pi("1b")}:0`)[0];
  ok(cr && cr.k === "ell" && cr.cy > g.b1.y0 && cr.cy < g.b1.y1, "circle (text anchor) round '2.0 x 3.0'", { cr, b1: g.b1 });
  const caret = S(`a:${pi("1a")}:2`)[0];
  ok(caret && caret.k === "path", "caret drawn", caret);
  const wk = S(`a:${pi("2-drawn")}:0`)[0];
  ok(P(`a:${pi("2-drawn")}:0`) === 1 && wk && wk.stroke === "#cc1f1a", "cross (workings anchor) on page 2 in red", wk);
  const wy = wk && +wk.d.split(" ")[1];
  const crop = drawn.workings.crops[0], want = crop.y0 + 0.55 * (crop.y1 - crop.y0);
  ok(Math.abs(wy + 4.7 - want) < 3, "workings mark is at its spot on the drawing (55% down the crop)", { wy, want });
  const br = S(`a:${pi("2-drawn")}:1`)[0];
  ok(br && br.k === "path", "bracket (workings anchor)", br);
  console.log("Multiple choice: the right answer and the working");
  const optB = await pg.evaluate(() => regionRect(2, doc.pages[2].regions.find(r => r.L === "B"))), optC = await pg.evaluate(() => regionRect(2, doc.pages[2].regions.find(r => r.L === "C")));
  const xB = S(`o:${pi("3")}:B`)[0];
  ok(P(`o:${pi("3")}:B`) === 2 && xB && xB.stroke === "#cc1f1a" && Math.abs(+xB.d.split(" ")[1] + 4.7 - (optB.y0 + optB.y1) / 2) < 3, "your wrong choice (B) is crossed in red", xB);
  const rC = S(`o:${pi("3")}:C`);
  ok(rC.some(s => s.k === "ell" && s.stroke === "#17853b" && Math.abs(s.cy - (optC.y0 + optC.y1) / 2) < 1) && rC.some(s => s.k === "path" && s.stroke === "#17853b"), "the right one (C) is circled and ticked in green", rC);
  const wk3 = S(`w:${pi("3")}`);
  ok(wk3.some(s => s.k === "text" && /size and direction/.test(s.s)) && wk3.some(s => s.k === "rect"), "the working is written out", wk3.filter(s => s.k === "text").map(s => s.s));
  const q4top = await pg.evaluate(() => { const e = labelIndex().find(e => e.label === "4"); return disp(2, e.y); });
  const wbox = wk3.find(s => s.k === "rect");
  ok(wbox && wbox.y + wbox.h < q4top, "and stays with question 3 (not under question 4)", { wbox, q4top });
  const pgNoteAt = S(`a:${pi("4")}:3`);
  ok(P(`a:${pi("4")}:3`) === 2 && pgNoteAt.some(s => s.k === "text" && /Nice clear/.test(s.s) && Math.abs(s.y - 0.85 * g.H2) < 3), "note (page anchor) written at its spot on page 3", pgNoteAt);
  const fb = S(`a:${pi("4")}:2`)[0];
  ok(fb && fb.k === "path", "unfound text falls back to the part", fb);
  console.log("Tables, gaps and drawings (logic gates)");
  const gap = await pg.evaluate(() => doc.pages[3].regions.filter(r => r.kind === "cell").map(r => regionRect(3, r)));
  const t1 = S(`a:${pi("5-gap1")}:0`)[0];
  ok(P(`a:${pi("5-gap1")}:0`) === 3 && t1 && t1.stroke === "#17853b" && +t1.d.slice(1).split(" ")[0] > gap[0].x1, "a gap's tick goes just after it, not over the answer", { t1, cell: gap[0] });
  const x3 = S(`a:${pi("5-gap3")}:0`);
  ok(x3.some(s => s.k === "path" && s.stroke === "#cc1f1a") && x3.some(s => s.k === "text" && s.s === "0"), "the wrong gap is crossed, with the right value beside it", x3);
  ok(S("t:5").some(s => s.k === "text" && /Q5: 1\/2/.test(s.s)), "question 5's total from the marker's own figures", S("t:5"));
  const ring6 = S(`a:${pi("6")}:0`)[0];
  ok(P(`a:${pi("6")}:0`) === 3 && ring6 && ring6.k === "ell" && Math.abs(ring6.cx - 270) < 25 && Math.abs(ring6.cy - 420) < 25, "the drawn gate is circled (workings anchor)", ring6);
  const arr = S(`a:${pi("6")}:1`);
  ok(arr.some(s => s.k === "path" && (s.d.match(/M/g) || []).length >= 2) && arr.some(s => s.k === "text" && /NOT here/.test(s.s)), "an arrow points at it, with its label", arr);
  const gate = S(`a:${pi("6")}:2`);
  ok(gate.some(s => s.k === "path" && /Q/.test(s.d)) && gate.some(s => s.k === "ell"), "a NAND gate symbol is drawn (body and output circle)", gate.map(s => s.k));
  const sk = S(`a:${pi("6")}:3`)[0];
  ok(sk && sk.k === "path" && sk.stroke === "#cc1f1a", "a sketch is drawn in its box", sk);
  const wk6 = S(`w:${pi("6")}`), box6 = await pg.evaluate(() => regionRect(3, doc.pages[3].regions.find(r => r.kind === "box")));
  ok(wk6.some(s => s.k === "rect" && s.y > box6.y1 - 1) && wk6.some(s => s.k === "text" && /NAND/.test(s.s)), "the circuit's working is in the space under the drawing", { wk6: wk6.map(s => s.k + ":" + Math.round(s.y)), box6 });
  // a table answer (several columns): marks on a cell by its number
  const cellChk = await pg.evaluate(() => {
    const cells = doc.pages[3].regions.filter(r => r.kind === "cell");
    doc.marking.map["5-table"] = { q: "5", type: "table", r: cells.map(r => r.id) };
    doc.marking.parts.push({ id: "5-table", q: "5", awarded: null, max: null, verdict: "partial", comment: "", correction: "", correctOptions: [], working: [], annotations: [{ type: "cross", anchor: { kind: "cell", index: 2 }, text: "" }, { type: "tick", anchor: { kind: "option", letter: "Z" }, text: "" }] });
    const L = Marking.layout(), i = doc.marking.parts.length - 1, sh = L.pages[3].filter(s => s.g === `a:${i}:0`)[0], R = regionRect(3, cells[2]);
    const warned = L.warn.some(w => /no option Z/.test(w));
    doc.marking.parts.pop(); delete doc.marking.map["5-table"]; Marking.refresh();
    return { y: sh && +sh.d.split(" ")[1] + 4.7, x: sh && +sh.d.slice(1).split(" ")[0], R, warned };
  });
  ok(cellChk.y > cellChk.R.y0 && cellChk.y < cellChk.R.y1 && cellChk.x > cellChk.R.x1, "a table cell anchor marks that cell", cellChk);
  ok(cellChk.warned, "a missing option letter is reported", cellChk);
  console.log("Margin, totals, summary");
  const sc = S(`s:${pi("1a")}`);
  ok(sc.some(s => s.k === "ell") && sc.some(s => s.k === "text" && s.s === "1/2"), "score circle 1/2 beside 1(a)", sc);
  ok(sc.find(s => s.k === "ell").cx > g.w - 30, "score circle is in the right margin", sc[0]);
  const ex2 = S(`s:${pi("2")}`);
  ok(ex2.some(s => s.stroke === "#8c9290"), "excluded part is grey", ex2);
  ok(S("t:1").some(s => s.k === "text" && /Q1: 3\/4/.test(s.s)), "question 1 total in a bracket", S("t:1"));
  const cm = S(`c:${pi("1a")}`);
  ok(cm.some(s => s.k === "text" && s.font === "hand") && cm.some(s => s.k === "text" && /^Answer:/.test(s.s)), "comment in hand lettering with the correction under it", cm);
  const notes = Object.entries(g.out).filter(([k, v]) => v.p === 1 && (k.startsWith("c:") || k.endsWith(":n"))).map(([, v]) => v.shapes.find(s => s.k === "rect")).filter(Boolean);
  const overlap = notes.some((a, i) => notes.some((c, j) => j > i && a.y < c.y + c.h && c.y < a.y + a.h));
  ok(!overlap, "margin notes on a page don't overlap", notes);
  ok(S("sum").some(s => s.k === "text" && s.s === "7/14") && P("sum") === 0, "summary box on the cover with 7/14", S("sum").filter(s => s.k === "text").map(s => s.s));
  ok(S("sum").some(s => s.k === "text" && s.s === "C"), "grade in the summary", null);
  ok(S("spot").some(s => s.k === "text" && s.s === "7"), "score written in the cover's Total Marks box", S("spot"));
  const allShapes = Object.values(g.out).flatMap(v => v.shapes);
  ok(!allShapes.some(s => /^#(1c5fd9|0000ff|2563eb)/i.test(s.stroke || s.fill || "")), "no blue anywhere in the marking", null);
  const rows3 = await pg.$$eval("#marksList .mkrow", r => r.map(x => x.textContent).find(t => /Answer: C/.test(t)));
  ok(!!rows3, "the Marks panel shows the right option", rows3);

  console.log("Panel, toggle, edit, undo, export");
  const rows = await pg.$$eval("#marksList .mkrow", r => r.map(x => x.textContent));
  ok(rows.length === marking.parts.length, "Marks panel lists every part", rows);
  await pg.evaluate(() => { $("#pages").scrollTop = 0; }); await pg.waitForTimeout(300);
  await pg.click("#marksList .mkrow:nth-child(6)"); await pg.waitForTimeout(1500);   // question 4
  const jumped = await pg.evaluate(() => { const r = doc.pages[2].regions.find(r => r.kind === "lines")._el.getBoundingClientRect(), h = $("#pages").getBoundingClientRect(); return { top: r.top - h.top, height: h.height }; });
  ok(jumped.top > 0 && jumped.top < jumped.height, "tapping a row jumps to that part (question 4 on screen)", jumped);
  await pg.evaluate(() => { const c = document.querySelector('#marksHead [data-a="on"]'); c.checked = false; c.dispatchEvent(new Event("change", { bubbles: true })); });
  ok(await pg.evaluate(() => document.querySelectorAll("svg.marks").length) === 0, "marks can be hidden", null);
  await pg.evaluate(() => { const c = document.querySelector('#marksHead [data-a="on"]'); c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); });
  await pg.evaluate(() => { doc.marking.edits["a:0:1"] = { dx: 10, dy: 5 }; doc.marking.edits["a:0:0"] = { del: true }; doc.marking.extra.push({ type: "tick", p: 2, x: 300, y: 500 }); Marking.refresh(); });
  await pg.waitForTimeout(300);
  const ed = await pg.evaluate(() => ({ moved: document.querySelector('svg.marks g[data-g="a:0:1"]').getAttribute("transform"), gone: !document.querySelector('svg.marks g[data-g="a:0:0"]'), added: !!document.querySelector('svg.marks g[data-g="x:0"]'), answers: doc.text["1:0"] }));
  ok(ed.moved === "translate(10 5)" && ed.gone && ed.added, "marks move, delete, and you can add your own", ed);
  ok(ed.answers === "Force is equal to mass times acceleration, F = ma", "your answers are untouched", ed.answers);
  // importing again replaces it, and the old one can come back
  await pg.evaluate(async () => { const m = JSON.parse(JSON.stringify(doc.marking)); m.summary.score = 7; m.parts = m.parts.slice(0, 2); await Marking.importText(JSON.stringify({ ...m, format: "typepdf-marking", version: 1 })); });
  ok(await pg.evaluate(() => doc.marking.parts.length === 2 && !!doc.markingPrev), "re-import replaces the layer and keeps the last one", null);
  await pg.evaluate(() => { document.getElementById("marksPop").hidden = false; Marking.refresh(); });
  await pg.waitForTimeout(200);
  await pg.click('#marksHead [data-a="undo"]');
  ok(await pg.evaluate(() => doc.marking.parts.length) === marking.parts.length, "undo brings the previous marking back", null);
  // screenshots for a person to look at
  await pg.evaluate(() => { document.getElementById("marksPop").hidden = true; }); await pg.setViewportSize({ width: 1000, height: 1500 }); await pg.waitForTimeout(500);
  for (const p of [0, 1, 2, 3]) { await pg.evaluate(p => { $("#pages").scrollTop = pageTop(p) - 8; }, p); await pg.waitForTimeout(400); await pg.screenshot({ path: path.join(process.env.SHOTS || "/tmp", `marked-p${p + 1}.png`) }); }
  const [dl] = await Promise.all([pg.waitForEvent("download", { timeout: 30000 }), pg.evaluate(() => exportPDF(true))]);
  const out = path.join(process.env.SHOTS || "/tmp", "marked.pdf"); await dl.saveAs(out);
  ok(/marked\.pdf$/.test(dl.suggestedFilename()) && fs.statSync(out).size > 5000, "Export marked PDF", dl.suggestedFilename());
  // a #mark= link
  const link = await pg.evaluate(async m => Marking.linkFor(m), marking);
  ok(/#mark=[A-Za-z0-9_-]+$/.test(link), "a marking fits in a #mark= link", link.slice(0, 80));
  const parsed = await pg.evaluate(async l => { const s = l.split("#mark=")[1], bin = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)); return JSON.parse(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))).text()).parts.length; }, link);
  ok(parsed === marking.parts.length, "and comes back out of it", parsed);
  ok(!errs.length, "no page errors", errs);
  await b.close();
  console.log(fails ? `\n${fails} check(s) failed` : "\nAll checks passed");
  process.exit(fails ? 1 : 0);
})();
