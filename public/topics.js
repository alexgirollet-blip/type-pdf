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
  const allowed = () => !!(window.Sync && Sync.user && Sync.info && Sync.info.admin);

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
    row.innerHTML = `<button type="button" class="pfclear" id="tpClear">Clear</button><button type="button" id="tpRandom" title="Pick three topics at random from the modules shown">Random 3</button><span class="grow"></span><span class="tpcount">${T.sel.size} topic${T.sel.size === 1 ? "" : "s"} · ${files.length} file${files.length === 1 ? "" : "s"}</span><button type="button" class="pfopen" id="tpGo" ${files.length ? "" : "disabled"}>Build practice paper</button>`;
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

  // the pages of one paper that are in the chosen difficulty sections (Save My Exams heads each section
  // "Easy Questions", "Medium Questions", "Hard Questions"); everything when none is chosen or none is found
  async function pagesFor(bytes) {
    const d = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false }).promise;
    const all = Array.from({ length: d.numPages }, (_, i) => i);
    if (!T.diffs.size) { d.destroy(); return all; }
    let cur = null, found = false; const keep = [];
    for (let i = 0; i < d.numPages; i++) {
      const tc = await (await d.getPage(i + 1)).getTextContent();
      const txt = tc.items.map(it => it.str).join(" ").replace(/\s+/g, " ");
      const m = txt.match(/\b(Very Hard|Easy|Medium|Hard)\s+Questions?\b/i);
      if (m && i > 0) { cur = m[1].replace(/^\w/, c => c.toUpperCase()).replace("Very hard", "Very Hard"); found = true; }
      if (cur && (T.diffs.has(cur) || (cur === "Very Hard" && T.diffs.has("Hard")))) keep.push(i);
    }
    d.destroy();
    return found ? keep : all;
  }
  async function build() {
    const files = chosenFiles(); if (!files.length) return;
    const btn = el("tpGo"); btn.disabled = true;
    try {
      const out = await PDFLib.PDFDocument.create();
      for (let i = 0; i < files.length; i++) {
        const f = files[i]; busy(true, `Getting ${f.code} ${f.type}… (${i + 1} of ${files.length})`, i / files.length);
        const res = await Sync.api("/api/sme/pdf?path=" + encodeURIComponent(f.path));
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `couldn't get ${f.code} (${res.status})`); }
        const bytes = await res.arrayBuffer();
        const pages = await pagesFor(bytes);
        if (!pages.length) continue;
        const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
        for (const pg of await out.copyPages(src, pages)) out.addPage(pg);
      }
      if (!out.getPageCount()) { busy(false); toast("None of those papers has pages in the difficulty you chose.", 4000); return; }
      const codes = [...T.sel].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const one = codes.length === 1 && files[0];
      const types = [...new Set(files.map(f => f.type))].join(" + "), diffs = T.diffs.size ? " (" + DIFFS.filter(d => T.diffs.has(d)).join(", ") + ")" : "";
      const name = (one ? `SMX ${one.code} ${one.topic} – ${types}` : `SMX ${codes.slice(0, 6).join(", ")}${codes.length > 6 ? " …" : ""} – ${types}`) + diffs;
      out.setTitle(name); out.setCreator("TypePDF");
      const bytes = await out.save();
      busy(false);
      await openFile(new File([bytes], name.replace(/[\\/:*?"<>|]+/g, " ") + ".pdf", { type: "application/pdf" }));
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
  // shown once we know who's signed in (the library is the owner's)
  let tries = 0; const wait = setInterval(() => { if ((window.Sync && Sync.info) || ++tries > 40) { clearInterval(wait); show(); } }, 250);
  window.addEventListener("hashchange", () => { if (/topics=/.test(location.hash)) { if (T.idx) { fromHash(); render(); } else show(); } });
  window.TopicPractice = { refresh: render, show };
})();
