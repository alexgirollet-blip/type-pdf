// finder.js — the past paper finder on the home page: search Physics & Maths Tutor's A-level past papers, narrow
// them down with tags (exam board, paper, year, series, type), and open one (which adds it to your papers).
// The Worker reads PMT's pages (src/pmt.js); PDFs come through /api/fetch-pdf, so the finder needs an account.
"use strict";
(() => {
  const F = { subjects: null, res: null, sel: {}, sort: "new", loading: false };
  const GROUPS = [["level", "Level"], ["board", "Exam board"], ["paper", "Paper"], ["year", "Year"], ["series", "Series"], ["kind", "Type"]];
  const el = id => document.getElementById(id);
  const note = (t, err) => { const n = el("pfNote"); n.textContent = t || ""; n.classList.toggle("err", !!err); };
  try { Object.assign(F, JSON.parse(localStorage.getItem("pfPrefs") || "{}"), { subjects: null, res: null, loading: false }); } catch (e) {}
  const savePf = () => { try { localStorage.setItem("pfPrefs", JSON.stringify({ subj: F.subj || "", q: F.q || "", sel: F.sel, sort: F.sort })); } catch (e) {} };
  const call = async path => { const r = await fetch(path, { headers: { authorization: "Bearer " + (localStorage.getItem("token") || "") }, credentials: "same-origin" }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Something went wrong (${r.status})`); return j; };

  async function loadSubjects() {
    if (F.subjects || !(window.Sync && Sync.user)) return;
    try {
      const j = await apiGet("/api/pmt/subjects"); F.subjects = j.subjects || [];
      const s = el("pfSubj"); s.innerHTML = `<option value="">Subject…</option>` + F.subjects.map(x => `<option value="${esc(x.href)}">${esc(x.name.replace(/^a[- ]level\s*/i, ""))}</option>`
        + (/^(a[- ]level\s*)?physics$/i.test(x.name.trim()) ? `<option value="${MOCKS}">Physics mock papers (Save My Exams)</option>` : "")).join("");
      if (!F.subjects.some(x => /^(a[- ]level\s*)?physics$/i.test(x.name.trim()))) s.insertAdjacentHTML("beforeend", `<option value="${MOCKS}">Physics mock papers (Save My Exams)</option>`);
      if (F.subj) s.value = F.subj;
    } catch (e) {
      note("Couldn't load the subjects: " + e.message, true);
      el("pfSubj").insertAdjacentHTML("beforeend", `<option value="${MOCKS}">Physics mock papers (Save My Exams)</option>`);
    }
  }
  // the account's API helper (adds the sign-in token); falls back to a plain fetch
  const apiGet = path => window.Sync && Sync.apiGet ? Sync.apiGet(path) : call(path);

  // ---- Save My Exams mock papers, from the same library as topic practice (src/sme.js). Each PDF has its mark
  // scheme at the end: "Paper" opens the question pages, "Mark scheme" the rest ----
  const MOCKS = "smx:mocks";
  async function mocks(q) {
    F.q = q; F.subj = MOCKS; note("Reading your mock papers…"); el("pfList").innerHTML = ""; el("pfTags").innerHTML = "";
    try {
      const j = await apiGet("/api/sme/index");
      if (!j.setup) { note("The Save My Exams library isn't set up on this site (see Topic practice in the README).", true); return; }
      const results = [];
      for (const m of j.mocks || []) for (const kind of ["Question paper", "Mark scheme"])
        results.push({ board: "Save My Exams", level: "A level", paper: "Mock paper " + m.paper, series: m.set ? "Set " + m.set : "", year: "", kind, title: `Mock Paper ${m.paper}${m.set ? " · Set " + m.set : ""}`, smx: m, name: `SMX Mock Paper ${m.paper}${m.set ? " Set " + m.set : ""}${kind === "Mark scheme" ? " – Mark scheme" : ""}` });
      const words = q.toLowerCase().split(/\s+/).filter(w => w && !/^(physics|mock|mocks|papers?|sme|smx|save|my|exams?)$/.test(w));
      F.res = { subject: "Physics mock papers", results: results.filter(x => words.every(w => (x.title + " " + x.kind + " set" + (x.smx.set || "")).toLowerCase().replace(/\s+/g, " ").includes(w) || ("set" + x.smx.set).toLowerCase() === w)) };
      F.sel = {}; render(); savePf();
      if (!results.length) note("No mock papers found. They should be named like “Mock Paper 1 - Set A.pdf”.");
    } catch (e) { note(e.message, true); }
  }
  // the question pages (or the mark scheme) of one mock, with what each page is, then open it
  async function openMock(x) {
    try {
      busy(true, `Getting ${x.title}…`, 0.1);
      const res = await Sync.api("/api/sme/pdf?path=" + encodeURIComponent(x.smx.path));
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `couldn't get it (${res.status})`); }
      const bytes = await res.arrayBuffer();
      const d = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false }).promise;
      const txt = []; for (let i = 0; i < d.numPages; i++) txt.push((await (await d.getPage(i + 1)).getTextContent()).items.map(t => t.str).join(" ").replace(/\s+/g, " "));
      d.destroy();
      // the mark scheme starts on the first page (after the cover) whose heading says so
      let ms = txt.findIndex((t, i) => i > 0 && /mark\s*scheme|^\s*(answers|solutions)\b/i.test(t.slice(0, 260)));
      if (ms < 0) ms = txt.length;
      const isMs = x.kind === "Mark scheme";
      if (isMs && ms >= txt.length) { busy(false); toast("Couldn't find where the mark scheme starts in this paper, so the whole PDF is opened.", 5000); }
      const keep = isMs ? (ms < txt.length ? range(ms, txt.length) : range(0, txt.length)) : range(0, ms);
      const cover = t => /scan here|total marks/i.test(t) && t.length < 2500;
      const tm = (txt[0] || "").match(/time:?\s*(\d+)\s*hours?\s*(?:(\d+)\s*min)?/i), mk = (txt[0] || "").match(/\/\s*(\d{2,3})\b/);
      const mins = tm ? +tm[1] * 60 + (+tm[2] || 0) : mk ? Math.round(+mk[1] * 1.2 / 5) * 5 : 0;
      const pages = keep.map(i => isMs ? { role: "ms" } : i === 0 && cover(txt[0]) ? { role: "cover", type: "Mock" } : { role: "q", type: "Mock" });
      const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true }), out = await PDFLib.PDFDocument.create();
      for (const pg of await out.copyPages(src, keep)) out.addPage(pg);
      out.setTitle(x.name); out.setCreator("TypePDF");
      out.setSubject(JSON.stringify({ smx: 1, mock: true, pages, ...(!isMs && mins ? { est: { marks: mk ? +mk[1] : 0, mins } } : {}) }));
      const b = await out.save();
      busy(false);
      await openFile(new File([b], x.name.replace(/[\\/:*?"<>|]+/g, " ") + ".pdf", { type: "application/pdf" }));
    } catch (e) { busy(false); toast("Couldn't open the mock: " + (e.message || e), 6000); }
  }
  const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);

  async function search() {
    if (!(window.Sync && Sync.user)) { note("Sign in to use the past paper finder (papers are fetched through your account)."); return; }
    const q = el("pfQ").value.trim(), subj = el("pfSubj").value;
    if (subj === MOCKS || /\bmocks?\b/i.test(q) && /physics|sme|save my exams/i.test(q)) { el("pfSubj").value = MOCKS; return mocks(subj === MOCKS ? q : ""); }
    if (!q && !subj) { note("Pick a subject or type a search."); return; }
    F.q = q; F.subj = subj; F.loading = true; note("Looking on Physics & Maths Tutor…"); el("pfList").innerHTML = ""; el("pfTags").innerHTML = "";
    try {
      const r = await apiGet("/api/pmt/search?q=" + encodeURIComponent(q) + "&subject=" + encodeURIComponent(subj));
      F.res = r;
      if (r.subjectHref && el("pfSubj").value !== r.subjectHref) { el("pfSubj").value = r.subjectHref; F.subj = r.subjectHref; }
      // words in the search become selected tags; a new subject clears old tags
      F.sel = {};
      const h = r.hints || {};
      for (const [g] of GROUPS) {
        const want = String(h[g] || "").toLowerCase(); if (!want) continue;
        const vals = [...new Set(r.results.map(x => x[g]).filter(Boolean))];
        const hit = g === "paper" ? vals.filter(v => new RegExp(`\\b0?${want}\\b`, "i").test(v)) : vals.filter(v => v.toLowerCase() === want);
        if (hit.length) F.sel[g] = hit;
      }
      note(r.note || (r.results.length ? "" : "No PDFs found for that. Try fewer words."));
      render(); savePf();
    } catch (e) { note(e.message, true); }
    F.loading = false;
  }

  const matches = (x, except) => GROUPS.every(([g]) => g === except || !(F.sel[g] && F.sel[g].length) || F.sel[g].includes(x[g]));
  function render() {
    const r = F.res; if (!r) return;
    // tags: each group's values with how many papers each would show
    const tags = el("pfTags"); tags.innerHTML = "";
    for (const [g, label] of GROUPS) {
      const counts = new Map(); for (const x of r.results) if (x[g] && matches(x, g)) counts.set(x[g], (counts.get(x[g]) || 0) + 1);
      for (const v of F.sel[g] || []) if (!counts.has(v)) counts.set(v, 0);
      if (counts.size < 2 && !(F.sel[g] || []).length) continue;
      const row = document.createElement("div"); row.className = "pfgroup";
      row.innerHTML = `<span>${label}</span>`;
      const vals = [...counts.keys()].sort((a, b) => g === "year" ? b - a : a.localeCompare(b, undefined, { numeric: true }));
      for (const v of vals) {
        const b = document.createElement("button"); b.type = "button"; b.className = "pftag" + ((F.sel[g] || []).includes(v) ? " on" : "");
        b.innerHTML = `${esc(v)} <small>${counts.get(v)}</small>`;
        b.onclick = () => { const cur = new Set(F.sel[g] || []); cur.has(v) ? cur.delete(v) : cur.add(v); F.sel[g] = [...cur]; render(); savePf(); };
        row.appendChild(b);
      }
      tags.appendChild(row);
    }
    if (Object.values(F.sel).some(a => a && a.length)) { const c = document.createElement("button"); c.type = "button"; c.className = "pfclear"; c.textContent = "Clear tags"; c.onclick = () => { F.sel = {}; render(); savePf(); }; tags.appendChild(c); }
    const sortRow = document.createElement("div"); sortRow.className = "pfgroup";
    sortRow.innerHTML = `<span>Sort</span><select id="pfSort" aria-label="Sort"><option value="new">Newest first</option><option value="old">Oldest first</option><option value="paper">Board and paper</option><option value="kind">Type</option></select>`;
    tags.appendChild(sortRow); const ss = el("pfSort"); ss.value = F.sort; ss.onchange = () => { F.sort = ss.value; render(); savePf(); };
    // results
    const list = r.results.filter(x => matches(x));
    const by = { new: (a, b) => (+b.year || 0) - (+a.year || 0), old: (a, b) => (+a.year || 9999) - (+b.year || 9999), paper: (a, b) => (a.board + a.paper).localeCompare(b.board + b.paper, undefined, { numeric: true }), kind: (a, b) => a.kind.localeCompare(b.kind) };
    const kq = k => /question/i.test(k) ? "0" : "1" + k;                // question papers before their mark schemes
    const tie = (a, b) => (a.board + a.paper + a.series + kq(a.kind)).localeCompare(b.board + b.paper + b.series + kq(b.kind), undefined, { numeric: true });
    list.sort((a, b) => by[F.sort](a, b) || tie(a, b));
    const ul = el("pfList"); ul.innerHTML = "";
    for (const x of list.slice(0, 120)) {
      const li = document.createElement("li");
      const head = [x.board, [x.level === "AS" ? "AS" : "", x.paper].filter(Boolean).join(" ") || (x.level === "AS" ? "AS" : ""), [x.series, x.year].filter(Boolean).join(" ")].filter(Boolean).join(" · ") || x.title;
      li.innerHTML = `<div class="pfinfo"><b>${esc(head)}</b><span class="pfkind k-${esc(x.kind.split(" ")[0].toLowerCase())}">${esc(x.kind)}</span><small>${esc(r.subject)} · ${esc(x.title)}</small></div>
        ${x.smx ? "" : `<a class="pfsrc" href="${esc(x.url)}" target="_blank" rel="noopener" title="Open on Physics &amp; Maths Tutor">PMT ↗</a>`}<button type="button" class="pfopen">Add &amp; open</button>`;
      li.querySelector(".pfopen").onclick = () => x.smx ? openMock(x) : openLink(x.url, x.name);
      ul.appendChild(li);
    }
    note(list.length ? `${list.length} paper${list.length === 1 ? "" : "s"}${list.length > 120 ? " (showing 120)" : ""} · ${r.subject}${r.partial ? " · some pages weren't looked at; add a board or paper to the search" : ""}` : (r.results.length ? "Nothing matches those tags." : el("pfNote").textContent));
  }

  el("pfForm").addEventListener("submit", e => { e.preventDefault(); search(); });
  el("pfSubj").addEventListener("change", () => { if (el("pfSubj").value) { el("pfQ").value = ""; search(); } });   // a new subject: all its papers
  el("finder").addEventListener("toggle", () => {
    try { localStorage.setItem("pfOpen", el("finder").open ? "1" : "0"); } catch (e) {}
    if (!el("finder").open) return;
    if (!(window.Sync && Sync.user)) { note("Sign in to use the past paper finder (papers are fetched through your account)."); return; }
    loadSubjects(); if (F.q) el("pfQ").value = F.q;
  });
  try { if (localStorage.getItem("pfOpen") === "1") el("finder").open = true; } catch (e) {}
})();
