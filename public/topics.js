// topics.js — topic practice from your own Save My Exams library (kept on your server, see src/sme.js):
// pick topics by module, choose question types (Structured / MCQ / Exam questions) and difficulty (Easy / Medium /
// Hard: only those sections' pages are kept), and TypePDF builds one practice paper and adds it to your papers.
// A link like  #topics=2-1,4-3&types=MCQ&diff=Hard  opens the picker with that already chosen.
"use strict";
(() => {
  const T = { idx: null, sel: new Set(), types: new Set(), diffs: new Set(), q: "", loading: false };
  const DIFFS = ["Easy", "Medium", "Hard"];
  const el = id => document.getElementById(id);
  const note = (t, err) => { const n = el("tpNote"); n.textContent = t || ""; n.classList.toggle("err", !!err); };
  try { const s = JSON.parse(localStorage.getItem("tpPrefs") || "{}"); T.sel = new Set(s.sel || []); T.types = new Set(s.types || []); T.diffs = new Set(s.diffs || []); } catch (e) {}
  const save = () => { try { localStorage.setItem("tpPrefs", JSON.stringify({ sel: [...T.sel], types: [...T.types], diffs: [...T.diffs] })); } catch (e) {} };
  const allowed = () => !!(window.Sync && Sync.user);                  // anyone signed in
  // suggested time: about 1.2 minutes a mark (an A-level paper's pace), rounded to 5 minutes
  const minsFor = marks => Math.max(5, Math.round(marks * 1.2 / 5) * 5);
  const fmtMins = m => m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? " " + (m % 60) + " min" : ""}` : `${m} min`;
  // marks per section, from each paper's cover ("Easy (5 questions) /43"), remembered once a paper has been read;
  // before that, what Save My Exams papers usually have
  let marksSeen = {}; try { marksSeen = JSON.parse(localStorage.getItem("tpMarks") || "{}"); } catch (e) {}
  const TYPICAL = { Structured: { Easy: 43, Medium: 54, Hard: 43 }, MCQ: { Easy: 11, Medium: 11, Hard: 10 } };
  function marksOf(f) {
    const m = marksSeen[f.path] || TYPICAL[f.type] || { Easy: 15, Medium: 18, Hard: 17 };
    return Object.entries(m).filter(([d]) => !T.diffs.size || T.diffs.has(d === "Very Hard" ? "Hard" : d)).reduce((t, [, v]) => t + v, 0);
  }

  // what you've done already: papers in your library made here are named "SMX 2-1 …"
  function statusOf(code) {
    let st = "";
    for (const e of (window.Home && Home.entries) || []) {
      if (!/^SMX\b/.test(e.name || "") || e.deleted) continue;
      if (!new RegExp(`(^|[\\s,])${code.replace("-", "\\-")}(?=[\\s,]|$)`).test(e.name)) continue;
      const done = e.total && e.filled / e.total >= 0.8;
      st = done ? "done" : st || "started";
    }
    return st;
  }

  async function load(fresh) {
    if (!allowed()) return;
    T.loading = true; note("Reading your topic library…");
    try {
      const j = await Sync.apiGet("/api/sme/index" + (fresh ? "?fresh=1" : ""));
      if (!j.setup) { T.idx = null; note("Topic practice isn't set up yet: add SME_URL, SME_ACCESS_ID and SME_ACCESS_SECRET to the TypePDF Worker (see the README)."); render(); return; }
      T.idx = j.files; note(`${new Set(j.files.map(f => f.code)).size} topics in your library.`);
      fromHash(); render();
    } catch (e) { note(e.message, true); }
    T.loading = false;
  }
  // topics grouped by module: [{ n, name, topics: [{ code, topic, types: {type: file} }] }]
  function modules() {
    const mods = new Map();
    for (const f of T.idx || []) {
      if (!mods.has(f.mod)) mods.set(f.mod, { n: f.mod, name: f.module || "Module " + f.mod, topics: new Map() });
      const m = mods.get(f.mod);
      if (!m.topics.has(f.code)) m.topics.set(f.code, { code: f.code, topic: f.topic, sub: f.sub, types: {} });
      m.topics.get(f.code).types[f.type] = f;
    }
    return [...mods.values()].sort((a, b) => a.n - b.n).map(m => ({ ...m, topics: [...m.topics.values()].sort((a, b) => a.sub - b.sub) }));
  }
  const typesAll = () => [...new Set((T.idx || []).map(f => f.type))].filter(t => t !== "Mark scheme").sort();

  function render() {
    const box = el("tpBody"); if (!box) return;
    box.innerHTML = "";
    if (!T.idx) return;
    const q = T.q.toLowerCase();
    // type and difficulty tags
    const bar = document.createElement("div"); bar.className = "pfgroup";
    bar.innerHTML = "<span>Questions</span>";
    for (const t of typesAll()) bar.appendChild(tagBtn(t, T.types.has(t), () => { T.types.has(t) ? T.types.delete(t) : T.types.add(t); save(); render(); }));
    box.appendChild(bar);
    const dbar = document.createElement("div"); dbar.className = "pfgroup";
    dbar.innerHTML = "<span>Difficulty</span>";
    for (const d of DIFFS) dbar.appendChild(tagBtn(d, T.diffs.has(d), () => { T.diffs.has(d) ? T.diffs.delete(d) : T.diffs.add(d); save(); render(); }));
    const hint = document.createElement("small"); hint.className = "tphint"; hint.textContent = T.diffs.size ? "only those sections' pages" : "all of each paper"; dbar.appendChild(hint);
    box.appendChild(dbar);
    // modules with their topic tags
    for (const m of modules()) {
      const topics = m.topics.filter(t => !q || (t.code + " " + t.topic + " " + m.name).toLowerCase().includes(q));
      if (!topics.length) continue;
      const g = document.createElement("div"); g.className = "tpmod";
      const n = topics.filter(t => T.sel.has(t.code)).length;
      const head = document.createElement("button"); head.type = "button"; head.className = "tpmodh" + (n === topics.length ? " on" : n ? " part" : "");
      head.innerHTML = `<b>${m.n}</b> ${esc(m.name)} <small>${n ? n + " of " : ""}${topics.length}</small>`;
      head.title = "Choose (or clear) every topic in this module";
      head.onclick = () => { const all = n === topics.length; for (const t of topics) all ? T.sel.delete(t.code) : T.sel.add(t.code); save(); render(); };
      g.appendChild(head);
      const chips = document.createElement("div"); chips.className = "pfgroup tpchips";
      for (const t of topics) {
        const st = statusOf(t.code);
        const b = tagBtn(`${t.code} ${t.topic}`, T.sel.has(t.code), () => { T.sel.has(t.code) ? T.sel.delete(t.code) : T.sel.add(t.code); save(); render(); });
        if (st) { const d = document.createElement("i"); d.className = "tpst " + st; d.title = st === "done" ? "Done before" : "Started before"; b.prepend(d); }
        b.title = Object.keys(t.types).join(", ") + (st ? ` · ${st === "done" ? "done" : "started"} before` : "");
        chips.appendChild(b);
      }
      g.appendChild(chips); box.appendChild(g);
    }
    // build
    const files = chosenFiles();
    const row = document.createElement("div"); row.className = "tpbuild";
    row.innerHTML = `<button type="button" class="pfclear" id="tpClear">Clear</button><button type="button" id="tpRandom" title="Pick three topics at random from the modules shown">Random 3</button><span class="grow"></span><span class="tpcount">${T.sel.size} topic${T.sel.size === 1 ? "" : "s"} · ${files.length} file${files.length === 1 ? "" : "s"}${files.length ? (() => { const mk = files.reduce((t, f) => t + marksOf(f), 0), exact = files.every(f => marksSeen[f.path]); return ` · <span class="tpest" title="${exact ? "From the papers' covers" : "An estimate until the papers have been opened once"}">${exact ? "" : "≈ "}${mk} marks · about ${fmtMins(minsFor(mk))}</span>`; })() : ""}</span><button type="button" class="pfopen" id="tpGo" ${files.length ? "" : "disabled"}>Build practice paper</button>`;
    box.appendChild(row);
    el("tpClear").onclick = () => { T.sel.clear(); save(); render(); };
    el("tpRandom").onclick = () => { const pool = modules().flatMap(m => m.topics.filter(t => !q || (t.code + " " + t.topic + " " + m.name).toLowerCase().includes(q))); T.sel.clear(); for (let i = 0; i < 3 && pool.length; i++) T.sel.add(pool.splice(Math.floor(Math.random() * pool.length), 1)[0].code); save(); render(); };
    el("tpGo").onclick = build;
  }
  function tagBtn(label, on, fn) { const b = document.createElement("button"); b.type = "button"; b.className = "pftag" + (on ? " on" : ""); b.textContent = label; b.onclick = fn; return b; }
  // the files for the chosen topics and types (no types chosen = every type there is)
  function chosenFiles() {
    const types = T.types.size ? T.types : new Set(typesAll());
    const out = [];
    for (const m of modules()) for (const t of m.topics) if (T.sel.has(t.code)) for (const ty of Object.keys(t.types).sort()) if (types.has(ty)) out.push(t.types[ty]);
    return out;
  }

  // what each page of a Save My Exams paper is: the cover (with each section's marks) and the questions of each
  // section, headed "Easy Questions", "Medium Questions", "Hard Questions"
  const SEC = /\b(Very Hard|Easy|Medium|Hard)\s+Questions?\b/i;
  const cap = s => s.toLowerCase().replace(/(^|\s)\w/g, c => c.toUpperCase());
  async function analyse(bytes) {
    const d = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false }).promise;
    const pages = [], marks = {}; let sec = null;
    for (let i = 0; i < d.numPages; i++) {
      const tc = await (await d.getPage(i + 1)).getTextContent();
      const txt = tc.items.map(it => it.str).join(" ").replace(/\s+/g, " ");
      const secs = [...txt.matchAll(/(Very Hard|Easy|Medium|Hard)\s*\(\s*\d+\s*questions?\s*\)\s*\/?\s*(\d+)/gi)];
      if (secs.length >= 2 || (i === 0 && /total marks/i.test(txt))) { for (const m of secs) marks[cap(m[1])] = +m[2]; pages.push({ role: "cover" }); continue; }
      const h = txt.match(SEC); if (h) sec = cap(h[1]);
      pages.push({ role: "q", sec });
    }
    d.destroy();
    return { pages, marks };
  }
  const wantSec = sec => !T.diffs.size || (sec && T.diffs.has(sec === "Very Hard" ? "Hard" : sec));
  // ASCII-ish text for the contents page's standard font
  const plain = t => String(t).replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
  async function contentsPage(out, title, rows, marks, mins) {
    const { StandardFonts, rgb } = PDFLib;
    const pg = out.insertPage(0, [595.28, 841.89]);
    const f = await out.embedFont(StandardFonts.Helvetica), fb = await out.embedFont(StandardFonts.HelveticaBold);
    const ink = rgb(0.1, 0.12, 0.13), mid = rgb(0.4, 0.44, 0.43), line = rgb(0.82, 0.85, 0.84);
    let y = 780;
    pg.drawText("Topic practice", { x: 56, y, size: 11, font: fb, color: rgb(0.18, 0.49, 0.45) }); y -= 26;
    for (const ln of wrap(plain(title), fb, 18, 483)) { pg.drawText(ln, { x: 56, y, size: 18, font: fb, color: ink }); y -= 23; }
    y -= 4;
    pg.drawText(plain(`${marks} marks  ·  suggested time ${fmtMins(mins)}  ·  ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}`), { x: 56, y, size: 11, font: f, color: mid }); y -= 34;
    const cols = [56, 262, 445, 500];
    ["Topic", "Questions", "Pages", "Marks"].forEach((h, k) => pg.drawText(h, { x: cols[k], y, size: 10, font: fb, color: mid }));
    y -= 8; pg.drawLine({ start: { x: 56, y }, end: { x: 539, y }, thickness: 0.8, color: line }); y -= 16;
    for (const r of rows) {
      if (y < 90) break;
      const tl = wrap(plain(`${r.code} ${r.topic}`), f, 10.5, 196), wl = wrap(plain(r.what), f, 10.5, 172);
      tl.forEach((ln, k) => pg.drawText(ln, { x: cols[0], y: y - k * 13, size: 10.5, font: f, color: ink }));
      wl.forEach((ln, k) => pg.drawText(ln, { x: cols[1], y: y - k * 13, size: 10.5, font: f, color: ink }));
      pg.drawText(r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`, { x: cols[2], y, size: 10.5, font: f, color: ink });
      pg.drawText(r.marks ? String(r.marks) : "-", { x: cols[3], y, size: 10.5, font: f, color: ink });
      y -= 13 * Math.max(tl.length, wl.length) + 7;
      pg.drawLine({ start: { x: 56, y: y + 3 }, end: { x: 539, y: y + 3 }, thickness: 0.4, color: line }); y -= 8;
    }
    y = Math.min(y - 14, 150);
    const tips = ["How to use this paper in TypePDF:", "-  Type in the answer spaces, or write on the paper with the pen.", "-  Multiple choice: tap a letter to circle it (tap another to change your mind).",
      "-  Go to lists every question by section: E = Easy, M = Medium, H = Hard (E1, M2(b) ...).", "-  The timer is set to the suggested time: press it, then Start."];
    tips.forEach((t, k) => pg.drawText(plain(t), { x: 56, y: y - k * 15, size: 10, font: k ? f : fb, color: k ? mid : ink }));
  }
  function wrap(t, font, size, w) {
    const out = []; let cur = "";
    for (const word of t.split(/\s+/)) { const nx = cur ? cur + " " + word : word; if (cur && font.widthOfTextAtSize(nx, size) > w) { out.push(cur); cur = word; } else cur = nx; }
    if (cur) out.push(cur); return out.slice(0, 3);
  }
  async function build() {
    const files = chosenFiles(); if (!files.length) return;
    const btn = el("tpGo"); btn.disabled = true;
    try {
      const out = await PDFLib.PDFDocument.create(), meta = [], rows = [];
      let marks = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i]; busy(true, `Getting ${f.code} ${f.type}… (${i + 1} of ${files.length})`, i / files.length);
        const res = await Sync.api("/api/sme/pdf?path=" + encodeURIComponent(f.path));
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `couldn't get ${f.code} (${res.status})`); }
        const bytes = await res.arrayBuffer();
        const info = await analyse(bytes);
        if (Object.keys(info.marks).length) { marksSeen[f.path] = info.marks; try { localStorage.setItem("tpMarks", JSON.stringify(marksSeen)); } catch (e) {} }
        // the question pages in the chosen sections (all of them when the paper has no section headings)
        const headed = info.pages.some(p => p.sec);
        const keep = info.pages.map((p, k) => k).filter(k => info.pages[k].role === "q" && (!headed || wantSec(info.pages[k].sec)));
        if (!keep.length) continue;
        const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
        const from = out.getPageCount() + 2;                         // page numbers after the contents page
        for (const pg of await out.copyPages(src, keep)) out.addPage(pg);
        keep.forEach(k => meta.push({ role: "q", code: f.code, topic: f.topic, type: f.type, sec: info.pages[k].sec || "" }));
        const secs = headed ? [...new Set(keep.map(k => info.pages[k].sec).filter(Boolean))] : [];
        const mk = Object.keys(info.marks).length ? Object.entries(info.marks).filter(([d]) => !headed || secs.includes(d)).reduce((t, [, v]) => t + v, 0) : 0;
        marks += mk;
        rows.push({ code: f.code, topic: f.topic, what: f.type + (secs.length && secs.length < 3 ? " (" + secs.join(", ") + ")" : ""), from, to: from + keep.length - 1, marks: mk });
      }
      if (!out.getPageCount()) { busy(false); toast("None of those papers has pages in the difficulty you chose.", 4000); return; }
      const codes = [...T.sel].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const one = codes.length === 1 && files[0];
      const types = [...new Set(files.map(f => f.type))].join(" + "), diffs = T.diffs.size ? " (" + DIFFS.filter(d => T.diffs.has(d)).join(", ") + ")" : "";
      const name = (one ? `SMX ${one.code} ${one.topic} – ${types}` : `SMX ${codes.slice(0, 6).join(", ")}${codes.length > 6 ? " …" : ""} – ${types}`) + diffs;
      if (!marks) marks = files.reduce((t, f) => t + marksOf(f), 0);
      const mins = minsFor(marks);
      await contentsPage(out, name, rows, marks, mins);
      // what each page is, for TypePDF when the paper is opened (MCQ pages, sections, topics)
      out.setTitle(name); out.setCreator("TypePDF");
      out.setSubject(JSON.stringify({ smx: 1, est: { marks, mins }, pages: [{ role: "contents" }, ...meta] }));
      const bytes = await out.save();
      busy(false);
      await openFile(new File([bytes], name.replace(/[\\/:*?"<>|]+/g, " ") + ".pdf", { type: "application/pdf" }));
      toast(`${marks} marks · suggested time ${fmtMins(mins)} (the timer is set: press it, then Start)`, 5000);
      render();
    } catch (e) { busy(false); toast("Couldn't build the paper: " + (e.message || e), 6000); }
    finally { btn.disabled = false; }
  }

  // a link from the revision pack: #topics=2-1,4-3&types=MCQ&diff=Hard
  function fromHash() {
    const h = new URLSearchParams(location.hash.slice(1)); if (!h.get("topics")) return;
    T.sel = new Set(h.get("topics").split(/[,\s]+/).filter(Boolean));
    T.types = new Set((h.get("types") || "").split(",").map(s => s.trim()).filter(Boolean).map(s => typesAll().find(t => t.toLowerCase().startsWith(s.toLowerCase())) || s));
    T.diffs = new Set((h.get("diff") || "").split(",").map(s => s.trim()).filter(Boolean).map(s => s[0].toUpperCase() + s.slice(1).toLowerCase()));
    history.replaceState(null, "", location.pathname + location.search);
    el("topics").open = true; save();
    setTimeout(() => el("topics").scrollIntoView({ behavior: "smooth", block: "start" }), 300);
  }

  const sec = el("topics");
  function show() { sec.hidden = !allowed(); if (!sec.hidden && (sec.open || /topics=/.test(location.hash)) && !T.idx && !T.loading) load(); }
  sec.addEventListener("toggle", () => { try { localStorage.setItem("tpOpen", sec.open ? "1" : "0"); } catch (e) {} if (sec.open && !T.idx && !T.loading) load(); else if (sec.open) render(); });
  el("tpQ").addEventListener("input", e => { T.q = e.target.value.trim(); render(); });
  el("tpRefresh").onclick = () => load(true);
  try { if (localStorage.getItem("tpOpen") === "1") sec.open = true; } catch (e) {}
  // shown once we know who's signed in
  let tries = 0; const wait = setInterval(() => { if ((window.Sync && Sync.info) || ++tries > 40) { clearInterval(wait); show(); } }, 250);
  window.addEventListener("hashchange", () => { if (/topics=/.test(location.hash)) { if (T.idx) { fromHash(); render(); } else show(); } });
  window.TopicPractice = { refresh: render, show };
})();
