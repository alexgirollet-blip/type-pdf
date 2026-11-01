// TypePDF — fill in any PDF in the browser: type on the answer lines, write with a pen,
// sync live across devices, export a filled-in PDF or a compact pack for AI marking.
"use strict";
pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// the typeface answers are typed in (fonts.js); its metrics decide where text sits on a line
let curFont = FONTS[FONT_DEFAULT];
const fontScale = r => (r && r.code) ? 1 : (curFont.scale || 1);
function baseInLine(fs, L) { const f = curFont, e = fs * (f.scale || 1); return (L - (f.asc + f.desc) * e) / 2 + f.asc * e; }
const MIN_FS = 8.5;                          // smallest size typed answers shrink to (pt)
const INK = "#111418";
const rid8 = () => Math.random().toString(36).slice(2, 10);

// ---------------- toast / busy ----------------
let toastT;
function toast(msg, ms = 2800) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), ms); }
function busy(on, txt = "", frac = null) {
  $("#busy").hidden = !on; if (txt) $("#busyTxt").textContent = txt;
  $("#busyBar").parentElement.hidden = frac === null; if (frac !== null) $("#busyBar").style.width = (frac * 100).toFixed(0) + "%";
}

// ---------------- IndexedDB (this device) ----------------
const DB = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open("typepdf", 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("docs", { keyPath: "id" }); d.createObjectStore("meta", { keyPath: "id" }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction(store, mode); const s = t.objectStore(store); const q = fn(s); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
  return {
    get: id => tx("docs", "readonly", s => s.get(id)),
    getMeta: id => tx("meta", "readonly", s => s.get(id)),
    put: d => tx("docs", "readwrite", s => s.put(Object.assign(strip(d), { bytes: d.bytes }))),
    del: async id => { await tx("docs", "readwrite", s => s.delete(id)); await tx("meta", "readwrite", s => s.delete(id)); },
    putMeta: m => tx("meta", "readwrite", s => s.put(m)),
    list: () => tx("meta", "readonly", s => s.getAll()),
  };
})();
// a copy of the document without DOM references or the PDF bytes
function strip(d) { return JSON.parse(JSON.stringify({ ...d, bytes: undefined, pages: d.pages.map(P => P && ({ ...P, regions: P.regions.map(cleanRegion) })) })); }
// a region without the on-screen bits hung on it (its text box, outline, …): every key starting with "_"
function cleanRegion(r) { const o = {}; for (const k in r) if (k[0] !== "_") o[k] = r[k]; return o; }
async function sha(buf) { const h = await crypto.subtle.digest("SHA-256", buf); return [...new Uint8Array(h)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join(""); }

// ---------------- state ----------------
let doc = null;      // {id,name,bytes,pages:[{w,h,rot,regions,items,gaps,hasText}],text,fit,strokes,timer,seq,dirty,created,updated}
let pdf = null;      // pdf.js document
let zoom = 1, fitZoom = 1, dpr = window.devicePixelRatio || 1;
let tool = "pen", colour = INK, width = 1.3, newKind = "lines";
let views = [];      // per page: {el, pg, ink, bm, bmZoom, visible, gapEls}
const undoS = [], redoS = [];
let saveT = null;

function metaOf() { return { name: doc.name, pages: doc.pages.length, filled: filledCount(), total: totalRegions(), flags: Object.keys(doc.flags || {}).length }; }
// rough size of a paper on this device: the PDF plus everything typed and drawn
function docSize(d) { let n = d.bytes ? d.bytes.byteLength : 0; try { n += JSON.stringify({ t: d.text, s: d.strokes }).length; } catch (e) {} return n; }
function scheduleSave() {
  clearTimeout(saveT);
  saveT = setTimeout(saveNow, 500);
}
// papers are only kept by signed-in people (in their account, with this browser as a cache);
// without an account, or in someone else's shared paper, nothing is written to this device
const canSave = () => !!(window.Sync && Sync.user && doc && !doc.shared);
const hasWork = () => !!doc && (Object.keys(doc.text || {}).length > 0 || Object.values(doc.strokes || {}).some(a => a && a.length));
async function saveNow() {
  clearTimeout(saveT);
  if (!doc) return;
  doc.updated = Date.now();
  if (!canSave()) { const m = JSON.stringify(metaOf()); if (m !== doc._lastMeta) { doc._lastMeta = m; emit("meta"); } return; }
  try {
    await DB.put(doc);
    const old = await DB.getMeta(doc.id).catch(() => null) || {};
    await DB.putMeta({ ...old, id: doc.id, ...metaOf(), pdf: doc.pdf, updated: doc.updated, opened: doc.opened, size: docSize(doc), local: true, owner: Sync.info && Sync.info.user });
  } catch (e) { toast("Couldn't save in this browser (storage full or blocked). Export a backup."); }
  const m = JSON.stringify(metaOf());
  if (m !== doc._lastMeta) { doc._lastMeta = m; emit("meta"); }
}
// tell the sync layer that a key changed (no-op when not signed in)
function emit(key) { if (window.Sync && doc) Sync.changed(key); }

// ---------------- home ----------------
async function showHome(force) {
  if (doc && !doc.shared && !canSave() && hasWork() && force !== true && !confirm("This paper isn't saved, because you're not signed in. Leave it anyway? (Export the PDF first if you want to keep it.)")) return;
  if (doc) { saveView(); await saveNow(); }
  if (window.Sync) Sync.detach();
  hideFlagFloat();
  $("#editor").hidden = true; $("#home").hidden = false; document.title = "TypePDF";
  if (pdf) { pdf.destroy(); pdf = null; } doc = null; views = []; $("#pages").innerHTML = "";
  undoS.length = redoS.length = 0;
  renderHomeList();
}
$("#file").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) openFile(f); });
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => { e.preventDefault(); if (!$("#editor").hidden) { const f = e.dataTransfer.files[0]; if (f && /pdf|paperwork|typepdf|json/i.test(f.type + f.name)) openFile(f); } });

// paste a PDF (file or link) anywhere outside an answer space → opens it as a new paper
document.addEventListener("paste", async e => {
  if (document.activeElement && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName)) return;
  const files = [...(e.clipboardData?.files || [])];
  const f = files.find(f => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  if (f) { e.preventDefault(); return openFile(f); }
  const txt = (e.clipboardData?.getData("text") || "").trim();
  if (/^https?:\/\/\S+$/i.test(txt)) { e.preventDefault(); return openLink(txt); }
  if (files.length) toast("Only PDF files can be pasted.");
});
$("#linkForm").addEventListener("submit", e => { e.preventDefault(); const v = $("#linkIn").value.trim(); if (v) openLink(v); });
async function openLink(url, title) {
  busy(true, "Fetching the PDF…");
  try {
    let res;
    if (window.Sync && Sync.user) res = await Sync.fetchPdf(url, title);
    else { try { res = await fetch(url); } catch (e) { busy(false); toast("That site doesn't allow direct downloads. Sign in to open PDFs from links, or download it and drop it here.", 6000); return; } }
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "the link didn't work (" + res.status + ")"); }
    const buf = await res.arrayBuffer();
    let name = decodeURIComponent(res.headers.get("x-file-name") || url.split("/").pop() || "paper.pdf");
    busy(false);
    await openFile(new File([buf], name, { type: "application/pdf" }));
  } catch (e) { busy(false); toast("Couldn't open that link: " + (e.message || e), 5000); }
}

async function openFile(f) {
  try {
    if ($("#pasteDlg").open) $("#pasteDlg").close();
    if (doc && !doc.shared && !canSave() && hasWork() && !confirm("The paper you have open isn't saved, because you're not signed in. Open the new one anyway?")) return;
    if (doc) { saveView(); await saveNow(); }
    const buf = await f.arrayBuffer();
    const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 1024)));
    if (head.trimStart().startsWith("{")) return openBackup(buf);
    if (!head.includes("%PDF")) { toast("That file isn't a PDF."); return; }
    // a PDF exported from TypePDF: reopen the original paper with its answers, all still editable
    const restored = await fromExport(buf);
    if (restored) return openRestored(restored);
    const id = await sha(buf);
    const signed = !!(window.Sync && Sync.user);
    const existing = signed ? await DB.get(id).catch(() => null) : null;
    const em = existing ? await DB.getMeta(id).catch(() => null) : null;
    if (existing && (!em || !em.owner || !Sync.info || em.owner === Sync.info.user)) { toast("You've opened this paper before, so your answers are back. Use Duplicate on the home screen for a fresh attempt."); return openDoc(existing); }
    const d = newDoc(id, id, f.name.replace(/\.pdf$/i, "") || "Untitled", buf);
    if (signed) await DB.putMeta({ id, name: d.name, pdf: id, folder: null, updated: Date.now(), created: Date.now(), local: true, owner: Sync.info && Sync.info.user }).catch(() => {});
    await openDoc(d, true);
  } catch (e) { console.error(e); busy(false); toast("Couldn't open that file: " + (e.message || e)); }
}
function newDoc(id, pdfHash, name, bytes) { return { v: 2, id, pdf: pdfHash, name, bytes, pages: [], text: {}, fit: {}, strokes: {}, flags: {}, font: null, timer: null, seq: 0, dirty: {}, created: Date.now(), updated: Date.now() }; }
async function openStored(id, meta) {
  let d = await DB.get(id).catch(() => null);
  if (!d && window.Sync && Sync.user) {
    busy(true, "Downloading from your account…");
    try {
      const hash = (meta && meta.pdf) || id;
      // another attempt at the same paper may already have the PDF on this device
      let buf = null; for (const m of await DB.list().catch(() => [])) { if (m.pdf === hash && m.id !== id) { const o = await DB.get(m.id).catch(() => null); if (o && o.bytes) { buf = o.bytes.slice(0); break; } } }
      if (!buf) buf = await Sync.getPdf(hash);
      d = newDoc(id, hash, (meta && meta.name) || "Untitled", buf);
    } catch (e) { busy(false); toast("Couldn't download that paper: " + e.message); return; }
  }
  if (d) openDoc(d); else toast("That paper is no longer saved here.");
}
// older saved papers are brought up to the current format; nothing is dropped
function migrateDoc(d) {
  d.text ||= {}; d.fit ||= {}; d.strokes ||= {}; d.dirty ||= {}; d.seq ||= 0; d.flags ||= {};
  if (!d.pdf) d.pdf = d.id;
  for (const arr of Object.values(d.strokes)) for (const s of arr || []) { s.id ||= rid8(); s.t ||= "pen"; delete s._live; }
  for (const [k, f] of Object.entries(d.fit)) if (typeof f !== "object") delete d.fit[k];
  for (const P of d.pages || []) if (P && P.regions) P.regions.forEach((r, i) => { P.regions[i] = cleanRegion(r); });   // drop anything saved by mistake
  d.v = 2;
  return d;
}

// ---------------- open / detect ----------------
async function openDoc(d, fresh = false) {
  busy(true, "Opening…", null);
  if (pdf) { pdf.destroy(); pdf = null; }
  doc = migrateDoc(d); doc.opened = Date.now();
  undoS.length = redoS.length = 0; views = [];
  pdf = await pdfjsLib.getDocument({ data: new Uint8Array(doc.bytes.slice(0)), isEvalSupported: false }).promise;
  // signed in: pull the account's copy first (answers and page layouts) before detecting anything
  if (window.Sync && (Sync.user || doc.shared)) { busy(true, doc.shared ? "Joining…" : "Syncing…"); await Sync.attach(doc).catch(e => console.warn(e)); }
  const need = [];
  for (let i = 0; i < pdf.numPages; i++) if (!doc.pages[i] || !doc.pages[i].regions) need.push(i);
  for (let k = 0; k < need.length; k++) {
    const i = need[k];
    busy(true, `Finding answer spaces… page ${i + 1} of ${pdf.numPages}`, k / need.length);
    doc.pages[i] = await detectPage(i, doc.pages[i]);
    emit("page:" + i);
  }
  if (doc.pages.some(P => P && P.cv !== CV)) await findChoices().catch(e => console.warn("choices", e));
  if (doc.pages.some(needsQuestions)) { busy(true, "Finding the questions…"); await findQuestions().catch(e => console.warn("questions", e)); }
  if (!doc.font) { const name = await detectFont().catch(() => ""); doc.font = { key: matchFont(name) || FONT_DEFAULT, auto: true, detected: name || "" }; emit("font"); }
  await applyFont(false); applyAnsStyle();
  busy(false);
  $("#home").hidden = true; $("#editor").hidden = false;
  $("#docName").textContent = doc.name; document.title = doc.name + " · TypePDF";
  buildViews();
  const v = loadView();
  setZoom(v && v.zr ? fitWidthZoom() * v.zr : fitWidthZoom());
  updateCount(); timerInit(); renderFlags(); fontMenu();
  sharedUI();
  if (v) restoreView(v);
  requestAnimationFrame(pageIndicator);
  if (!v || !v.tv || !v.tool || v.tool === "boxes") { setTool(deviceDefaultTool()); toolAuto = true; }
  if (fresh || need.length) scheduleSave();
  if (fresh) toast(`Found ${totalRegions()} answer spaces on ${pdf.numPages} pages. Use Boxes to add any that were missed.`, 5000);
  if (window.Sync) Sync.live();
}

// the font the paper is mostly printed in, by amount of text
async function detectFont() {
  const tally = {};
  for (let i = 0; i < Math.min(pdf.numPages, 4); i++) {
    const page = await pdf.getPage(i + 1);
    await page.getOperatorList();                       // loads the page's fonts so their names are known
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim() || /^\.+$/.test(it.str.trim())) continue;
      let name = ""; try { const f = page.commonObjs.get(it.fontName); name = (f && (f.name || f.loadedName)) || ""; } catch (e) {}
      if (!name) name = (tc.styles[it.fontName] || {}).fontFamily || "";
      tally[name] = (tally[name] || 0) + it.str.length;
    }
  }
  return Object.entries(tally).sort((a, b) => b[1] - a[1]).map(e => e[0]).find(n => matchFont(n)) || "";
}
async function applyFont(refit = true) {
  const key = doc.font && FONTS[doc.font.key] ? doc.font.key : FONT_DEFAULT;
  curFont = FONTS[key];
  $("#pages").style.setProperty("--ans-font", `"TP-${key}", "PaperSans", sans-serif`);
  await Promise.all([document.fonts.load(`12px "TP-${key}"`), document.fonts.load("12px PaperMono")]).catch(() => {});
  if (refit && views.length) { doc.pages.forEach((P, p) => { P.regions.forEach(r => { delete doc.fit[r.id]; }); layoutPage(p); P.regions.forEach(r => { if (doc.text[r.id]) queueFit(p, r); }); }); }
  fontMenu();
}
function fontMenu() {
  const s = $("#fontSel"); if (!s || !doc) return;
  const det = doc.font && doc.font.detected ? doc.font.detected.replace(/^[A-Z]{6}\+/, "").replace(/[-,].*$/, "") : "";
  const auto = matchFont(det) || FONT_DEFAULT;
  s.innerHTML = `<option value="auto">Match paper${det ? " (" + det + ")" : ""} → ${FONTS[auto].label}</option>` + Object.entries(FONTS).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join("");
  s.value = doc.font && !doc.font.auto ? doc.font.key : "auto";
}
// ---- how typed answers look: a colour, and optionally a highlight behind them or bold, to tell them apart from the question ----
const ANS_COLOURS = [["#111418", "Black"], ["#1f4fbf", "Blue"], ["#16357a", "Dark blue"], ["#c62a1f", "Red"], ["#1e7a3c", "Green"], ["#6b3fb3", "Purple"]];
const ANS_LOOKS = { plain: ["Plain", {}], hl: ["Highlighted", { bg: "#fff1a6" }], bold: ["Bold", { bold: true }], hlbold: ["Highlighted + bold", { bg: "#fff1a6", bold: true }], tint: ["Tinted box", { bg: "#e3edff" }] };
function ansStyle() { const st = (doc && doc.style) || {}; return { c: st.c || INK, look: ANS_LOOKS[st.look] ? st.look : "plain", ...(ANS_LOOKS[st.look] || ANS_LOOKS.plain)[1] }; }
function applyAnsStyle() {
  const st = ansStyle(), host = $("#pages");
  host.style.setProperty("--ink", st.c); host.style.setProperty("--ans-bg", st.bg || "transparent");
  host.classList.toggle("ans-bg", !!st.bg); host.classList.toggle("ans-bold", !!st.bold);
  const cs = $("#ansColSel"), ls = $("#ansLookSel");
  if (cs && !cs.options.length) { cs.innerHTML = ANS_COLOURS.map(([c, n]) => `<option value="${c}">${n} answers</option>`).join(""); ls.innerHTML = Object.entries(ANS_LOOKS).map(([k, [n]]) => `<option value="${k}">${n}</option>`).join(""); }
  if (cs) { cs.value = st.c; if (cs.value !== st.c) cs.value = INK; ls.value = st.look; }
}
function setAnsStyle(patch) { doc.style = { ...(doc.style || {}), ...patch }; applyAnsStyle(); emit("style"); scheduleSave(); }
$("#ansColSel").addEventListener("change", e => setAnsStyle({ c: e.target.value }));
$("#ansLookSel").addEventListener("change", e => setAnsStyle({ look: e.target.value }));
$("#fontSel").addEventListener("change", e => {
  const v = e.target.value, det = (doc.font && doc.font.detected) || "";
  doc.font = v === "auto" ? { key: matchFont(det) || FONT_DEFAULT, auto: true, detected: det } : { key: v, auto: false, detected: det };
  applyFont(); emit("font"); scheduleSave();
});

async function detectPage(i, prev) {
  const page = await pdf.getPage(i + 1);
  const vp = page.getViewport({ scale: 1 });
  const vp2 = page.getViewport({ scale: Detect.S });
  const c = document.createElement("canvas"); c.width = Math.ceil(vp2.width); c.height = Math.ceil(vp2.height);
  const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp2 }).promise;
  let tc = null; try { tc = await page.getTextContent(); } catch (e) {}
  const res = Detect.page(c, vp, tc);
  // a scanned / image-only page has no text to read question numbers from: read the left margin instead
  if (!res.hasText) { try { res.items = await ocrMargin(c, vp); res.ocr = true; } catch (e) { console.warn("OCR failed", e); } }
  c.width = c.height = 0;
  res.regions.forEach((r, k) => r.id = `${i}:${k}`);
  return { w: vp.width, h: vp.height, rot: page.rotate || 0, regions: res.regions, items: res.items, hasText: res.hasText, ocr: !!res.ocr, cv: CV, gaps: (prev && prev.gaps) || {} };
}
// ---- reading question numbers off image-only papers (Tesseract, bundled and only loaded when needed) ----
let ocrWorkerP = null;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("couldn't load " + src)); document.head.appendChild(s); }); }
function ocrWorker() {
  return ocrWorkerP || (ocrWorkerP = (async () => {
    if (!window.Tesseract) await loadScript("lib/ocr/tesseract.min.js");
    const base = new URL("lib/ocr/", location.href).href;
    const w = await Tesseract.createWorker("eng", 1, { workerPath: base + "worker.min.js", corePath: base, langPath: base, gzip: true, logger: () => {} });
    await w.setParameters({ tessedit_pageseg_mode: "11" });   // sparse text; a whitelist on mixed text merges words, so only the digit pass uses one
    return w;
  })().catch(e => { ocrWorkerP = null; throw e; }));
}
// canvas: the page rendered at Detect.S px/pt. Returns text items like the PDF text layer gives ({s, x, y = baseline, x1}, in pt)
async function ocrMargin(canvas, vp) {
  const S = Detect.S, W = Math.min(canvas.width, Math.round(170 * S));
  const k = 1.5, c = document.createElement("canvas"); c.width = Math.round(W * k); c.height = Math.round(canvas.height * k);
  const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(canvas, 0, 0, W, canvas.height, 0, 0, c.width, c.height);
  const w = await ocrWorker();
  const words = (data, f, dx = 0) => { const o = []; for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const wd of l.words || []) o.push({ t: (wd.text || "").trim(), c: wd.confidence, x: wd.bbox.x0 * f + dx, y: wd.bbox.y1 * f, x1: wd.bbox.x1 * f + dx }); return o; };
  await w.setParameters({ tessedit_pageseg_mode: "11", tessedit_char_whitelist: "" });
  const all = words((await w.recognize(c, {}, { blocks: true, text: false })).data, 1 / (S * k));
  c.width = 0;
  // second look at the column where question numbers sit: each blob of ink there is cut out with a white border
  // and read as one number (a lone bold digit on a blank strip is easily missed otherwise)
  const nums = [], x0 = 25, x1 = 68;
  const px = canvas.getContext("2d").getImageData(Math.round(x0 * S), 0, Math.round((x1 - x0) * S), canvas.height), PW = px.width;
  const rowInk = y => { let n = 0; for (let x = 0; x < PW; x++) if (px.data[(y * PW + x) * 4] < 120) n++; return n; };
  const bands = []; let start = -1, gap = 0;
  for (let y = 0; y < px.height; y++) { if (rowInk(y)) { if (start < 0) start = y; gap = 0; } else if (start >= 0 && ++gap > 3) { bands.push([start, y - gap]); start = -1; } }
  await w.setParameters({ tessedit_pageseg_mode: "8", tessedit_char_whitelist: "0123456789" });
  for (const [a, b] of bands) {
    const h = (b - a + 1) / S; if (h < 5 || h > 30) continue;
    let lo = PW, hi = -1; for (let y = a; y <= b; y++) for (let x = 0; x < PW; x++) if (px.data[(y * PW + x) * 4] < 120) { if (x < lo) lo = x; if (x > hi) hi = x; }
    if (hi < 0 || (hi - lo) / S > 22) continue;                       // too wide to be a question number
    const K = 4, pad = 24, cw = (hi - lo + 1) * K + pad * 2, ch = (b - a + 1) * K + pad * 2, c3 = document.createElement("canvas"); c3.width = cw; c3.height = ch;
    const g3 = c3.getContext("2d"); g3.fillStyle = "#fff"; g3.fillRect(0, 0, cw, ch); g3.imageSmoothingQuality = "high";
    g3.drawImage(canvas, Math.round(x0 * S) + lo, a, hi - lo + 1, b - a + 1, pad, pad, (hi - lo + 1) * K, (b - a + 1) * K);
    const r = (await w.recognize(c3)).data; c3.width = 0;
    const t = (r.text || "").trim();
    if (/^\d{1,2}$/.test(t) && r.confidence >= 40) nums.push({ t, c: r.confidence, x: x0 + lo / S, y: (b + 1) / S, x1: x0 + (hi + 1) / S });
  }
  await w.setParameters({ tessedit_char_whitelist: "" });
  const out = all.filter(o => o.t && o.c >= 60);
  for (const n of nums) if (/^\d{1,2}$/.test(n.t) && n.c >= 50 && !out.some(o => Math.abs(o.y - n.y) < 4 && o.x < n.x1 + 2 && o.x1 > n.x - 2)) out.push(n);
  return out.map(o => ({ s: o.t, x: +o.x.toFixed(1), y: +o.y.toFixed(1), x1: +o.x1.toFixed(1) })).sort((a, b) => a.y - b.y || a.x - b.x);
}
// papers opened before OCR existed: read their margins now (once), e.g. before an AI export
async function ensureOcr() {
  const need = doc.pages.map((P, p) => (!P.hasText && !P.ocr && !(P.items && P.items.length)) ? p : -1).filter(p => p >= 0);
  if (!need.length) return;
  try {
    for (let k = 0; k < need.length; k++) {
      const p = need[k]; busy(true, `Reading question numbers… page ${p + 1}`, k / need.length);
      const page = await pdf.getPage(p + 1), vp2 = page.getViewport({ scale: Detect.S });   // the printed page as is (no added space)
      const c = document.createElement("canvas"); c.width = Math.ceil(vp2.width); c.height = Math.ceil(vp2.height);
      const cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height); await page.render({ canvasContext: cx, viewport: vp2 }).promise;
      doc.pages[p].items = await ocrMargin(c, page.getViewport({ scale: 1 })); doc.pages[p].ocr = true; c.width = 0; delete doc.pages[p].qs;
      emit("page:" + p);
    }
    await findQuestions(); doc.pages.forEach((P, p) => { layoutPage(p); });
    scheduleSave();
  } catch (e) { toast("Couldn't read the question numbers from this paper's images: " + (e.message || e), 5000); }
  busy(false);
}

// ---------------- shared papers: joining, who's here, locks, and the owner's Share panel ----------------
const PALETTE = ["#d1495b", "#2e86ab", "#e09f3e", "#6a4c93", "#3a7d44", "#c45ab3", "#1b998b", "#8f5c38"];
const colourFor = id => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };
async function joinShared(code, name) {
  busy(true, "Joining…");
  try {
    const j = await Sync.share.join(code, name);
    if (j.own) { busy(false); toast("That's your own paper, so it's opened from your library."); const m = (Home.entries || []).find(e => e.id === j.doc); return openStored(j.doc, m); }
    await openSharedFrom(j);
  } catch (e) { busy(false); toast(e.message, 5000); }
}
async function openSharedFrom(j) {
  busy(true, "Opening the shared paper…");
  if (doc) await showHome(true);
  const bytes = await Sync.share.pdf(j.pass);
  const d = newDoc(j.doc, j.pdf, j.name || "Shared paper", bytes);
  d.shared = { pass: j.pass, role: j.role, pid: j.pid, me: j.me, exp: Date.now() + 11.5 * 3600e3 };
  await openDoc(d);
  toast(j.role === "view" ? `You've joined "${d.name}" to view it.` : `You've joined "${d.name}". Everyone's changes appear live.`, 4000);
}
function sharedUI() {
  const sh = doc && doc.shared, view = sh && sh.role === "view";
  $("#shareBtn").hidden = !(window.Sync && Sync.user && doc && !sh);
  $("#editor").classList.toggle("viewonly", !!view);
  $$(".tool,.sw,.sz,#undo,#redo,#fontSel,#ansColSel,#ansLookSel,#timerBtn,#flagsBtn").forEach(b => { b.disabled = !!view; });
  if (view) { setTool("text"); toast("View only: you can see changes live but not edit.", 3500); }
}
window.onPeople = (people, mySid) => {
  if (!doc) return;
  // the bar: everyone else who's here
  const bar = $("#peopleBar"); bar.innerHTML = "";
  const others = people.filter(p => p.sid !== mySid);
  const seen = new Set();
  for (const p of others) {
    const key = p.pid === "owner" ? "owner" : p.pid; if (seen.has(key)) continue; seen.add(key);
    const b = document.createElement("span"); b.className = "avatar"; b.style.background = colourFor(key);
    const nm = p.pid === "owner" && !doc.shared ? "You (another device)" : p.name + (p.role === "view" ? " (viewing)" : p.role === "owner" ? " (owner)" : "");
    b.textContent = (p.name || "?").trim().slice(0, 1).toUpperCase(); b.title = nm; bar.appendChild(b);
  }
  // boxes someone else is typing in: locked, outlined in their colour with their name
  const held = new Map(others.filter(p => p.focus).map(p => [p.focus, p]));
  doc.pages.forEach((P, pi) => P.regions.forEach(r => {
    const ta = r._el; if (!ta) return;
    const h = held.get(r.id), was = ta.classList.contains("locked");
    if (h) {
      const key = h.pid === "owner" ? "owner" : h.pid, name = h.pid === "owner" && !doc.shared ? "You (another device)" : h.name;
      ta.classList.add("locked"); ta.readOnly = true; ta.dataset.lockedBy = name; ta.style.setProperty("--lock", colourFor(key));
      let tag = r._lockTag; if (!tag) { tag = r._lockTag = document.createElement("span"); tag.className = "locktag"; }
      if (tag.parentElement !== views[pi].el) views[pi].el.appendChild(tag);
      tag.textContent = name + " is typing"; tag.style.background = colourFor(key); tag.style.left = ta.style.left; tag.style.top = (parseFloat(ta.style.top) - 16) + "px";
      if (document.activeElement === ta) ta.blur();
    } else if (was) {
      ta.classList.remove("locked"); ta.readOnly = !!(doc.shared && doc.shared.role === "view"); delete ta.dataset.lockedBy; if (r._lockTag) { r._lockTag.remove(); r._lockTag = null; }
    }
  }));
  if ($("#shareDlg").open) refreshPeople();
};
window.onLocked = (rid, by) => { const r = findRegion(rid); if (r && r._el && document.activeElement === r._el) r._el.blur(); toast(`${by} is typing there right now.`); };
// the owner's Share panel
const fmtCode = c => c ? c.slice(0, 4) + "-" + c.slice(4) : "…";
async function openShare() {
  $("#shareErr").textContent = ""; $("#codeEdit").textContent = $("#codeView").textContent = "…"; $("#shareDlg").showModal();
  try { const c = await Sync.share.codes(doc.id); $("#codeEdit").textContent = fmtCode(c.edit); $("#codeView").textContent = fmtCode(c.view); } catch (e) { $("#shareErr").textContent = e.message; }
  refreshPeople();
}
async function refreshPeople() {
  const ul = $("#sharePeople");
  try {
    const { people } = await Sync.share.people(doc.id);
    const list = people.filter(p => !p.removed);
    ul.innerHTML = list.length ? "" : '<li class="note">Nobody has joined yet.</li>';
    for (const p of list) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="avatar"></span><span class="pname"></span><span class="pmeta"></span><button type="button" class="danger">Remove</button>`;
      $(".avatar", li).style.background = colourFor(p.pid); $(".avatar", li).textContent = (p.name || "?").slice(0, 1).toUpperCase();
      $(".pname", li).textContent = p.name + (p.email ? "" : " (guest)");
      $(".pmeta", li).textContent = (p.role === "view" ? "View only" : "Can edit") + (p.online ? " · here now" : "");
      $("button", li).onclick = async () => { try { await Sync.share.remove(doc.id, p.pid); toast(`${p.name} was removed.${p.email ? "" : " To stop them joining again, make new codes."}`, 5000); refreshPeople(); } catch (e) { $("#shareErr").textContent = e.message; } };
      ul.appendChild(li);
    }
  } catch (e) { $("#shareErr").textContent = e.message; }
}
$("#shareBtn").onclick = openShare;
$("#shareClose").onclick = () => $("#shareDlg").close();
$("#shareReset").onclick = async () => {
  if (!confirm("Make new codes? The current codes stop working for anyone new.")) return;
  try { const c = await Sync.share.reset(doc.id); $("#codeEdit").textContent = fmtCode(c.edit); $("#codeView").textContent = fmtCode(c.view); toast("New codes made. The old ones no longer work."); } catch (e) { $("#shareErr").textContent = e.message; }
};
$$("#shareDlg [data-copy]").forEach(b => b.onclick = async () => { const t = $("#" + b.dataset.copy).textContent; try { await navigator.clipboard.writeText(t); toast("Code copied."); } catch (e) { fallbackCopy(t); } });
$("#joinForm").addEventListener("submit", e => {
  e.preventDefault();
  const code = $("#joinCode").value.toUpperCase().replace(/[^A-Z0-9]/g, ""), name = $("#joinName").value.trim();
  if (code.length !== 8) { toast("Share codes are 8 letters and numbers, like ABCD-2345."); return; }
  if (!(window.Sync && Sync.user) && !name) { toast("Type your name so the others know who you are."); $("#joinName").focus(); return; }
  try { localStorage.setItem("joinName", name); } catch (err) {}
  joinShared(code, name);
});
try { $("#joinName").value = localStorage.getItem("joinName") || ""; } catch (e) {}

// ---------------- corner handles on the answer you're typing in: drag to resize on the go ----------------
let handFor = null;   // {p, r}
function showHandles(p, r) { handFor = { p, r }; placeHandles(); }
function hideHandles() { handFor = null; $$(".rh").forEach(h => h.hidden = true); }
function placeHandles() {
  if (!handFor) return;
  const { p, r } = handFor, v = views[p]; if (!v || boxMode) { $$(".rh").forEach(h => h.hidden = true); return; }
  let hs = $$(".rh");
  if (!hs.length) {
    hs = ["nw", "ne", "sw", "se"].map(c => { const h = document.createElement("div"); h.className = "rh " + c; h.dataset.c = c; h.title = "Drag to resize this answer space"; h.addEventListener("pointerdown", handleDrag); return h; });
  }
  // sit on the corners of the highlighted box you see
  const ta = r._el, L = ta.offsetLeft, T = ta.offsetTop, W = ta.offsetWidth, H = ta.offsetHeight;
  for (const h of hs) {
    if (h.parentElement !== v.el) v.el.appendChild(h);
    const c = h.dataset.c; h.hidden = false;
    h.style.left = (c[1] === "w" ? L + (c === "nw" && ta.classList.contains("notch") ? r._notch || 0 : 0) : L + W) + "px";
    h.style.top = (c[0] === "n" ? T : T + H) + "px";
  }
}
function handleDrag(e) {
  if (!handFor) return;
  e.preventDefault(); e.stopPropagation();          // keeps the text box focused
  const { p, r } = handFor, v = views[p], ta = r._el, c = e.currentTarget.dataset.c;
  e.currentTarget.setPointerCapture(e.pointerId);
  const b = v.el.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
  setGap(p, r, 0);
  const o = { x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1 };
  const P = doc.pages[p];
  const mv = ev => {
    const dx = (ev.clientX - x0) / zoom, dy = (ev.clientY - y0) / zoom;
    let nx0 = o.x0, nx1 = o.x1, ny0 = o.y0, ny1 = o.y1;
    if (c[1] === "w") nx0 = clamp(o.x0 + dx, 0, o.x1 - 12); else nx1 = clamp(o.x1 + dx, o.x0 + 12, P.w);
    if (c[0] === "n") ny0 = clamp(o.y0 + dy, 0, o.y1 - 8); else ny1 = clamp(o.y1 + dy, o.y0 + 8, P.h);
    setRegionRect(p, r, nx0, ny0, nx1, ny1);
    applyFieldNoGap(p, r, fitOf(r)); layoutPage(p); placeHandles();
  };
  const up = ev => {
    window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
    delete doc.fit[r.id]; queueFit(p, r); pageChanged(p);
    if (document.activeElement !== ta) ta.focus({ preventScroll: true });
    requestAnimationFrame(placeHandles);
  };
  window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
}
// ---------------- book view: two pages side by side ----------------
let bookView = false;
try { bookView = localStorage.getItem("bookView") === "1"; } catch (e) {}
function applyBook() { $("#pages").classList.toggle("book", bookView); $("#bookBtn").classList.toggle("on", bookView); }
applyBook();
$("#bookBtn").onclick = () => {
  if (!doc) return;
  const keep = currentPage(); bookView = !bookView; applyBook();
  try { localStorage.setItem("bookView", bookView ? "1" : "0"); } catch (e) {}
  setZoom(fitWidthZoom());
  requestAnimationFrame(() => { const v = views[keep]; if (v) $("#pages").scrollTop = v.el.offsetTop - 12; pageIndicator(); saveView(); });
};
// ---------------- remembering exactly where you were ----------------
function saveView() {
  if (!doc || $("#editor").hidden) return;
  const host = $("#pages"); let p = 0; views.forEach((v, i) => { if (v.el.offsetTop <= host.scrollTop + 4) p = i; });
  const off = views[p] ? (host.scrollTop - views[p].el.offsetTop) / zoom : 0;
  const a = document.activeElement; const foc = a && a.classList && a.classList.contains("ans") ? { rid: a.dataset.rid, s: a.selectionStart, e: a.selectionEnd } : null;
  try { localStorage.setItem("view:" + doc.id, JSON.stringify({ zr: zoom / fitWidthZoom(), p, off, tool, tv: 2, toolAuto, colour, width, foc, hints: $("#pages").classList.contains("hints") })); } catch (e) {}
}
function loadView() { try { return JSON.parse(localStorage.getItem("view:" + doc.id) || "null"); } catch (e) { return null; } }
function restoreView(v) {
  if (v.tv && v.tool && v.tool !== "boxes") { setTool(v.tool); toolAuto = !!v.toolAuto; }   // views saved before the Text/Pen/Smart split fall back to the device default
  if (v.colour) { colour = v.colour; $$(".sw").forEach(x => x.classList.toggle("on", x.dataset.c === colour)); }
  if (v.width) { width = v.width; $$(".sz").forEach(x => x.classList.toggle("on", +x.dataset.w === width)); }
  if (v.hints) { $("#pages").classList.add("hints"); $("#hintBtn").classList.add("on"); }
  requestAnimationFrame(() => {
    const host = $("#pages"); const pv = views[clamp(v.p | 0, 0, views.length - 1)];
    if (pv) host.scrollTop = pv.el.offsetTop + (v.off || 0) * zoom;
    if (v.foc) { const r = findRegion(v.foc.rid); if (r && r._el) { r._el.focus({ preventScroll: true }); try { r._el.setSelectionRange(v.foc.s, v.foc.e); } catch (e) {} } }
  });
}
let viewT; $("#pages").addEventListener("scroll", () => { clearTimeout(viewT); viewT = setTimeout(saveView, 400); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { saveView(); saveNow(); } });
window.addEventListener("pagehide", () => { saveView(); });
function findRegion(id) { for (const P of doc.pages) { const r = P && P.regions.find(q => q.id === id); if (r) return r; } return null; }

// ---------------- question markers: a box over each printed question number and part ----------------
// found from the text (with font sizes) of every page together, since the numbering runs across pages.
// Only pages without markers get them, so markers someone has fixed in the Boxes tool are kept.
const CV = 2;   // version of the multiple-choice finder (pages looked at by an older one are looked at again)
// multiple-choice boxes and ovals on pages detected before they were looked for: render each page once and look
async function findChoices() {
  const need = doc.pages.map((P, p) => P && P.cv !== CV ? p : -1).filter(p => p >= 0);
  for (let k = 0; k < need.length; k++) {
    const p = need[k], P = doc.pages[p];
    busy(true, `Looking for multiple-choice boxes… page ${p + 1}`, k / need.length);
    try {
      const page = await pdf.getPage(p + 1), vp = page.getViewport({ scale: 1 }), vp2 = page.getViewport({ scale: Detect.S });
      const c = document.createElement("canvas"); c.width = Math.ceil(vp2.width); c.height = Math.ceil(vp2.height);
      const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp2 }).promise;
      let items = []; try { items = Detect.textItems(await page.getTextContent(), vp); } catch (e) {}
      const found = Detect.choices(Detect.grey(ctx.getImageData(0, 0, c.width, c.height)), items); c.width = c.height = 0;
      for (const ch of found) {
        if (P.regions.some(r => r.kind === "choice" && r.x0 < ch.x1 && r.x1 > ch.x0 && r.y0 < ch.y1 && r.y1 > ch.y0)) continue;
        // a tiny empty cell found on the same spot was really this box
        P.regions = P.regions.filter(r => !(r.kind !== "lines" && !doc.text[r.id] && r.x0 < ch.x1 && r.x1 > ch.x0 && r.y0 < ch.y1 && r.y1 > ch.y0 && r.x1 - r.x0 < 40 && r.y1 - r.y0 < 36));
        P.regions.push({ id: `${p}:c${rid8()}`, kind: "choice", x0: +ch.x0.toFixed(1), y0: +ch.y0.toFixed(1), x1: +ch.x1.toFixed(1), y1: +ch.y1.toFixed(1), shape: ch.shape, opt: ch.opt || "", ...(ch.mark ? { mark: ch.mark } : {}), cut: +ch.y1.toFixed(1) + 3 });
      }
    } catch (e) { console.warn(e); }
    P.cv = CV; if (canEdit()) emit("page:" + p);
  }
}
const QV = 2;   // version of the question finder: pages found by an older one are looked at again
const needsQuestions = P => !!P && (!Array.isArray(P.qs) || P.qv !== QV);
// each text item with whether its font is bold or monospace (question numbers are nearly always bold;
// line numbers in code listings are monospace)
async function textWithFonts(i) {
  const page = await pdf.getPage(i + 1), vp = page.getViewport({ scale: 1 });
  await page.getOperatorList();                                         // loads the fonts so their names are known
  const tc = await page.getTextContent(), fonts = {};
  const fontOf = fn => fonts[fn] || (fonts[fn] = (() => {
    let f = null; try { f = page.commonObjs.get(fn); } catch (e) {}
    const name = ((f && (f.name || f.loadedName)) || "") + " " + ((tc.styles[fn] || {}).fontFamily || "");
    return { b: !!(f && (f.bold || f.black)) || /bold|black|heavy|semibold|demi/i.test(name), mo: !!(f && f.isMonospace) || /courier|mono|consol|menlo|typewriter/i.test(name) };
  })());
  const out = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const t = Detect.textItems({ items: [it] }, vp)[0]; if (!t) continue;
    const f = fontOf(it.fontName);
    out.push({ s: t.str, x: +t.x.toFixed(1), y: +t.base.toFixed(1), x1: +t.x1.toFixed(1), h: +t.fh.toFixed(1), b: f.b, mo: f.mo });
  }
  return out;
}
// question markers for every page that needs them, found from the text of the whole paper together (the numbering
// runs across pages). Markers someone has fixed in the Boxes tool are kept.
async function findQuestions() {
  const pages = [];
  for (let i = 0; i < doc.pages.length; i++) {
    const P = doc.pages[i]; if (!P) { pages.push(null); continue; }
    let items = P.items || [];
    if (P.hasText && pdf) { try { items = await textWithFonts(i); } catch (e) { console.warn(e); } }
    pages.push({ w: P.w, h: P.h, items });
  }
  const found = Questions.detect(pages);
  doc.pages.forEach((P, p) => { if (needsQuestions(P)) { P.qs = found[p] || []; P.qv = QV; if (canEdit()) emit("page:" + p); } });
}
const canEdit = () => !(doc && doc.shared && doc.shared.role === "view");
function markerRect(p, m) { return { x0: m.x0, x1: m.x1, y0: disp(p, m.y0), y1: disp(p, m.y1) }; }
function drawMarkers(p) {
  const v = views[p], P = doc.pages[p]; if (!v) return;
  $$(".qmark", v.el).forEach(e => e.remove());
  if (boxMode) return;                                                  // the Boxes tool draws them itself, editable
  const lab = new Map(labelIndex().filter(e => e.p === p).map(e => [e.m, e.label]));
  for (const m of P.qs || []) {
    const R = markerRect(p, m), d = document.createElement("div");
    d.className = "qmark"; d.dataset.qid = m.id; d.title = "Question " + (lab.get(m) || m.tok);
    Object.assign(d.style, { left: R.x0 * zoom + "px", top: R.y0 * zoom + "px", width: (R.x1 - R.x0) * zoom + "px", height: (R.y1 - R.y0) * zoom + "px" });
    v.el.appendChild(d);
  }
}

// ---------------- geometry: page extension ("gaps") ----------------
function gapList(p) {
  const P = doc.pages[p];
  return Object.entries(P.gaps || {}).map(([rid, h]) => { const r = P.regions.find(q => q.id === rid); return r && h > 0 ? { rid, at: r.cut ?? r.y1, h } : null; }).filter(Boolean).sort((a, b) => a.at - b.at);
}
function disp(p, y) { let d = y; for (const g of gapList(p)) if (g.at < y - 0.01) d += g.h; return d; }
function src(p, d) { let off = 0; for (const g of gapList(p)) { const s = g.at + off; if (d <= s) break; if (d < s + g.h) return g.at; off += g.h; } return d - off; }
function totalGap(p) { return gapList(p).reduce((s, g) => s + g.h, 0); }
function regionRect(p, r) { const top = disp(p, r.y0), extra = (doc.pages[p].gaps || {})[r.id] || 0; return { x0: r.x0, x1: r.x1, y0: top, y1: extra ? disp(p, r.cut ?? r.y1) + extra : disp(p, r.y1) }; }
// ink is stored against the printed page, so it stays put when extra space opens or closes above it.
// a point is [x, y] in page points, or [x, offset, regionId] when it sits in a region's extra space.
function toAnchor(p, x, yd) {
  let off = 0;
  for (const g of gapList(p)) { const s = g.at + off; if (yd < s) break; if (yd < s + g.h) return [r2(x), r2(yd - s), g.rid]; off += g.h; }
  return [r2(x), r2(yd - off)];
}
function toDisp(p, pt) {
  if (pt.length < 3) return [pt[0], disp(p, pt[1])];
  const g = gapList(p).find(q => q.rid === pt[2]);
  if (g) return [pt[0], disp(p, g.at) + Math.min(pt[1], g.h)];
  const r = doc.pages[p].regions.find(q => q.id === pt[2]);
  return [pt[0], r ? disp(p, r.cut ?? r.y1) + pt[1] : pt[1]];
}
const r2 = n => Math.round(n * 100) / 100;
function setGap(p, r, h) {
  const P = doc.pages[p]; P.gaps = P.gaps || {};
  const old = P.gaps[r.id] || 0; h = Math.round(h * 10) / 10;
  if (Math.abs(old - h) < 0.5) return false;
  if (h > 0) P.gaps[r.id] = h; else delete P.gaps[r.id];
  layoutPage(p);
  return true;
}

// ---------------- views ----------------
let io;
function buildViews() {
  clearInkSel(); if (selOp) cancelSelOp();
  const host = $("#pages"); host.innerHTML = ""; views = [];
  io && io.disconnect();
  io = new IntersectionObserver(ents => {
    for (const e of ents) { const v = views[+e.target.dataset.p]; if (!v) continue; v.visible = e.isIntersecting; if (v.visible) renderPage(+e.target.dataset.p); else dropBitmap(+e.target.dataset.p); }
  }, { root: host, rootMargin: "1600px 0px" });
  doc.pages.forEach((P, p) => {
    const el = document.createElement("div"); el.className = "page"; el.dataset.p = p;
    const pg = document.createElement("canvas"); pg.className = "pg";
    const ink = document.createElement("canvas"); ink.className = "ink";
    const pno = document.createElement("div"); pno.className = "pno"; pno.textContent = `${p + 1}`;
    el.append(pg, ink, pno);
    host.appendChild(el);
    const v = { el, pg, ink, bm: null, bmZoom: 0, visible: false, gapEls: [] };
    views.push(v);
    P.regions.forEach(r => makeField(p, r));
    bindInk(p, v); toolClass(v);
    io.observe(el);
  });
  host.onscroll = pageIndicator;
  pageIndicator();
}

function makeField(p, r) {
  const v = views[p];
  if (r.kind === "choice") {
    const b = document.createElement("button"); b.type = "button";
    b.className = "choice " + (r.shape === "oval" ? "oval" : "box") + (Array.isArray(r.mark) ? " inbox" : ""); b.dataset.rid = r.id;
    b.title = r.opt ? "Choose: " + r.opt : "Choose this answer"; b.setAttribute("aria-label", b.title);
    b.addEventListener("pointerdown", e => { if (e.pointerType === "pen") sawPen(); e.stopPropagation(); });
    b.addEventListener("click", e => { e.preventDefault(); toggleChoice(p, r); });
    if (doc.shared && doc.shared.role === "view") b.disabled = true;
    if (r.shape === "oval") { const d = document.createElement("i"); d.className = "dot"; const m = choiceMark(r); Object.assign(d.style, { left: m[0] * 100 + "%", top: m[1] * 100 + "%", width: (m[2] - m[0]) * 100 + "%", height: (m[3] - m[1]) * 100 + "%" }); b.appendChild(d); }
    v.el.appendChild(b); r._el = b; paintChoice(r);
    return;
  }
  const ta = document.createElement("textarea");
  ta.className = "ans " + r.kind + (r.code ? " code" : "");
  codeAttrs(ta, r.code);
  ta.dataset.rid = r.id; ta.value = doc.text[r.id] || "";
  ta.setAttribute("aria-label", "Answer space" + (r.label && r.label !== "label" ? " " + r.label : ""));
  ta.addEventListener("input", () => { if (!r.code && !r.codeSet && looksLikeCode(ta.value)) { setCode(p, r, true, false); toast("This looks like code, so this space is now in code mode: no capitals or corrections, Tab indents. Press </> Code to switch back.", 5000); } if (ta.value) doc.text[r.id] = ta.value; else delete doc.text[r.id]; queueFit(p, r); updateCount(); scheduleSave(); emit("text:" + r.id); });
  ta.addEventListener("keydown", e => fieldKeys(e, p, r, ta));
  ta.addEventListener("focus", () => {
    if (ta.classList.contains("locked")) { const by = ta.dataset.lockedBy || "Someone"; ta.blur(); toast(`${by} is typing here right now.`); return; }
    showFlagFloat(p, r); showHandles(p, r); if (window.Sync) Sync.focus(r.id);
  });
  ta.addEventListener("blur", () => { if (window.Sync) Sync.focus(null); setTimeout(() => { if (!document.activeElement || !document.activeElement.classList.contains("ans")) { hideFlagFloat(); hideHandles(); } }, 150); });
  if (doc.shared && doc.shared.role === "view") { ta.readOnly = true; ta.tabIndex = -1; }
  v.el.insertBefore(ta, v.ink);
  r._el = ta;
}

function fieldKeys(e, p, r, ta) {
  if (e.key === "Escape") { ta.blur(); return; }
  if (r.code && e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    // a new line keeps the indentation, and goes one step further in after ":" "{" "then" or "do"
    e.preventDefault();
    const s = ta.selectionStart, v = ta.value, ls = v.lastIndexOf("\n", s - 1) + 1, line = v.slice(ls, s);
    let ind = (line.match(/^[ \t]*/) || [""])[0];
    if (/(:|\{|\bthen|\bdo)\s*$/i.test(line)) ind += "    ";
    ta.setRangeText("\n" + ind, s, ta.selectionEnd, "end"); ta.dispatchEvent(new Event("input")); return;
  }
  if (e.key === "Tab") {
    if (r.code && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const s = ta.selectionStart, en = ta.selectionEnd, v = ta.value;
      const ls = v.lastIndexOf("\n", s - 1) + 1;
      if (en > s && v.slice(s, en).includes("\n")) {
        // several lines selected: indent or outdent every one of them
        const le = v.indexOf("\n", en - 1) < 0 ? v.length : v.indexOf("\n", en - (v[en - 1] === "\n" ? 1 : 0));
        const lines = v.slice(ls, le).split("\n").map(l => e.shiftKey ? l.replace(/^ {1,4}|^\t/, "") : "    " + l);
        const t = lines.join("\n"); ta.setRangeText(t, ls, le, "select");
      } else if (e.shiftKey) { const m = v.slice(ls).match(/^ {1,4}/); if (m) ta.setRangeText("", ls, ls + m[0].length, "preserve"); }
      else ta.setRangeText("    ", s, en, "end");
      ta.dispatchEvent(new Event("input")); return;
    }
    e.preventDefault(); focusNext(r, e.shiftKey ? -1 : 1); return;
  }
  if (e.key === "Enter" && r.kind === "cell" && !e.shiftKey) { e.preventDefault(); focusNext(r, 1); }
}
// ---- code mode: monospace, no auto-capitals, autocorrect or spellcheck, Tab indents ----
function codeAttrs(ta, on) {
  ta.classList.toggle("code", !!on);
  ta.spellcheck = !on; ta.autocapitalize = on ? "off" : "sentences";
  ta.setAttribute("autocorrect", on ? "off" : "on"); ta.setAttribute("autocomplete", "off");
}
function setCode(p, r, on, byHand) {
  r.code = !!on; if (byHand) r.codeSet = true;
  codeAttrs(r._el, r.code);
  delete doc.fit[r.id]; queueFit(p, r); pageChanged(p); placeFlagFloat();
  if (boxMode) updateSelTools();
}
// typed text that is clearly code: a line that is plainly a statement, or several code-looking lines
function looksLikeCode(v) {
  if (!v || v.length < 6) return false;
  const lines = v.split("\n").filter(l => l.trim());
  const strong = /^\s*(def |function |procedure |for \w+ ?(=|in )|while .*[<>=!]|if .*(==|!=|<=|>=|[<>]|\bthen\b)|else:|elif |endif|endwhile|next \w|print\(|return\b|var |let |const |public |private |int \w+ ?=|string \w+ ?=|SELECT\b.+\bFROM\b|INSERT INTO|UPDATE \w+ SET|DELETE FROM|CREATE TABLE|<\/?[a-z]+[ >])/;
  if (lines.some(l => strong.test(l))) return true;
  const codeish = /([{};]\s*$|^\s{2,}\S|\w+\[\w*\]|\w+\([^)]*\)\s*$|^\s*\w+\s*(=|\+=|-=|\+\+)\s*\S|==|!=|<=|>=|\/\/)/;
  return lines.length >= 2 && lines.filter(l => codeish.test(l)).length >= 2;
}
function orderedRegions(withChoices) { const out = []; doc.pages.forEach((P, p) => [...P.regions].filter(r => withChoices || r.kind !== "choice").sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0).forEach(r => out.push([p, r]))); return out; }
// ---- multiple choice: click a box or oval to choose it (as many as you like); click again to un-choose ----
function toggleChoice(p, r) {
  if (doc.shared && doc.shared.role === "view") return;
  if (doc.text[r.id]) delete doc.text[r.id]; else doc.text[r.id] = "x";
  paintChoice(r); updateCount(); scheduleSave(); emit("text:" + r.id);
}
// the part of a choice that's filled in: the capsule inside AQA's answer box, or the oval itself (slightly inset)
function choiceMark(r) { return Array.isArray(r.mark) && r.mark.length === 4 ? r.mark : [0.16, 0.16, 0.84, 0.84]; }
function paintChoice(r) { const b = r._el; if (!b) return; const on = !!doc.text[r.id]; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false"); }
function focusNext(r, dir) {
  const all = orderedRegions(); const i = all.findIndex(([q, s]) => s === r); const n = all[i + dir]; if (!n) return;
  const ta = n[1]._el; ta.focus({ preventScroll: true }); const L = ta.value.length; ta.setSelectionRange(L, L);
  // glide to the next space (rather than jumping) so you can see everything you pass on the way
  const host = $("#pages"), target = readableScroll(n[0], n[1]);
  if (dir > 0) glideTo(host, target);                 // Tab glides forward
  else { cancelAnimationFrame(glideRaf); host.scrollTop = target; }   // Shift+Tab jumps straight back
}
// where to scroll so an answer space can be typed in with its question still readable above it: the printed
// wording between the previous answer space and this one starts near the top of the screen, and the box sits
// below it (but never so low that the box itself is pushed off the bottom)
function questionTop(p, r) {
  const P = doc.pages[p];
  const prev = P.regions.filter(q => q !== r && q.y1 <= r.y0 + 1 && q.x0 < r.x1 && q.x1 > r.x0).reduce((m, q) => Math.max(m, q.y1), 0);
  const its = (P.items || []).filter(it => it.y > prev + 1 && it.y < r.y0 + 4 && it.s && it.s.trim() && !/^\.+$/.test(it.s.trim()));
  let top = its.length ? Math.min(...its.map(it => it.y)) - 12 : r.y0 - 40;   // item y is the baseline
  return clamp(top, Math.max(0, r.y0 - 260), r.y0 - 20);
}
// a page's top, in the scroll position of the pages pane
function pageTop(p) { const host = $("#pages"); return host.scrollTop + views[p].el.getBoundingClientRect().top - host.getBoundingClientRect().top; }
function readableScroll(p, r) {
  const host = $("#pages"), H = host.clientHeight, base = pageTop(p);
  const boxTop = base + disp(p, r.y0) * zoom, boxH = (regionRect(p, r).y1 - regionRect(p, r).y0) * zoom;
  let t = base + disp(p, questionTop(p, r)) * zoom - H * 0.12;           // the question near the top
  t = Math.max(t, boxTop - H * 0.6);                                      // the box no lower than 60% down
  t = Math.max(t, boxTop + Math.min(boxH, H * 0.3) - H * 0.92);           // at least a bit of the box is on screen
  t = Math.min(t, boxTop - H * 0.25);                                     // and always well below the top edge
  return clamp(t, 0, host.scrollHeight - H);
}
let glideRaf = 0;
function glideTo(host, target) {
  cancelAnimationFrame(glideRaf);
  const from = host.scrollTop, d = target - from; if (Math.abs(d) < 2) return;
  const dur = clamp(250 + Math.sqrt(Math.abs(d)) * 18, 300, 1100), t0 = performance.now();
  const ease = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const stop = () => { cancelAnimationFrame(glideRaf); host.removeEventListener("wheel", stop); host.removeEventListener("touchstart", stop); };
  host.addEventListener("wheel", stop, { passive: true }); host.addEventListener("touchstart", stop, { passive: true });   // you can take over at any time
  const step = now => { const t = Math.min(1, (now - t0) / dur); host.scrollTop = from + d * ease(t); if (t < 1) glideRaf = requestAnimationFrame(step); else stop(); };
  glideRaf = requestAnimationFrame(step);
}

// ---------------- fitting typed text ----------------
const fitQ = new Map(); let fitRaf = 0;
function queueFit(p, r) { fitQ.set(r.id, [p, r]); if (!fitRaf) fitRaf = requestAnimationFrame(() => { fitRaf = 0; const q = [...fitQ.values()]; fitQ.clear(); q.forEach(([p, r]) => fitRegion(p, r)); }); }
function baseFit(r) {
  if (r.kind === "lines") { const fs = clamp(r.sp * 0.42, 7.5, 11.5) * (r.code ? 0.9 : 1); return { fs, L: r.sp }; }
  if (r.kind === "cell") { const fs = clamp((r.y1 - r.y0) * 0.55, 6, 12); return { fs, L: fs * 1.18 }; }
  const fs = r.code ? 10 : 11; return { fs, L: fs * 1.38 };
}
function fitOf(r) { const f = doc.fit[r.id]; return f && typeof f === "object" ? f : baseFit(r); }
// settings to try, roomiest first: smaller text on the printed lines, then two text lines per printed line
function fitSteps(r) {
  const b = baseFit(r), out = [], R = v => Math.round(v * 100) / 100;
  if (r.kind === "lines") {
    const floor1 = r.sp >= 21 ? Math.min(b.fs, 9) : MIN_FS;
    for (let fs = b.fs; fs >= floor1 - 0.01; fs -= 0.25) out.push({ fs: R(fs), L: r.sp });
    if (r.sp >= 21) { const L = r.sp / 2; for (let fs = Math.min(b.fs, L * 0.74); fs >= Math.min(L * 0.74, MIN_FS) - 0.01; fs -= 0.25) out.push({ fs: R(fs), L, half: 1 }); }
  } else if (r.kind === "cell") { for (let fs = b.fs; fs >= 5.5; fs -= 0.25) out.push({ fs: R(fs), L: R(fs * 1.18) }); }
  else { for (let fs = b.fs; fs >= MIN_FS - 0.01; fs -= 0.25) out.push({ fs: R(fs), L: R(fs * 1.38) }); }
  return out;
}
function fieldTop(p, r, f) { return r.kind === "lines" ? disp(p, r.ys[0]) - 2 - baseInLine(f.fs, f.L) : disp(p, r.y0) + (r.kind === "box" ? 4 : 0); }
function applyField(p, r, f) {
  const ta = r._el; if (!ta) return;
  if (r.kind === "choice") {
    const R = regionRect(p, r), z = zoom;
    Object.assign(ta.style, { left: R.x0 * z + "px", top: R.y0 * z + "px", width: (R.x1 - R.x0) * z + "px", height: (R.y1 - R.y0) * z + "px", fontSize: (R.y1 - R.y0) * z * 1.05 + "px" });
    return;
  }
  const z = zoom, rect = regionRect(p, r);
  ta.style.fontSize = f.fs * fontScale(r) * z + "px"; ta.style.lineHeight = f.L * z + "px";
  ta.style.left = (r.x0 - 1) * z + "px"; ta.style.width = (r.x1 - r.x0 + 2) * z + "px";
  ta.style.textIndent = (r.kind === "lines" ? r.indent || 0 : 0) * z + "px";
  if (r.kind === "lines") {
    const top = fieldTop(p, r, f), extra = rect.y1 - disp(p, r.y1);   // extra = page space added under it
    ta.style.top = top * z + "px"; ta.style.height = Math.max(rect.y1 + 1 - top, availFor(r, f) + extra) * z + "px"; ta.style.padding = "0";
  } else if (r.kind === "box") {
    ta.style.top = rect.y0 * z + "px"; ta.style.height = (rect.y1 - rect.y0) * z + "px"; ta.style.padding = `${4 * z}px ${4 * z}px`;
  } else {
    ta.style.top = rect.y0 * z + "px"; ta.style.height = (rect.y1 - rect.y0) * z + "px"; ta.style.padding = "0";
  }
  shapeField(r, f);
  ta.classList.toggle("filled", !!(ta.value && ta.value.trim()));
}
// an answer whose first line starts further right (after a label like "Difference 1") gets a notched outline that
// follows where text can actually go: clipped background plus a matching outline drawn beside it
function shapeField(r, f) {
  const ta = r._el, z = zoom, ind = r.kind === "lines" ? (r.indent || 0) * z : 0;
  let sv = r._shape;
  if (ind < 2) { ta.classList.remove("notch"); ta.style.clipPath = ""; if (sv) sv.style.display = "none"; return; }
  const W = parseFloat(ta.style.width), H = parseFloat(ta.style.height), step = Math.min(H, f.L * z), x = ind + 1 * z;
  const pts = [[x, 0], [W, 0], [W, H], [0, H], [0, step], [x, step]];
  ta.classList.add("notch");
  ta.style.clipPath = "polygon(" + pts.map(q => q[0].toFixed(1) + "px " + q[1].toFixed(1) + "px").join(",") + ")";
  if (!sv) { sv = document.createElementNS("http://www.w3.org/2000/svg", "svg"); sv.setAttribute("class", "ansshape"); sv.innerHTML = "<path/>"; r._shape = sv; }
  if (sv.previousSibling !== ta) ta.after(sv);
  Object.assign(sv.style, { display: "", left: ta.style.left, top: ta.style.top, width: W + "px", height: H + "px" });
  sv.setAttribute("viewBox", `0 0 ${W} ${H}`);
  sv.firstChild.setAttribute("d", "M" + pts.map(q => (q[0] + (q[0] >= W ? -0.5 : 0.5)).toFixed(1) + " " + (q[1] + (q[1] >= H ? -0.5 : 0.5)).toFixed(1)).join(" L") + " Z");
  r._notch = x;
}
function contentH(r) { const ta = r._el; const prev = ta.style.height; ta.style.height = "1px"; const h = ta.scrollHeight; ta.style.height = prev; return h / zoom; }
function availFor(r, f) {
  // room for one line of text on every printed line, including the last one
  if (r.kind === "lines") return (r.ys[r.ys.length - 1] - r.ys[0]) + f.L + 0.5;
  return r.y1 - r.y0;
}
function fitRegion(p, r) {
  const ta = r._el; if (!ta || !ta.isConnected) return;
  if (r.kind === "choice") { applyField(p, r); paintChoice(r); return; }
  const steps = fitSteps(r);
  const fits = f => { applyFieldNoGap(p, r, f); return contentH(r) <= availFor(r, f) + 0.5; };
  let f = steps[0], gap = 0;
  if (ta.value && !fits(steps[0])) {
    const last = steps[steps.length - 1];
    if (fits(last)) { let lo = steps.length - 1, hi = 0; while (lo - hi > 1) { const m = (lo + hi) >> 1; if (fits(steps[m])) lo = m; else hi = m; } f = steps[lo]; }
    else {
      f = last;
      if (r.kind !== "cell") { applyFieldNoGap(p, r, f); gap = Math.ceil((contentH(r) - availFor(r, f) - ((r.cut ?? r.y1) - r.y1) + 1) / f.L) * f.L + 2; }
    }
  }
  doc.fit[r.id] = f;
  const changed = setGap(p, r, gap);
  applyField(p, r, f);
  if (r.kind === "cell") centreCell(r);
  if (changed) scheduleSave();
  if (handFor && handFor.r === r) placeHandles();
  if (flagFor && flagFor.r === r) placeFlagFloat();
}
function applyFieldNoGap(p, r, f) { if (r.kind === "choice") return applyField(p, r, f);
  const P = doc.pages[p]; const g = (P.gaps || {})[r.id]; if (g) { P.gaps[r.id] = 0; applyField(p, r, f); P.gaps[r.id] = g; } else applyField(p, r, f); if (r.kind === "cell") r._el.style.paddingTop = "0"; }
function centreCell(r) { const ta = r._el; ta.style.paddingTop = "0"; const h = (r.y1 - r.y0); const c = contentH(r); const pad = Math.max(0, (h - c) / 2); ta.style.paddingTop = pad * zoom + "px"; ta.style.height = (h - pad) * zoom + "px"; }
function gapRules(p, r, g) {
  const f = fitOf(r), top = fieldTop(p, r, f), g0 = disp(p, g.at), g1 = g0 + g.h, out = [];
  for (let k = 0; k < 400; k++) { const y = top + k * f.L + baseInLine(f.fs, f.L) + 2; if (y > g1 - 1) break; if (y > g0 + 1) out.push(y); }
  return out;
}

// ---------------- layout & rendering ----------------
function layoutPage(p) {
  const P = doc.pages[p], v = views[p]; if (!v) return;
  const z = zoom, H = P.h + totalGap(p);
  v.el.style.width = P.w * z + "px"; v.el.style.height = H * z + "px";
  for (const r of P.regions) { applyField(p, r, fitOf(r)); if (r.kind === "cell") centreCell(r); }
  v.gapEls.forEach(e => e.remove()); v.gapEls = [];
  for (const g of gapList(p)) {
    const d = document.createElement("div"); d.className = "gapfill";
    d.style.top = disp(p, g.at) * z + "px"; d.style.height = g.h * z + "px";
    d.innerHTML = "<span>extra space</span>";
    v.el.insertBefore(d, v.pg.nextSibling); v.gapEls.push(d);
  }
  $$(".flagmark", v.el).forEach(e => e.remove());
  for (const r of P.regions) if (doc.flags && doc.flags[r.id]) {
    const R = regionRect(p, r), m = document.createElement("button");
    m.className = "flagmark"; m.title = "Flagged — click to go to this answer"; m.setAttribute("aria-label", "Flagged answer space");
    m.style.left = Math.min(P.w - 14, r.x1 + 3) * z + "px"; m.style.top = (R.y0 + 1) * z + "px";
    m.onclick = () => { const ta = r._el; ta.focus({ preventScroll: true }); const L = ta.value.length; ta.setSelectionRange(L, L); };
    v.el.appendChild(m);
  }
  drawMarkers(p);
  sizeInk(p); drawInk(p);
  if (v.visible) composite(p);
  if (boxMode) drawBoxes(p);
  if (flagFor && flagFor.p === p) placeFlagFloat();
  if (handFor && handFor.p === p) placeHandles();
  if (inkSel && inkSel.p === p && !inkSel.moving) placeInkSel();
}
async function renderPage(p) {
  const v = views[p]; if (!v) return; const want = Math.min(zoom * dpr, 4);
  if (v.bm && v.bmZoom === want) { composite(p); return; }
  if (v.rendering) { v.again = true; return; }
  v.rendering = true;
  try {
    const page = await pdf.getPage(p + 1);
    const vp = page.getViewport({ scale: want });
    const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    v.bm = c; v.bmZoom = want;
  } catch (e) { console.error(e); }
  v.rendering = false;
  if (v.again) { v.again = false; return renderPage(p); }
  if (v.visible) composite(p);
}
function dropBitmap(p) { const v = views[p]; if (v.bm) { v.bm.width = v.bm.height = 0; v.bm = null; v.bmZoom = 0; } v.pg.width = v.pg.height = 0; }
function composite(p) {
  const v = views[p], P = doc.pages[p]; if (!v || !v.bm) return;
  const k = v.bmZoom, H = P.h + totalGap(p);
  const cw = Math.round(P.w * zoom * dpr), ch = Math.round(H * zoom * dpr);
  if (v.pg.width !== cw || v.pg.height !== ch) { v.pg.width = cw; v.pg.height = ch; }
  v.pg.style.width = P.w * zoom + "px"; v.pg.style.height = H * zoom + "px";
  const ctx = v.pg.getContext("2d"); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch);
  let sTop = 0, dTop = 0;
  const bands = gapList(p).map(g => ({ at: g.at, h: g.h })); bands.push({ at: P.h, h: 0 });
  for (const b of bands) {
    const hS = b.at - sTop; if (hS > 0) ctx.drawImage(v.bm, 0, sTop * k, v.bm.width, hS * k, 0, dTop * zoom * dpr, cw, hS * zoom * dpr);
    dTop += hS + b.h; sTop = b.at;
  }
  ctx.save(); ctx.strokeStyle = "#9aa3a0"; ctx.lineWidth = Math.max(1, 0.6 * zoom * dpr); ctx.setLineDash([1.2 * zoom * dpr, 2.2 * zoom * dpr]);
  for (const g of gapList(p)) { const r = P.regions.find(q => q.id === g.rid); for (const y of gapRules(p, r, g)) { ctx.beginPath(); ctx.moveTo(r.x0 * zoom * dpr, y * zoom * dpr); ctx.lineTo(r.x1 * zoom * dpr, y * zoom * dpr); ctx.stroke(); } }
  ctx.restore();
}
function fitWidthZoom() {
  const host = $("#pages"), maxW = Math.max(...doc.pages.map(P => P.w));
  const two = bookView && doc.pages.length > 1;
  return clamp((host.clientWidth - 28 - (two ? 18 : 0)) / (maxW * (two ? 2 : 1)), 0.3, 2.2);
}
function setZoom(z) {
  zoom = clamp(z, 0.3, 4); fitZoom = fitWidthZoom();
  const host = $("#pages"); const frac = host.scrollTop / Math.max(1, host.scrollHeight);
  doc.pages.forEach((P, p) => layoutPage(p));
  views.forEach((v, p) => { if (v.visible) renderPage(p); });
  host.scrollTop = frac * host.scrollHeight;
  $("#zfit").textContent = Math.round(zoom / fitZoom * 100) + "%";
  doc.pages.forEach((P, p) => P.regions.forEach(r => { if (doc.text[r.id]) queueFit(p, r); }));
}
$("#zin").onclick = () => setZoom(zoom * 1.2);
$("#zout").onclick = () => setZoom(zoom / 1.2);
$("#zfit").onclick = () => setZoom(fitWidthZoom());
let rsT; window.addEventListener("resize", () => { clearTimeout(rsT); rsT = setTimeout(() => { if (!doc || $("#editor").hidden) return; const wasFit = Math.abs(zoom - fitZoom) < 0.01; dpr = window.devicePixelRatio || 1; setZoom(wasFit ? fitWidthZoom() : zoom); }, 200); });
$("#pages").addEventListener("wheel", e => { if (e.ctrlKey && doc) { e.preventDefault(); setZoom(zoom * Math.exp(-clamp(e.deltaY, -50, 50) * 0.01)); } }, { passive: false });
function pageIndicator() {
  const host = $("#pages"); const mid = host.scrollTop + host.clientHeight / 3;
  let cur = 0; views.forEach((v, p) => { if (v.el.offsetTop <= mid) cur = p; });
  if (bookView && views.length > 1) { const a = cur - (cur % 2); $("#pageInd").textContent = a + 1 < views.length ? `Pages ${a + 1}–${a + 2} of ${views.length}` : `Page ${a + 1} of ${views.length}`; }
  else $("#pageInd").textContent = `Page ${cur + 1} of ${views.length}`;
}

// ---------------- ink ----------------
function sizeInk(p) {
  const v = views[p], P = doc.pages[p]; const H = P.h + totalGap(p);
  const cw = Math.round(P.w * zoom * dpr), ch = Math.round(H * zoom * dpr);
  if (v.ink.width !== cw || v.ink.height !== ch) { v.ink.width = cw; v.ink.height = ch; }
  v.ink.style.width = P.w * zoom + "px"; v.ink.style.height = H * zoom + "px";
}
function dispPts(p, s) { return s.pts.map(pt => toDisp(p, pt)); }
function tracePath(ctx, pts, k, ox = 0, oy = 0) {
  if (!pts.length) return;
  ctx.beginPath(); ctx.moveTo((pts[0][0] - ox) * k, (pts[0][1] - oy) * k);
  if (pts.length === 1) ctx.lineTo((pts[0][0] - ox) * k + 0.01, (pts[0][1] - oy) * k);
  for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; ctx.quadraticCurveTo((pts[i][0] - ox) * k, (pts[i][1] - oy) * k, (mx - ox) * k, (my - oy) * k); }
  if (pts.length > 1) ctx.lineTo((pts[pts.length - 1][0] - ox) * k, (pts[pts.length - 1][1] - oy) * k);
}
function drawStroke(ctx, s, pts, k, ox = 0, oy = 0) {
  ctx.save();
  ctx.globalAlpha = s.t === "hl" ? 0.35 : 1; ctx.strokeStyle = s.c; ctx.lineWidth = s.w * k; ctx.lineCap = s.t === "hl" ? "butt" : "round"; ctx.lineJoin = "round";
  const runs = pressureRuns(s, pts);
  if (!runs) { tracePath(ctx, pts, k, ox, oy); ctx.stroke(); ctx.restore(); return; }
  for (const run of runs) {
    ctx.lineWidth = run.w * k; ctx.beginPath(); ctx.moveTo((run.segs[0].a[0] - ox) * k, (run.segs[0].a[1] - oy) * k);
    for (const g of run.segs) { if (g.c) ctx.quadraticCurveTo((g.c[0] - ox) * k, (g.c[1] - oy) * k, (g.b[0] - ox) * k, (g.b[1] - oy) * k); else ctx.lineTo((g.b[0] - ox) * k, (g.b[1] - oy) * k); }
    ctx.stroke();
  }
  ctx.restore();
}
// ---- Apple Pencil hover: a dot shows where the pen (or a ring where the eraser) will land ----
let hoverDot = null;
function showHover(p, q) {
  const v = views[p]; if (!v || boxMode) return hideHover();
  if (!hoverDot) { hoverDot = document.createElement("div"); hoverDot.className = "hoverdot"; }
  if (hoverDot.parentElement !== v.el) v.el.appendChild(hoverDot);
  const er = tool === "eraser", hl = tool === "hl", d = Math.max(4, (er ? 10 : hl ? 9 : width + 1.5) * zoom);
  hoverDot.className = "hoverdot" + (er ? " er" : "");
  Object.assign(hoverDot.style, { display: "block", width: d + "px", height: d + "px", left: q[0] * zoom - d / 2 + "px", top: q[1] * zoom - d / 2 + "px", background: er ? "transparent" : hl ? "rgba(242,210,27,.45)" : colour });
}
function hideHover() { if (hoverDot) hoverDot.style.display = "none"; }
// ---- two-finger tap undoes, three-finger tap redoes, and four quick taps with one finger swap pen ⇄ eraser
// (with Pen, Highlighter or Eraser, where a finger tap does nothing else). Fingers still scroll and pinch as normal ----
let quickTaps = [];
const multiTouch = { max: 0, t0: 0, moved: false, start: null, last: 0 };
$("#pages").addEventListener("touchstart", e => {
  const fingers = [...e.touches].filter(t => t.touchType !== "stylus");
  if (fingers.length !== e.touches.length) { multiTouch.max = 0; return; }
  if (fingers.length === 1 || !multiTouch.max) { multiTouch.max = 0; multiTouch.t0 = performance.now(); multiTouch.moved = false; multiTouch.start = new Map(); }
  for (const t of fingers) if (!multiTouch.start.has(t.identifier)) multiTouch.start.set(t.identifier, [t.clientX, t.clientY]);
  multiTouch.max = Math.max(multiTouch.max, fingers.length);
  if (fingers.length > 1) multiTouch.last = performance.now();
}, { passive: true });
$("#pages").addEventListener("touchmove", e => {
  if (!multiTouch.start) return;
  for (const t of e.touches) { const s = multiTouch.start.get(t.identifier); if (s && Math.hypot(t.clientX - s[0], t.clientY - s[1]) > 12) multiTouch.moved = true; }
}, { passive: true });
$("#pages").addEventListener("touchend", e => {
  if (multiTouch.max > 1) multiTouch.last = performance.now();
  if (e.touches.length || !multiTouch.start) return;
  const quick = performance.now() - multiTouch.t0 < 350, n = multiTouch.max;
  multiTouch.start = null; multiTouch.max = 0;
  if (!quick || multiTouch.moved || boxMode || !doc) { quickTaps = []; return; }
  if (n === 2) { undo(); toast("Undo", 900); quickTaps = []; }
  else if (n === 3) { redo(); toast("Redo", 900); quickTaps = []; }
  else if (n === 1 && (tool === "pen" || tool === "hl" || tool === "eraser")) {
    const t = e.changedTouches[0], now = performance.now(), last = quickTaps[quickTaps.length - 1];
    if (!last || now - last.t > 450 || Math.hypot(t.clientX - quickTaps[0].x, t.clientY - quickTaps[0].y) > 60) quickTaps = [];
    quickTaps.push({ t: now, x: t.clientX, y: t.clientY });
    if (quickTaps.length >= 4) { quickTaps = []; swapEraser(); }
  }
}, { passive: true });
let drawTool = "pen";   // the tool the eraser hands back to
function swapEraser() {
  if (doc.shared && doc.shared.role === "view") return;
  toolAuto = false;
  if (tool === "eraser") setTool(drawTool);
  else { if (tool === "pen" || tool === "hl" || tool === "smart") drawTool = tool; setTool("eraser"); }
  toolFlash(tool === "eraser" ? "Eraser" : tool === "hl" ? "Highlighter" : tool === "smart" ? "Smart" : "Pen");
}
let toolFlashT;
function toolFlash(txt) {
  let el = $(".toolflash"); if (!el) { el = document.createElement("div"); el.className = "toolflash"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = txt; el.classList.add("show"); clearTimeout(toolFlashT); toolFlashT = setTimeout(() => el.classList.remove("show"), 700);
}
// ---- light pressure: the pen's width varies a little (about ±12%) with how hard you press ----
function strokePressure(s) { return s._live ? s._pr : s.pr; }
// the same smoothed curve as tracePath, cut into pieces with a width each, merged into runs of equal width
function pressureRuns(s, pts) {
  const pr = strokePressure(s);
  if (s.t !== "pen" || !pr || pr.length !== pts.length || pts.length < 3) return null;
  const n = pts.length, mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const sm = pr.map((_, i) => { let t = 0, c = 0; for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) { t += pr[j]; c++; } return t / c; });
  const q = s.w * 0.04, wOf = i => Math.round(s.w * (0.88 + 0.24 * clamp(sm[i], 0, 1)) / q) * q;
  const segs = [];
  for (let i = 1; i < n - 1; i++) segs.push({ a: i === 1 ? pts[0] : mid(pts[i - 1], pts[i]), c: pts[i], b: mid(pts[i], pts[i + 1]), w: wOf(i) });
  segs.push({ a: mid(pts[n - 2], pts[n - 1]), c: null, b: pts[n - 1], w: wOf(n - 1) });
  const runs = [];
  for (const g of segs) { const last = runs[runs.length - 1]; if (last && Math.abs(last.w - g.w) < 1e-6) last.segs.push(g); else runs.push({ w: g.w, segs: [g] }); }
  return runs;
}
function drawInk(p) {
  const v = views[p]; if (!v) return; const ctx = v.ink.getContext("2d"); const k = zoom * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, v.ink.width, v.ink.height);
  const S = doc.strokes[p] || [];
  const hid = inkSel && inkSel.moving && inkSel.p === p ? inkSel.ids : null;   // being dragged: drawn on the overlay instead
  for (const pass of ["hl", "pen"]) for (const s of S) if ((s.t === "hl") === (pass === "hl") && !(hid && hid.has(s.id))) drawStroke(ctx, s, s._live || dispPts(p, s), k);
  if (inkSel && inkSel.p === p && !inkSel.moving) placeInkSel();
}
function hitRegion(p, x, y) {
  const P = doc.pages[p];
  return P.regions.find(r => { if (r.kind === "choice") return false; const R = regionRect(p, r); return x >= R.x0 - 3 && x <= R.x1 + 3 && y >= R.y0 - 4 && y <= R.y1 + 3; });
}
function bindInk(p, v) {
  let st = null;
  const pos = e => { const b = v.ink.getBoundingClientRect(); return [(e.clientX - b.left) / zoom, (e.clientY - b.top) / zoom]; };
  v.ink.addEventListener("pointerdown", e => {
    if (boxMode) return;
    if (doc.shared && doc.shared.role === "view") return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.pointerType === "pen") sawPen();
    if (tool === "select") { selDown(p, e); return; }
    const p0 = pos(e);
    // Text and Smart: a click inside the answer you're typing in places the cursor, drag selects text.
    // Text also goes straight into any answer space you click. Pen, Highlight and Eraser never touch text.
    const textish = tool === "text" || tool === "smart";
    let a = document.activeElement;
    if (!(a && a.classList.contains("ans"))) a = null;
    if (a && !inRect(a, e.clientX, e.clientY)) a = null;
    if (!a && tool === "text" && e.pointerType !== "touch") { const r = hitRegion(p, p0[0], p0[1]); if (r && r._el) { r._el.focus({ preventScroll: true }); a = r._el; } }
    if (tool === "text" && e.pointerType !== "touch" && !a) {    // Text never draws: clicking empty paper leaves the box you're in,
      e.preventDefault(); const f = document.activeElement;           // or, when you're in none, looks for a missed answer space there
      if (f && f.classList.contains("ans")) f.blur(); else addSpaceAt(p, p0);
      st = null; return;
    }
    if (textish && a && e.pointerType !== "touch") {
      e.preventDefault(); v.ink.setPointerCapture(e.pointerId);
      const off = offsetAt(a, e.clientX, e.clientY);
      // count quick repeated clicks ourselves (pointer events don't carry a click count)
      const now = performance.now(), L = clickRun;
      clickRun = L && now - L.t < 450 && Math.hypot(e.clientX - L.x, e.clientY - L.y) < 6 ? { t: now, x: e.clientX, y: e.clientY, n: L.n + 1 } : { t: now, x: e.clientX, y: e.clientY, n: 1 };
      const clicks = clickRun.n;
      if (clicks === 2) { const [s, t] = wordAt(a.value, off); a.setSelectionRange(s, t); st = null; return; }
      if (clicks >= 3) { const v2 = a.value, s = v2.lastIndexOf("\n", off - 1) + 1, t = v2.indexOf("\n", off); a.setSelectionRange(s, t < 0 ? v2.length : t); st = null; return; }
      if (e.shiftKey) { const anc = a.selectionDirection === "backward" ? a.selectionEnd : a.selectionStart; setSel(a, anc, off); st = { id: e.pointerId, select: a, anchor: anc }; return; }
      a.setSelectionRange(off, off);
      st = { id: e.pointerId, select: a, anchor: off };
      return;
    }
    st = { id: e.pointerId, type: e.pointerType, start: p0, t0: performance.now(), moved: false, stroke: null, erased: [] };
    if (e.pointerType !== "touch") { try { v.ink.setPointerCapture(e.pointerId); } catch (err) {} e.preventDefault(); }
    if (tool === "text") return;                                   // a finger in Text: scroll, or tap a space to type
    if (e.pointerType === "pen" || (tool === "pen" && e.pointerType === "mouse")) { hideHover(); beginDraw(st, p0, e); }
  });
  v.ink.addEventListener("pointermove", e => {
    if (!st && e.pointerType === "pen" && !e.buttons) { if (tool !== "text" && tool !== "select") showHover(p, pos(e)); return; }   // Pencil hovering above the screen
    if (!st || e.pointerId !== st.id) return;
    if (st.select) { setSel(st.select, st.anchor, offsetAt(st.select, e.clientX, e.clientY)); return; }
    const q = pos(e);
    if (!st.moved && Math.hypot(q[0] - st.start[0], q[1] - st.start[1]) * zoom > 4) {
      st.moved = true;
      if (st.type === "touch") { st = null; return; }       // a finger scrolls the page
      if (!st.stroke && !st.erasing && tool !== "text") beginDraw(st, st.start);
    }
    if (!st.moved && st.type !== "pen") return;
    let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e]; if (!evs.length) evs = [e];
    if (st.erasing) { for (const ev of evs) eraseAt(p, pos(ev), st.erased); return; }
    if (!st.stroke) return;
    const live = st.stroke._live;
    const pr = st.stroke._pr;
    if (e.shiftKey) { st.stroke._live = [live[0], q]; if (pr) st.stroke._pr = [pr[0], e.pressure]; }
    else for (const ev of evs) { live.push(pos(ev)); if (pr) pr.push(ev.pressure); }
    drawInk(p);
  });
  const finish = () => {
    const s = st.stroke; s.pts = s._live.map(q => toAnchor(p, q[0], q[1]));
    // keep pressure only if it really varied (a real pen, not a mouse reporting a flat 0.5)
    if (s._pr && s._pr.length === s.pts.length && Math.max(...s._pr) - Math.min(...s._pr) > 0.03) s.pr = s._pr.map(x => Math.round(x * 100) / 100);
    delete s._pr; delete s._live; return s;
  };
  const end = e => {
    if (!st || e.pointerId !== st.id) return;
    if (st.select) { st = null; return; }
    if (st.type === "touch" && performance.now() - multiTouch.last < 600) { st = null; return; }   // part of a two/three-finger tap
    const tapped = !st.moved && performance.now() - st.t0 < 500;
    const drawOnly = tool === "pen" || tool === "hl" || tool === "eraser";
    if (tapped && drawOnly && st.stroke && st.stroke.t === "hl") { const arr = doc.strokes[p]; arr.splice(arr.indexOf(st.stroke), 1); drawInk(p); st.stroke = null; }
    if (tapped && drawOnly && !st.stroke && !(st.erased && st.erased.length)) { st = null; return; }   // a finger tap with a drawing tool does nothing
    if (tapped && !drawOnly) {
      const r = hitRegion(p, st.start[0], st.start[1]);
      if (st.stroke && !r) { finish(); pushUndo({ t: "add", p, s: st.stroke }); emit(`s:${p}:${st.stroke.id}`); scheduleSave(); st = null; return; }   // a deliberate dot
      if (st.stroke) { const arr = doc.strokes[p]; arr.splice(arr.indexOf(st.stroke), 1); drawInk(p); st.stroke = null; }
      if (r) {
        const ta = r._el; ta.focus({ preventScroll: true }); const L = offsetAt(ta, e.clientX, e.clientY); ta.setSelectionRange(L, L);
        // this click counts towards a double/triple click, so double-clicking a word in an inactive box selects it
        if (st.type !== "touch") clickRun = { t: performance.now(), x: e.clientX, y: e.clientY, n: 1 };
      }
      else if (document.activeElement && document.activeElement.classList.contains("ans")) document.activeElement.blur();
      else if (tool === "text") addSpaceAt(p, st.start);
    } else if (st.stroke) { finish(); pushUndo({ t: "add", p, s: st.stroke }); emit(`s:${p}:${st.stroke.id}`); scheduleSave(); drawInk(p); }
    else if (st.erased && st.erased.length) {
      pushUndo({ t: "erase", p, list: st.erased }); st.erased.forEach(s => emit(`s:${p}:${s.id}`)); scheduleSave();
      if (tool === "eraser") { toolAuto = false; setTool(drawTool); toolFlash(drawTool === "hl" ? "Highlighter" : drawTool === "smart" ? "Smart" : "Pen"); }   // erased something: straight back to writing
    }
    st = null;
  };
  v.ink.addEventListener("pointerup", end);
  v.ink.addEventListener("pointerleave", e => { if (e.pointerType === "pen") hideHover(); });
  v.ink.addEventListener("pointercancel", () => { if (st && st.stroke) { const arr = doc.strokes[p]; const i = arr.indexOf(st.stroke); if (i >= 0) { if (st.stroke._live.length < 3) arr.splice(i, 1); else { finish(); pushUndo({ t: "add", p, s: st.stroke }); emit(`s:${p}:${st.stroke.id}`); scheduleSave(); } } drawInk(p); } st = null; });
  function beginDraw(s, p0, e) {
    if (document.activeElement && document.activeElement.classList.contains("ans")) document.activeElement.blur();
    if (tool === "eraser") { s.erasing = true; eraseAt(p, p0, s.erased); return; }
    doc.strokes[p] = doc.strokes[p] || [];
    s.stroke = tool === "hl" ? { id: rid8(), t: "hl", c: "#f2d21b", w: 9, pts: [], _live: [p0] } : { id: rid8(), t: "pen", c: colour, w: width, pts: [], _live: [p0] };
    if (tool !== "hl" && s.type === "pen" && e) s.stroke._pr = [e.pressure];
    doc.strokes[p].push(s.stroke);
  }
}
// ---- Text tool on blank paper: there should be an answer space here. Look at the page again for one that was
// missed (a faint line, a box …); failing that, fit a space to the blank area around the click ----
let addingSpace = false;
async function addSpaceAt(p, q) {
  if (addingSpace || !canEdit() || boxMode) return;
  const P = doc.pages[p], x = q[0], y = src(p, q[1]);
  if (y > P.h || x < 0 || x > P.w) return;                               // in the extra space added under an answer
  addingSpace = true;
  try {
    const page = await pdf.getPage(p + 1), vp = page.getViewport({ scale: 1 }), S = Detect.S, vp2 = page.getViewport({ scale: S });
    const c = document.createElement("canvas"); c.width = Math.ceil(vp2.width); c.height = Math.ceil(vp2.height);
    const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp2 }).promise;
    let tc = null; try { tc = await page.getTextContent(); } catch (e) {}
    const G = Detect.grey(ctx.getImageData(0, 0, c.width, c.height)), ink = (x0, y0, x1, y1) => {
      let n = 0; for (let yy = Math.max(0, Math.floor(y0 * S)); yy < Math.min(G.h, Math.ceil(y1 * S)); yy++) for (let xx = Math.max(0, Math.floor(x0 * S)); xx < Math.min(G.w, Math.ceil(x1 * S)); xx++) if (G.g[yy * G.w + xx] < 165) n++; return n; };
    if (ink(x - 1.5, y - 1.5, x + 1.5, y + 1.5) > 2) return;              // clicked on the printing itself
    const overlaps = r => P.regions.some(o => o.x0 < r.x1 - 2 && o.x1 > r.x0 + 2 && o.y0 < r.y1 - 2 && o.y1 > r.y0 + 2);
    // 1. a space the detector finds here now (which isn't one we already have)
    const fresh = Detect.page(c, vp, tc).regions.filter(r => r.kind !== "choice" && !overlaps(r));
    const dist = r => Math.max(r.x0 - x, 0, x - r.x1) + Math.max(r.y0 - y, 0, y - r.y1) * 1.5;
    let r = fresh.filter(r => dist(r) < 14).sort((a, b) => dist(a) - dist(b))[0];
    let how = "Found an answer space here.";
    if (!r) {
      // 2. the blank area around the click: as wide as the gap in the printing, from the click down
      const band = (x0, x1, y0, y1) => ink(x0, y0, x1, y1) > 0;
      let x0 = x, x1 = x;
      while (x0 > 30 && !band(x0 - 2, x0, y - 5, y + 5)) x0 -= 2;
      while (x1 < P.w - 30 && !band(x1, x1 + 2, y - 5, y + 5)) x1 += 2;
      x0 = Math.max(x0 + 2, x - 6); x1 -= 2;
      let y0 = y, y1 = y;
      while (y0 > y - 12 && !band(x0, x1, y0 - 1, y0)) y0 -= 1;
      while (y1 < y + 160 && y1 < P.h - 20 && !band(x0, x1, y1, y1 + 1)) y1 += 1;
      if (x1 - x0 < 30 || y1 - y0 < 12) { toast("There's no room for an answer here. Use Boxes to draw one exactly.", 3000); return; }
      r = { kind: "box", x0, x1, y0, y1: Math.max(y1, y0 + 16) };
      how = "Added an answer space here. Use Boxes to change its size.";
    }
    c.width = c.height = 0;
    r.id = `${p}:a${rid8()}`; r.label ||= ""; r.code ||= false; r.cut ??= r.y1 + 3;
    P.regions.push(r); makeField(p, r); layoutPage(p); queueFit(p, r); updateCount(); pageChanged(p);
    const ta = r._el; ta.focus({ preventScroll: true });
    toast(how, 2600);
  } catch (e) { console.warn(e); }
  finally { addingSpace = false; }
}

// ---- a text cursor the height of the text, not of the whole ruled line ----
// browsers draw a textarea's caret as tall as the line spacing, which on answer lines is far taller than the
// writing. So the real caret is made invisible and this one is drawn instead, measured with a hidden copy of the text.
const caretEl = document.createElement("div"); caretEl.className = "tcaret"; caretEl.hidden = true;
let caretKey = "";
function caretRect(ta, idx) {
  const cs = getComputedStyle(ta), m = document.createElement("div");
  for (const p of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "wordSpacing", "lineHeight", "textIndent", "textAlign", "tabSize", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "boxSizing", "fontKerning", "fontFeatureSettings"]) m.style[p] = cs[p];
  Object.assign(m.style, { position: "absolute", visibility: "hidden", left: ta.offsetLeft + "px", top: ta.offsetTop - ta.scrollTop + "px", width: ta.offsetWidth + "px", margin: "0", border: "0", whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: cs.wordBreak });
  const v = ta.value, mk = document.createElement("span");
  m.appendChild(document.createTextNode(v.slice(0, idx))); mk.textContent = "\u200b"; m.appendChild(mk); m.appendChild(document.createTextNode(v.slice(idx)));
  ta.parentElement.appendChild(m);
  const pr = ta.parentElement.getBoundingClientRect(), k = mk.getBoundingClientRect();
  m.remove();
  return { x: k.left - pr.left, y: k.top - pr.top, h: k.height };
}
function updateCaret() {
  const ta = document.activeElement;
  if (!ta || !ta.classList || !ta.classList.contains("ans") || ta.selectionStart !== ta.selectionEnd || boxMode) { if (!caretEl.hidden) caretEl.hidden = true; caretKey = ""; return; }
  const key = [ta.dataset.rid, ta.selectionStart, ta.value, ta.style.fontSize, ta.style.width, ta.style.left, ta.style.top, ta.style.textIndent, ta.scrollTop, zoom].join("|");
  if (key === caretKey && !caretEl.hidden) return;
  caretKey = key;
  const c = caretRect(ta, ta.selectionStart), fs = parseFloat(getComputedStyle(ta).fontSize) || 12;
  const h = Math.max(fs * 1.15, Math.min(c.h, fs * 1.4));
  if (caretEl.parentElement !== ta.parentElement) ta.parentElement.appendChild(caretEl);
  Object.assign(caretEl.style, { left: c.x - 0.5 + "px", top: c.y + (c.h - h) / 2 + "px", height: h + "px", width: Math.max(1.5, fs * 0.08) + "px", background: getComputedStyle(ta).color });
  caretEl.hidden = false;
  caretEl.classList.remove("blink"); void caretEl.offsetWidth; caretEl.classList.add("blink");   // solid while moving, then blinks
}
(function caretLoop() { try { updateCaret(); } catch (e) {} requestAnimationFrame(caretLoop); })();

// ---- placing the text cursor where you click, even though the ink layer sits on top ----
let clickRun = null;
function inRect(el, x, y) { const r = el.getBoundingClientRect(); return x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2; }
function setSel(ta, anchor, focus) { if (focus < anchor) ta.setSelectionRange(focus, anchor, "backward"); else ta.setSelectionRange(anchor, focus, "forward"); }
function wordAt(s, i) { let a = i, b = i; while (a > 0 && /\w/.test(s[a - 1])) a--; while (b < s.length && /\w/.test(s[b])) b++; return [a, b]; }
// character offset in a text box under a screen point: lay an invisible copy of the box's text,
// styled identically, over it and ask the browser which character is under the point
function offsetAt(ta, x, y) {
  const cs = getComputedStyle(ta), r = ta.getBoundingClientRect(), m = document.createElement("div");
  for (const p of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "wordSpacing", "lineHeight", "textIndent", "textAlign", "tabSize", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "boxSizing", "fontKerning", "fontFeatureSettings"]) m.style[p] = cs[p];
  Object.assign(m.style, { position: "fixed", left: r.left + "px", top: r.top - ta.scrollTop + "px", width: r.width + "px", minHeight: r.height + "px", margin: "0", border: "0", whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: cs.wordBreak, zIndex: "2147483647", opacity: "0", pointerEvents: "auto", color: "transparent" });
  m.textContent = ta.value + "\u200b";
  document.body.appendChild(m);
  let off = ta.value.length;
  try {
    if (document.caretPositionFromPoint) { const pp = document.caretPositionFromPoint(x, y); if (pp && m.contains(pp.offsetNode)) off = pp.offset; }
    else if (document.caretRangeFromPoint) { const rg = document.caretRangeFromPoint(x, y); if (rg && m.contains(rg.startContainer)) off = rg.startOffset; }
  } catch (e) {}
  m.remove();
  return clamp(off, 0, ta.value.length);
}
function eraseAt(p, q, out) {
  const arr = doc.strokes[p] || []; let hit = false;
  for (let i = arr.length - 1; i >= 0; i--) {
    const s = arr[i], R = Math.max(5, s.w / 2 + 3), pts = dispPts(p, s);
    if (pts.some((a, j) => segDist(q, a, pts[j + 1] || a) < R)) { out.push(s); arr.splice(i, 1); hit = true; }
  }
  if (hit) drawInk(p);
}
function segDist(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1]; const L = dx * dx + dy * dy; let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = clamp(t, 0, 1); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); }
// stop an Apple Pencil from scrolling the page on iPad while fingers still scroll
for (const ev of ["touchstart", "touchmove"]) $("#pages").addEventListener(ev, e => {
  if ([...e.touches].some(t => t.touchType === "stylus") && !boxMode && e.target.classList.contains("ink")) e.preventDefault();
  else if (selOp && e.touches.length === 1) e.preventDefault();       // one finger is selecting or moving drawings, not scrolling
}, { passive: false });

function pushUndo(a) { undoS.push(a); redoS.length = 0; }
function undo() { clearInkSel(); const a = undoS.pop(); if (!a) return; if (a.t === "move") { applyMove(a, "before"); redoS.push(a); return; } const arr = doc.strokes[a.p] ||= []; if (a.t === "add") { const i = arr.indexOf(a.s); if (i >= 0) arr.splice(i, 1); emit(`s:${a.p}:${a.s.id}`); } else { arr.push(...a.list); a.list.forEach(s => emit(`s:${a.p}:${s.id}`)); } redoS.push(a); drawInk(a.p); scheduleSave(); }
function redo() { clearInkSel(); const a = redoS.pop(); if (!a) return; if (a.t === "move") { applyMove(a, "after"); undoS.push(a); return; } const arr = doc.strokes[a.p] ||= []; if (a.t === "add") { arr.push(a.s); emit(`s:${a.p}:${a.s.id}`); } else a.list.forEach(s => { const i = arr.indexOf(s); if (i >= 0) arr.splice(i, 1); emit(`s:${a.p}:${s.id}`); }); undoS.push(a); drawInk(a.p); scheduleSave(); }
$("#undo").onclick = undo; $("#redo").onclick = redo;

// ---------------- Select tool: box drawings, then drag them anywhere (even to another page) ----------------
let inkSel = null;   // { p, ids:Set, box:{x0,y0,x1,y1} (display coords on page p), moving }
let selOp = null;    // the drag in progress
const SEL_PAD = 6;
function selStrokes() { if (!inkSel) return []; return (doc.strokes[inkSel.p] || []).filter(s => inkSel.ids.has(s.id) && s.pts && s.pts.length); }
function strokesBox(p, list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of list) { const half = s.w / 2; for (const q of dispPts(p, s)) { x0 = Math.min(x0, q[0] - half); y0 = Math.min(y0, q[1] - half); x1 = Math.max(x1, q[0] + half); y1 = Math.max(y1, q[1] + half); } }
  return isFinite(x0) ? { x0, y0, x1, y1 } : null;
}
function clearInkSel() { inkSel = null; $$(".selbox").forEach(e => e.remove()); }
// draw the dashed box (and its Delete button) around what's selected; drops strokes that vanished (e.g. deleted on another device)
function placeInkSel() {
  if (!inkSel) return;
  const list = selStrokes();
  if (!list.length) { clearInkSel(); return; }
  if (list.length !== inkSel.ids.size) inkSel.ids = new Set(list.map(s => s.id));
  const b = strokesBox(inkSel.p, list); inkSel.box = b;
  const v = views[inkSel.p]; if (!v) return;
  let el = $(".selbox");
  if (!el) {
    el = document.createElement("div"); el.className = "selbox";
    const del = document.createElement("button"); del.type = "button"; del.className = "seldel"; del.textContent = "Delete"; del.title = "Delete the selected drawing (Delete key)";
    del.addEventListener("pointerdown", e => e.stopPropagation()); del.onclick = e => { e.stopPropagation(); deleteInkSel(); };
    el.appendChild(del);
    for (const c of ["nw", "ne", "sw", "se"]) {
      const h = document.createElement("div"); h.className = "selh " + c; h.dataset.c = c; h.title = "Drag to resize the drawing";
      h.addEventListener("pointerdown", e => selScaleDown(e, c)); el.appendChild(h);
    }
  }
  if (el.parentElement !== v.el) v.el.appendChild(el);
  el.style.left = (b.x0 - SEL_PAD) * zoom + "px"; el.style.top = (b.y0 - SEL_PAD) * zoom + "px";
  el.style.width = (b.x1 - b.x0 + SEL_PAD * 2) * zoom + "px"; el.style.height = (b.y1 - b.y0 + SEL_PAD * 2) * zoom + "px";
  el.style.display = "";
}
function inSelBox(p, q, slack) { const b = inkSel && inkSel.p === p && inkSel.box; return !!b && q[0] >= b.x0 - SEL_PAD - slack && q[0] <= b.x1 + SEL_PAD + slack && q[1] >= b.y0 - SEL_PAD - slack && q[1] <= b.y1 + SEL_PAD + slack; }
function deleteInkSel() {
  if (!inkSel) return; const p = inkSel.p, arr = doc.strokes[p] || [], gone = arr.filter(s => inkSel.ids.has(s.id));
  if (!gone.length) { clearInkSel(); return; }
  doc.strokes[p] = arr.filter(s => !inkSel.ids.has(s.id));
  pushUndo({ t: "erase", p, list: gone }); gone.forEach(s => emit(`s:${p}:${s.id}`));
  clearInkSel(); drawInk(p); scheduleSave(); toast(gone.length === 1 ? "Drawing deleted." : `${gone.length} drawings deleted.`, 1500);
}
// the page that a point on screen belongs to (or the nearest one, if it's between pages)
function pageAtClient(x, y) {
  let best = 0, bd = Infinity;
  views.forEach((v, i) => { const r = v.el.getBoundingClientRect(); const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom); const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } });
  return best;
}
function pageDispH(p) { return doc.pages[p].h + totalGap(p); }
// move every selected stroke by (dx, dy) page units, from page p to page q, as one undoable step
function moveStrokes(p, q, ids, dx, dy) {
  const from = doc.strokes[p] || [], list = from.filter(s => ids.has(s.id)); if (!list.length) return;
  const items = list.map(s => { const before = s.pts; const after = dispPts(p, s).map(pt => toAnchor(q, pt[0] + dx, pt[1] + dy)); return { id: s.id, before, after }; });
  const a = { t: "move", from: p, to: q, items };
  pushUndo(a); applyMove(a, "after");
}
function applyMove(a, which) {
  const [src, dst] = which === "after" ? [a.from, a.to] : [a.to, a.from];
  const S = doc.strokes[src] ||= [], D = doc.strokes[dst] ||= [];
  for (const it of a.items) {
    const i = S.findIndex(s => s.id === it.id); if (i < 0) continue;     // gone (e.g. deleted on another device)
    const s = S[i]; s.pts = it[which];
    if (it.w) s.w = it.w[which === "after" ? 1 : 0];             // resized: line thickness scales too
    if (src !== dst) { S.splice(i, 1); D.push(s); emit(`s:${src}:${s.id}`); }
    emit(`s:${dst}:${s.id}`);
  }
  drawInk(src); if (dst !== src) drawInk(dst); scheduleSave();
}
// ---- resizing the selection from a corner: scales evenly about the opposite corner, line thickness included,
// so the writing looks exactly the same, just bigger or smaller ----
function scaleFactor(op, cx, cy) {
  const v = views[op.p], r = v.ink.getBoundingClientRect(), q = [(cx - r.left) / zoom, (cy - r.top) / zoom];
  const d0 = [op.corner[0] - op.anchor[0], op.corner[1] - op.anchor[1]], d = [q[0] - op.anchor[0], q[1] - op.anchor[1]];
  let k = (d[0] * d0[0] + d[1] * d0[1]) / Math.max(1e-6, d0[0] * d0[0] + d0[1] * d0[1]);
  // keep it a sensible size and on the page
  const b = op.box, P = doc.pages[op.p], Hd = pageDispH(op.p), A = op.anchor;
  const lim = [];
  if (b.x1 > A[0] + 0.01) lim.push((P.w - A[0]) / (b.x1 - A[0])); if (b.x0 < A[0] - 0.01) lim.push(A[0] / (A[0] - b.x0));
  if (b.y1 > A[1] + 0.01) lim.push((Hd - A[1]) / (b.y1 - A[1])); if (b.y0 < A[1] - 0.01) lim.push(A[1] / (A[1] - b.y0));
  const minK = Math.max(0.15, 4 / Math.max(b.x1 - b.x0, b.y1 - b.y0, 1));
  return clamp(k, minK, Math.min(8, ...lim));
}
function selScaleDown(e, c) {
  if (!inkSel || !inkSel.box || selOp) return;
  e.preventDefault(); e.stopPropagation();
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
  const b = inkSel.box, p = inkSel.p;
  const corner = [c[1] === "w" ? b.x0 : b.x1, c[0] === "n" ? b.y0 : b.y1], anchor = [c[1] === "w" ? b.x1 : b.x0, c[0] === "n" ? b.y1 : b.y0];
  selOp = { kind: "scale", id: e.pointerId, p, cx: e.clientX, cy: e.clientY, x: e.clientX, y: e.clientY, corner, anchor, box: { ...b }, moved: false, k: 1, list: selStrokes().map(s => ({ s, pts: dispPts(p, s) })) };
  window.addEventListener("pointermove", selMove); window.addEventListener("pointerup", selUp); window.addEventListener("pointercancel", cancelSelOp);
  selOp.raf = requestAnimationFrame(selTick);
}
function scaleStrokes(p, ids, A, k) {
  const list = (doc.strokes[p] || []).filter(s => ids.has(s.id)); if (!list.length) return;
  const items = list.map(s => ({ id: s.id, before: s.pts, after: dispPts(p, s).map(pt => toAnchor(p, A[0] + (pt[0] - A[0]) * k, A[1] + (pt[1] - A[1]) * k)), w: [s.w, Math.round(s.w * k * 100) / 100] }));
  const a = { t: "move", from: p, to: p, items };
  pushUndo(a); applyMove(a, "after");
}
function nudgeInkSel(dx, dy) {
  if (!inkSel || !inkSel.box) return; const p = inkSel.p, b = inkSel.box, P = doc.pages[p];
  dx = clamp(dx, -b.x0, P.w - b.x1); dy = clamp(dy, -b.y0, pageDispH(p) - b.y1); if (!dx && !dy) return;
  const ids = new Set(inkSel.ids); moveStrokes(p, p, ids, dx, dy); inkSel = { p, ids }; placeInkSel();
}
// overlay canvas over the pages, used while dragging so drawings can cross from one page to another
let selOverlay = null;
function overlayCtx() {
  if (!selOverlay) { selOverlay = document.createElement("canvas"); selOverlay.className = "seloverlay"; document.body.appendChild(selOverlay); }
  const r = $("#pages").getBoundingClientRect(), d = window.devicePixelRatio || 1;
  Object.assign(selOverlay.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", display: "block" });
  const W = Math.round(r.width * d), H = Math.round(r.height * d);
  if (selOverlay.width !== W || selOverlay.height !== H) { selOverlay.width = W; selOverlay.height = H; }
  const ctx = selOverlay.getContext("2d"); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H); ctx.setTransform(d, 0, 0, d, -r.left * d, -r.top * d);
  return ctx;
}
function hideOverlay() { if (selOverlay) selOverlay.style.display = "none"; }
function selDown(p, e) {
  if (selOp) { cancelSelOp(); return; }                    // a second finger/pointer: give way (e.g. to a pinch)
  if (e.pointerType === "touch" && performance.now() - multiTouch.last < 80) return;
  e.preventDefault();
  const f = document.activeElement; if (f && f.classList.contains("ans")) f.blur();
  const v = views[p], b = v.ink.getBoundingClientRect(), q = [(e.clientX - b.left) / zoom, (e.clientY - b.top) / zoom];
  try { v.ink.setPointerCapture(e.pointerId); } catch (err) {}
  const slack = e.pointerType === "touch" ? 10 : e.pointerType === "pen" ? 4 : 2;
  if (inSelBox(p, q, slack)) {
    const sb = inkSel.box;
    selOp = { kind: "move", id: e.pointerId, p, x: e.clientX, y: e.clientY, cx: e.clientX, cy: e.clientY, grab: [q[0] - sb.x0, q[1] - sb.y0], moved: false, list: selStrokes().map(s => ({ s, pts: dispPts(p, s) })) };
  } else {
    clearInkSel();
    const el = document.createElement("div"); el.className = "lasso"; v.el.appendChild(el);
    selOp = { kind: "box", id: e.pointerId, p, start: q, cx: e.clientX, cy: e.clientY, el };
  }
  window.addEventListener("pointermove", selMove); window.addEventListener("pointerup", selUp); window.addEventListener("pointercancel", cancelSelOp);
  selOp.raf = requestAnimationFrame(selTick);
}
function selMove(e) { if (!selOp || e.pointerId !== selOp.id) return; selOp.cx = e.clientX; selOp.cy = e.clientY; if ((selOp.kind === "move" || selOp.kind === "scale") && !selOp.moved && Math.hypot(e.clientX - selOp.x, e.clientY - selOp.y) > 3) { selOp.moved = true; inkSel.moving = true; drawInk(selOp.p); const el = $(".selbox"); if (el) el.style.display = "none"; } }
// every frame: scroll when near the top/bottom edge, then redraw the box or the dragged drawings
function selTick() {
  if (!selOp) return;
  const host = $("#pages"), hr = host.getBoundingClientRect(), edge = 48;
  let sp = 0; if (selOp.cy < hr.top + edge) sp = -(hr.top + edge - selOp.cy); else if (selOp.cy > hr.bottom - edge) sp = selOp.cy - (hr.bottom - edge);
  if (sp && (selOp.kind === "box" || selOp.moved)) host.scrollTop += clamp(sp, -edge, edge) * 0.35;
  if (selOp.kind === "box") {
    const v = views[selOp.p], b = v.ink.getBoundingClientRect(), P = doc.pages[selOp.p];
    const q = [clamp((selOp.cx - b.left) / zoom, 0, P.w), clamp((selOp.cy - b.top) / zoom, 0, pageDispH(selOp.p))], s0 = selOp.start;
    selOp.end = q;
    Object.assign(selOp.el.style, { left: Math.min(s0[0], q[0]) * zoom + "px", top: Math.min(s0[1], q[1]) * zoom + "px", width: Math.abs(q[0] - s0[0]) * zoom + "px", height: Math.abs(q[1] - s0[1]) * zoom + "px" });
  } else if (selOp.kind === "scale") {
    if (selOp.moved) {
      const k = selOp.k = scaleFactor(selOp, selOp.cx, selOp.cy), A = selOp.anchor, v = views[selOp.p], r = v.ink.getBoundingClientRect(), ctx = overlayCtx();
      ctx.save(); ctx.translate(r.left, r.top);
      const tp = pts => pts.map(q => [A[0] + (q[0] - A[0]) * k, A[1] + (q[1] - A[1]) * k]);
      for (const pass of ["hl", "pen"]) for (const it of selOp.list) if ((it.s.t === "hl") === (pass === "hl")) drawStroke(ctx, { ...it.s, w: it.s.w * k }, tp(it.pts), zoom);
      const b = selOp.box, x0 = A[0] + (b.x0 - A[0]) * k, x1 = A[0] + (b.x1 - A[0]) * k, y0 = A[1] + (b.y0 - A[1]) * k, y1 = A[1] + (b.y1 - A[1]) * k;
      ctx.strokeStyle = "#2f7d74"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.strokeRect((Math.min(x0, x1) - SEL_PAD) * zoom, (Math.min(y0, y1) - SEL_PAD) * zoom, (Math.abs(x1 - x0) + SEL_PAD * 2) * zoom, (Math.abs(y1 - y0) + SEL_PAD * 2) * zoom);
      ctx.restore();
    }
  } else if (selOp.moved) {
    const ctx = overlayCtx(), sb = inkSel.box, w = sb.x1 - sb.x0, h = sb.y1 - sb.y0;
    const left = selOp.cx - selOp.grab[0] * zoom, top = selOp.cy - selOp.grab[1] * zoom;   // where the box's top-left is on screen
    ctx.save(); ctx.translate(left - sb.x0 * zoom, top - sb.y0 * zoom);
    for (const pass of ["hl", "pen"]) for (const it of selOp.list) if ((it.s.t === "hl") === (pass === "hl")) drawStroke(ctx, it.s, it.pts, zoom);
    ctx.restore();
    ctx.save(); ctx.strokeStyle = "#2f7d74"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.strokeRect(left - SEL_PAD * zoom, top - SEL_PAD * zoom, (w + SEL_PAD * 2) * zoom, (h + SEL_PAD * 2) * zoom); ctx.restore();
  }
  selOp.raf = requestAnimationFrame(selTick);
}
function endSelOp() {
  if (!selOp) return; cancelAnimationFrame(selOp.raf);
  window.removeEventListener("pointermove", selMove); window.removeEventListener("pointerup", selUp); window.removeEventListener("pointercancel", cancelSelOp);
  if (selOp.el) selOp.el.remove(); hideOverlay();
  const op = selOp; selOp = null; return op;
}
function cancelSelOp() {   // put everything back exactly as it was
  const op = endSelOp(); if (!op) return;
  if (inkSel) { inkSel.moving = false; drawInk(inkSel.p); placeInkSel(); }
}
function selUp(e) {
  if (!selOp || e.pointerId !== selOp.id) return;
  const op = endSelOp();
  if (op.kind === "box") {
    const s0 = op.start, q = op.end || s0, x0 = Math.min(s0[0], q[0]), x1 = Math.max(s0[0], q[0]), y0 = Math.min(s0[1], q[1]), y1 = Math.max(s0[1], q[1]);
    if (x1 - x0 < 3 && y1 - y0 < 3) return;                // just a tap: selection cleared
    // a stroke is picked when most of it lies inside the box
    const ids = new Set();
    for (const s of doc.strokes[op.p] || []) { const pts = dispPts(op.p, s); if (!pts.length) continue; const n = pts.filter(t => t[0] >= x0 && t[0] <= x1 && t[1] >= y0 && t[1] <= y1).length; if (n / pts.length >= 0.5) ids.add(s.id); }
    if (!ids.size) { toast("No drawings inside that box.", 1500); return; }
    inkSel = { p: op.p, ids }; placeInkSel();
    return;
  }
  if (op.kind === "scale") {
    if (!inkSel) return;
    inkSel.moving = false;
    if (op.moved && Math.abs(op.k - 1) > 0.005) { const ids = new Set(inkSel.ids); scaleStrokes(op.p, ids, op.anchor, op.k); inkSel = { p: op.p, ids }; }
    drawInk(op.p); placeInkSel(); return;
  }
  // move
  if (!inkSel) return;
  inkSel.moving = false;
  if (!op.moved) { drawInk(op.p); placeInkSel(); return; }
  const sb = inkSel.box, w = sb.x1 - sb.x0, h = sb.y1 - sb.y0;
  const left = op.cx - op.grab[0] * zoom, top = op.cy - op.grab[1] * zoom;
  const q = pageAtClient(left + w * zoom / 2, top + h * zoom / 2), qr = views[q].el.getBoundingClientRect(), P = doc.pages[q];
  // keep it on the page it's dropped on
  const nx0 = clamp((left - qr.left) / zoom, 0, Math.max(0, P.w - w)), ny0 = clamp((top - qr.top) / zoom, 0, Math.max(0, pageDispH(q) - h));
  const ids = new Set(inkSel.ids);
  moveStrokes(op.p, q, ids, nx0 - sb.x0, ny0 - sb.y0);
  inkSel = { p: q, ids }; drawInk(op.p); placeInkSel();
}
// ---------------- tools ----------------
function setTool(t) {
  if (t === "boxes") { setBoxMode(!boxMode); return; }
  if (boxMode) setBoxMode(false);
  tool = t; $$(".tool").forEach(b => b.classList.toggle("on", b.dataset.tool === t));
  if (t === "pen" || t === "hl" || t === "smart") drawTool = t;
  views.forEach(toolClass);
  if (t !== "select") clearInkSel();
  if (t === "select") { const f = document.activeElement; if (f && f.classList.contains("ans")) f.blur(); hideHover(); }
  if (t !== "text" && t !== "smart") hideHandles();
  if (t === "text") hideHover();
  saveView();
}
function toolClass(v) { v.el.classList.toggle("tool-eraser", tool === "eraser"); v.el.classList.toggle("tool-text", tool === "text"); v.el.classList.toggle("tool-select", tool === "select"); }
$$(".tool").forEach(b => b.onclick = () => { toolAuto = false; setTool(b.dataset.tool); });
$$(".sw").forEach(b => b.onclick = () => { colour = b.dataset.c; $$(".sw").forEach(x => x.classList.toggle("on", x === b)); if (tool !== "pen" && tool !== "smart") { toolAuto = false; setTool("pen"); } });
// ---- which tool to start on: Pen on an iPad or anywhere an Apple Pencil has been used, Text on a laptop ----
let toolAuto = false;   // true while the tool is the automatic choice (the user hasn't picked one)
function deviceDefaultTool() {
  let pen = false; try { pen = localStorage.getItem("hasPen") === "1"; } catch (e) {}
  const touchFirst = matchMedia("(pointer: coarse)").matches || (navigator.maxTouchPoints > 1 && /Macintosh|iPad/.test(navigator.userAgent));
  return pen || touchFirst ? "pen" : "text";
}
function sawPen() {
  try { localStorage.setItem("hasPen", "1"); } catch (e) {}
  if (toolAuto && tool === "text") { setTool("pen"); toast("Apple Pencil found: switched to Pen. Pick Text or Smart in the toolbar any time."); }
}
$$(".sz").forEach(b => b.onclick = () => { width = +b.dataset.w; $$(".sz").forEach(x => x.classList.toggle("on", x === b)); setTool("pen"); });
$("#hintBtn").onclick = e => { const on = $("#pages").classList.toggle("hints"); e.currentTarget.classList.toggle("on", on); saveView(); };
$("#homeBtn").onclick = () => showHome();
document.addEventListener("keydown", e => {
  if (!doc || $("#editor").hidden) return;
  const typing = /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName);
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === "y" && !typing) { e.preventDefault(); redo(); return; }
  if (mod && (e.key === "=" || e.key === "+" || e.key === "-")) { e.preventDefault(); setZoom(zoom * (e.key === "-" ? 1 / 1.2 : 1.2)); return; }
  if (mod && e.key === "0") { e.preventDefault(); setZoom(fitWidthZoom()); return; }
  if (mod && e.key.toLowerCase() === "g") { e.preventDefault(); openJump(); return; }
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveNow(); toast(window.Sync && Sync.user ? "Saved and synced to your account." : "Saved in this browser. Sign in to sync it to your other devices."); return; }
  if (typing || mod || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "g" && !boxMode) { e.preventDefault(); openJump(); return; }
  if (k === "n" && !boxMode) { e.preventDefault(); nextEmpty(); return; }
  if (e.key.length === 1 && /[\p{L}\p{N}]/u.test(e.key) && !boxMode) { toast("Click or tap an answer space first, then type."); return; }
  if (k === "tab") { e.preventDefault(); const all = orderedRegions(); const first = all.find(([p, r]) => !doc.text[r.id]) || all[0]; if (first) focusNext(first[1], 0); }
  else if ((k === "delete" || k === "backspace") && boxMode && sel) { e.preventDefault(); deleteSel(); }
  else if ((k === "delete" || k === "backspace") && inkSel) { e.preventDefault(); deleteInkSel(); }
  else if (k === "escape" && inkSel) clearInkSel();
  else if (inkSel && /^arrow/.test(k)) { e.preventDefault(); const d = e.shiftKey ? 10 : 1; nudgeInkSel(k === "arrowleft" ? -d : k === "arrowright" ? d : 0, k === "arrowup" ? -d : k === "arrowdown" ? d : 0); }
  else if (k === "escape" && boxMode) setBoxMode(false);
});

// ---------------- counts ----------------
// what's counted: every answer space, plus each multiple-choice question once (all its options together)
function answerUnits() {
  if (!doc) return [];
  const units = [], groups = new Map(); let idx = null;
  doc.pages.forEach((P, p) => { if (!P) return; for (const r of P.regions) {
    if (r.kind !== "choice") { units.push({ ids: [r.id] }); continue; }
    idx ||= labelIndex();
    const key = labelAt(idx, p, r.y0 + 2) + "|" + (idx.length ? "" : p);
    if (!groups.has(key)) { const u = { ids: [], choice: true }; groups.set(key, u); units.push(u); }
    groups.get(key).ids.push(r.id);
  } });
  return units;
}
function totalRegions() { return answerUnits().length; }
function filledCount() { return answerUnits().filter(u => u.ids.some(id => (doc.text[id] || "").trim())).length; }
function updateCount() { $("#count").textContent = `${filledCount()}/${totalRegions()} answered`; }

// ---------------- box editing ----------------
let boxMode = false, sel = null; // sel = {p, r}
function setBoxMode(on) {
  if (on) { clearInkSel(); if (selOp) cancelSelOp(); }
  boxMode = on; $("#boxBar").hidden = !on; $("#editor").classList.toggle("boxmode", on);
  $$(".tool").forEach(b => b.classList.toggle("on", on ? b.dataset.tool === "boxes" : b.dataset.tool === tool));
  sel = null; updateSelTools();
  doc.pages.forEach((P, p) => { drawBoxes(p); drawMarkers(p); });
}
const KIND_NAME = { lines: "Lines", box: "Box", cell: "Cell", choice: "Choice" };
function drawBoxes(p) {
  const v = views[p]; if (!v) return; $$(".bx,.rubber", v.el).forEach(e => e.remove());
  if (!boxMode) return;
  for (const r of doc.pages[p].regions) {
    const R = regionRect(p, r), d = document.createElement("div");
    d.className = "bx" + (sel && sel.r === r ? " sel" : "");
    d.style.left = R.x0 * zoom + "px"; d.style.top = R.y0 * zoom + "px"; d.style.width = (R.x1 - R.x0) * zoom + "px"; d.style.height = (R.y1 - R.y0) * zoom + "px";
    d.innerHTML = `<b>${KIND_NAME[r.kind]}${r.kind === "lines" ? " ×" + r.ys.length : ""}${r.code ? " · code" : ""}</b><i></i>`;
    d.dataset.rid = r.id; v.el.appendChild(d);
  }
  // question markers: a box over each printed question number, labelled with the question it starts
  const lab = new Map(labelIndex().filter(e => e.p === p).map(e => [e.m, e.label]));
  for (const m of doc.pages[p].qs || []) {
    const R = markerRect(p, m), d = document.createElement("div");
    d.className = "bx q" + (sel && sel.r === m ? " sel" : "");
    d.style.left = R.x0 * zoom + "px"; d.style.top = R.y0 * zoom + "px"; d.style.width = (R.x1 - R.x0) * zoom + "px"; d.style.height = (R.y1 - R.y0) * zoom + "px";
    d.innerHTML = `<b>Q ${(lab.get(m) || m.tok).replace(/</g, "")}</b><i></i>`;
    d.dataset.qid = m.id; d.title = "Question marker: Go to jumps here. Drag to move, corner to resize."; v.el.appendChild(d);
  }
}
function updateSelTools() {
  $("#selTools").hidden = !sel;
  if (!sel) return;
  $("#codeBtn").hidden = !!sel.q;
  if (sel.q) { const e = labelIndex().find(x => x.m === sel.r); $("#kindBtn").textContent = "Label: " + (e ? e.label : sel.r.tok); $("#delBtn").textContent = "Delete marker"; return; }
  $("#delBtn").textContent = "Delete space";
  $("#kindBtn").textContent = "Type: " + KIND_NAME[sel.r.kind]; $("#codeBtn").textContent = "Code: " + (sel.r.code ? "on" : "off");
}
// what a question marker says: its own number or part ("5", "b", "ii"); a full label like 4(b)(ii) uses its last part
function askMarkerLabel(cur) {
  const v = prompt("What's printed here? A question number (5), a part (b) or a sub-part (ii). AQA parts like 06.2 work too.", cur || "");
  if (v === null) return null;
  const t = Questions.parseTok(v);
  if (!t) { toast("That isn't a question number or part. Try 5, b or ii."); return null; }
  return t;
}
$$(".nk").forEach(b => b.onclick = () => { newKind = b.dataset.k; $$(".nk").forEach(x => x.classList.toggle("on", x === b)); });
$("#doneBoxes").onclick = () => setBoxMode(false);
$("#delBtn").onclick = () => deleteSel();
$("#kindBtn").onclick = () => {
  if (sel && sel.q) { const t = askMarkerLabel(sel.r.num ? "." + sel.r.tok : sel.r.tok); if (!t) return; const m = sel.r; m.lvl = t.lvl; m.tok = t.tok; if (t.num) m.num = true; else delete m.num; pageChanged(sel.p); doc.pages.forEach((P, q) => drawBoxes(q)); updateSelTools(); return; }
  if (!sel) return; const order = ["lines", "box", "cell"]; const nk = order[(order.indexOf(sel.r.kind) + 1) % 3]; convertKind(sel.p, sel.r, nk); };
$("#codeBtn").onclick = () => { if (!sel) return; sel.r.code = !sel.r.code; rebuildField(sel.p, sel.r); pageChanged(sel.p); };
function currentPage() { const host = $("#pages"); let p = 0; const mid = host.scrollTop + host.clientHeight / 3; views.forEach((v, i) => { if (v.el.offsetTop <= mid) p = i; }); return p; }
$("#redetect").onclick = async () => {
  const p = currentPage();
  busy(true, `Finding answer spaces on page ${p + 1}…`);
  const old = doc.pages[p].regions; const fresh = await detectPage(p, null);
  fresh.regions.forEach(r => r.id = `${p}:d${rid8()}`);
  for (const o of old) {
    const t = doc.text[o.id]; delete doc.text[o.id]; delete doc.fit[o.id]; emit("text:" + o.id);
    if (!t) continue;
    let best = null, bo = 0;
    for (const n of fresh.regions) { const ov = Math.max(0, Math.min(o.x1, n.x1) - Math.max(o.x0, n.x0)) * Math.max(0, Math.min(o.y1, n.y1) - Math.max(o.y0, n.y0)); if (ov > bo) { bo = ov; best = n; } }
    if (best) { doc.text[best.id] = (doc.text[best.id] ? doc.text[best.id] + "\n" : "") + t; emit("text:" + best.id); }
    else toast("Some typed text had no matching box and was removed.", 4000);
  }
  doc.pages[p].gaps = {}; doc.pages[p].regions = fresh.regions; doc.pages[p].items = fresh.items; delete doc.pages[p].qs;
  await findQuestions();
  rebuildPageFields(p); pageChanged(p); busy(false); toast(`Page ${p + 1}: ${fresh.regions.length} answer spaces.`);
};
function pageChanged(p) { emit("page:" + p); scheduleSave(); }
function rebuildPageFields(p) { $$(".ans,.ansshape,.choice", views[p].el).forEach(e => e.remove()); doc.pages[p].regions.forEach(r => makeField(p, r)); layoutPage(p); doc.pages[p].regions.forEach(r => queueFit(p, r)); updateCount(); }
function rebuildField(p, r) { if (r._el) r._el.remove(); if (r._shape) { r._shape.remove(); r._shape = null; } makeField(p, r); delete doc.fit[r.id]; layoutPage(p); queueFit(p, r); updateSelTools(); scheduleSave(); }
function deleteSel() {
  if (sel && sel.q) { const { p, r } = sel, P = doc.pages[p]; P.qs = (P.qs || []).filter(m => m !== r); sel = null; updateSelTools(); pageChanged(p); doc.pages.forEach((P2, q) => drawBoxes(q)); return; }
  if (!sel) return; const { p, r } = sel; const P = doc.pages[p];
  setGap(p, r, 0); P.regions.splice(P.regions.indexOf(r), 1); if (r._el) r._el.remove(); if (r._shape) r._shape.remove();
  if (doc.text[r.id]) toast("Box deleted. Its typed text was removed too.");
  delete doc.text[r.id]; delete doc.fit[r.id]; emit("text:" + r.id); sel = null; updateSelTools(); layoutPage(p); updateCount(); pageChanged(p);
}
function pageSpacing(p) { const s = doc.pages[p].regions.filter(r => r.kind === "lines" && r.ys.length > 1).map(r => r.sp).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 24; }
function convertKind(p, r, nk) {
  setGap(p, r, 0);
  if (nk === "lines") { const sp = r.sp || pageSpacing(p); const n = Math.max(1, Math.round((r.y1 - r.y0) / sp)); r.sp = sp; r.ys = Array.from({ length: n }, (_, i) => r.y0 + sp * (i + 1)); r.y1 = r.ys[n - 1] + 2; r.indent = 0; }
  else delete r.ys;
  r.kind = nk; r.cut = r.y1 + 3; rebuildField(p, r); pageChanged(p);
}
function setRegionRect(p, r, x0, y0, x1, y1) {
  r.x0 = Math.min(x0, x1); r.x1 = Math.max(x0, x1); y0 = Math.min(y0, y1); y1 = Math.max(y0, y1);
  if (r.kind === "lines") { const sp = r.sp || pageSpacing(p); const n = Math.max(1, Math.round((y1 - y0) / sp)); r.sp = sp; r.ys = Array.from({ length: n }, (_, i) => y0 + sp * (i + 1)); r.y0 = y0; r.y1 = r.ys[n - 1] + 2; r.indent = Math.min(r.indent || 0, r.x1 - r.x0 - 20); }
  else { r.y0 = y0; r.y1 = y1; }
  r.cut = r.y1 + 3;
}
$("#pages").addEventListener("pointerdown", e => {
  if (!boxMode) return;
  const pageEl = e.target.closest(".page"); if (!pageEl) return;
  const p = +pageEl.dataset.p, v = views[p];
  const b = v.el.getBoundingClientRect();
  const pt = ev => [(ev.clientX - b.left) / zoom, (ev.clientY - b.top) / zoom];
  const p0 = pt(e);
  const bx = e.target.closest(".bx");
  e.preventDefault();
  if (bx && bx.dataset.qid) {
    const m = (doc.pages[p].qs || []).find(q => q.id === bx.dataset.qid); if (!m) return;
    sel = { p, r: m, q: true }; updateSelTools(); drawBoxes(p);
    const resize = e.target.tagName === "I", o = { x0: m.x0, x1: m.x1, y0: m.y0, y1: m.y1 }, P = doc.pages[p];
    const mv = ev => { const q = pt(ev), dx = q[0] - p0[0], dy = q[1] - p0[1];
      if (resize) { m.x1 = clamp(o.x1 + dx, o.x0 + 4, P.w); m.y1 = clamp(o.y1 + dy, o.y0 + 4, P.h); }
      else { const w = o.x1 - o.x0, h = o.y1 - o.y0; m.x0 = clamp(o.x0 + dx, 0, P.w - w); m.y0 = clamp(o.y0 + dy, 0, P.h - h); m.x1 = m.x0 + w; m.y1 = m.y0 + h; }
      m.x0 = r2(m.x0); m.x1 = r2(m.x1); m.y0 = r2(m.y0); m.y1 = r2(m.y1); drawBoxes(p); };
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); pageChanged(p); doc.pages.forEach((P2, q) => drawBoxes(q)); updateSelTools(); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
    return;
  }
  if (bx) {
    const r = doc.pages[p].regions.find(q => q.id === bx.dataset.rid); sel = { p, r }; updateSelTools(); drawBoxes(p);
    const resize = e.target.tagName === "I";
    setGap(p, r, 0);
    const o = { x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1 };
    const mv = ev => { const q = pt(ev), dx = q[0] - p0[0], dy = q[1] - p0[1];
      if (resize) setRegionRect(p, r, o.x0, o.y0, Math.max(o.x0 + 12, o.x1 + dx), Math.max(o.y0 + 8, o.y1 + dy));
      else setRegionRect(p, r, o.x0 + dx, o.y0 + dy, o.x1 + dx, o.y1 + dy);
      layoutPage(p); };
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); delete doc.fit[r.id]; layoutPage(p); queueFit(p, r); pageChanged(p); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
    return;
  }
  sel = null; updateSelTools(); drawBoxes(p);
  const rb = document.createElement("div"); rb.className = "rubber"; v.el.appendChild(rb);
  let q = p0;
  const mv = ev => { q = pt(ev); rb.style.left = Math.min(p0[0], q[0]) * zoom + "px"; rb.style.top = Math.min(p0[1], q[1]) * zoom + "px"; rb.style.width = Math.abs(q[0] - p0[0]) * zoom + "px"; rb.style.height = Math.abs(q[1] - p0[1]) * zoom + "px"; };
  const up = () => {
    window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); rb.remove();
    const w = Math.abs(q[0] - p0[0]), h = Math.abs(q[1] - p0[1]);
    if (newKind === "q") {                                           // a new question marker
      if (w < 4 || h < 4) return;
      const t = askMarkerLabel(""); if (!t) return;
      const m = { id: "q" + p + "_u" + rid8(), lvl: t.lvl, tok: t.tok, ...(t.num ? { num: true } : {}), x0: r2(Math.min(p0[0], q[0])), x1: r2(Math.max(p0[0], q[0])), y0: r2(src(p, Math.min(p0[1], q[1]))), y1: r2(src(p, Math.max(p0[1], q[1]))) };
      (doc.pages[p].qs ||= []).push(m); sel = { p, r: m, q: true }; pageChanged(p); doc.pages.forEach((P2, k) => drawBoxes(k)); updateSelTools();
      return;
    }
    if (newKind === "choice" ? w < 5 || h < 5 : w < 12 || h < 8) return;
    const r = { id: `${p}:u${rid8()}`, kind: newKind, code: false, label: "" };
    if (newKind === "choice") { r.shape = w > h * 1.4 ? "oval" : "box"; r.opt = ""; }
    const y0 = src(p, Math.min(p0[1], q[1])), y1 = src(p, Math.max(p0[1], q[1]));
    if (newKind === "lines") { r.sp = Math.min(pageSpacing(p), h); r.indent = 0; }
    setRegionRect(p, r, Math.min(p0[0], q[0]), y0, Math.max(p0[0], q[0]), y1);
    doc.pages[p].regions.push(r); makeField(p, r); sel = { p, r }; updateSelTools(); layoutPage(p); updateCount(); pageChanged(p);
  };
  window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
});

// ---------------- timer ----------------
let timerIv = 0;
function timerInit() { clearInterval(timerIv); timerIv = setInterval(timerTick, 500); timerTick(); }
function fmtT(s) { const neg = s < 0; s = Math.abs(Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (neg ? "−" : "") + (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + ":" + String(x).padStart(2, "0"); }
function timerUsed(T) { return T.acc + (T.run ? (Date.now() - T.since) / 1000 : 0); }
function timerTick() {
  const T = doc && doc.timer, b = $("#timerBtn");
  if (!T) { $("#timerTxt").textContent = "Timer"; b.className = "timer"; return; }
  const el = timerUsed(T), show = T.up ? el : T.total - el;
  $("#timerTxt").textContent = fmtT(show);
  b.className = "timer" + (T.run ? " run" : "") + (!T.up && show <= T.total * 0.1 ? " low" : "") + (!T.up && show < 0 && T.run ? " over" : "");
}
$("#timerBtn").onclick = e => { const pop = $("#timerPop"); pop.hidden = !pop.hidden; const r = e.currentTarget.getBoundingClientRect(); pop.style.top = r.bottom + 6 + "px"; pop.style.left = Math.max(8, Math.min(window.innerWidth - 240, r.left - 60)) + "px"; if (doc.timer) { $("#tMin").value = Math.round(doc.timer.total / 60); $("#tUp").checked = doc.timer.up; } };
$("#tStart").onclick = () => { const T = doc.timer; const mins = clamp(+$("#tMin").value || 90, 1, 600); if (!T || (!T.run && T.acc === 0)) doc.timer = { total: mins * 60, up: $("#tUp").checked, acc: 0, run: true, since: Date.now() }; else if (!T.run) { T.run = true; T.since = Date.now(); T.up = $("#tUp").checked; T.total = mins * 60; } $("#timerPop").hidden = true; timerTick(); scheduleSave(); emit("timer"); };
$("#tPause").onclick = () => { const T = doc.timer; if (T && T.run) { T.acc += (Date.now() - T.since) / 1000; T.run = false; } timerTick(); scheduleSave(); emit("timer"); };
$("#tReset").onclick = () => { doc.timer = null; timerTick(); scheduleSave(); emit("timer"); };
document.addEventListener("pointerdown", e => { const pop = $("#timerPop"); if (!pop.hidden && !pop.contains(e.target) && !$("#timerBtn").contains(e.target)) pop.hidden = true; });

// ---------------- question labels ----------------
// the question markers (questions.js), in reading order, with their full labels ("4(b)(ii)")
function labelIndex() { return Questions.index(doc.pages); }
function labelAt(idx, p, y) { let lab = "?"; for (const e of idx) { if (e.p < p || (e.p === p && e.y <= y)) lab = e.label; else break; } return lab; }
// the printed wording just above an answer space (for marking without the paper)
function questionText(p, r, prevBottom) {
  const P = doc.pages[p];
  const junk = it => { const s = it.s.trim(); return /^\.{4,}|^\[\d+\]$|^PMT$|^©|^Turn over$|^Answer all questions\.?$|^BLANK PAGE$/i.test(s) || /^\s*\.+\s*$/.test(s) || (/^\d{1,3}$/.test(s) && it.x > 150 && it.y < 70); };
  const its = (P.items || []).filter(it => it.y > prevBottom + 1 && it.y < r.y0 + 6 && !junk(it));
  return its.sort((a, b) => a.y - b.y || a.x - b.x).map(it => it.s.replace(/\.{4,}/g, "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").slice(-500).trim();
}
function answerList(withQuestion) {
  const idx = labelIndex(); const out = [];
  doc.pages.forEach((P, p) => {
    let prev = 0;
    const groups = new Map();
    for (const r of [...P.regions].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
      if (r.kind === "choice") {
        const q = labelAt(idx, p, r.y0 + 2);
        let e = groups.get(q);
        if (!e) { e = { q, page: p + 1, type: "multiple choice", options: [], answer: [] }; if (withQuestion) { const qt = questionText(p, r, prev); if (qt) e.question = qt; } groups.set(q, e); out.push(e); }
        const o = r.opt || `option ${e.options.length + 1}`; e.options.push(o); if (doc.text[r.id]) e.answer.push(o);
        prev = Math.max(prev, r.y1); continue;
      }
      const e = { q: labelAt(idx, p, r.y0 + 6), page: p + 1 };
      if (r.label && r.label !== "label") e.part = r.label.replace(/[.\s]+$/, "").slice(0, 40);
      if (r.kind === "cell") e.cell = true;
      if (withQuestion) { const qt = questionText(p, r, prev); if (qt) e.question = qt; }
      e.answer = (doc.text[r.id] || "").trim();
      out.push(e); prev = Math.max(prev, r.y1);
    }
  });
  return out;
}

// ---------------- export: filled-in PDF ----------------
let fontCache = null;
const fontFiles = {};
async function fontFile(name) { if (!fontFiles[name]) fontFiles[name] = fetch("fonts/" + name).then(r => r.arrayBuffer()); return fontFiles[name]; }
async function fontBytes() { return Promise.all([fontFile(curFont.file), fontFile(MONO.file)]); }
function wrapText(text, font, size, width, indent) {
  const out = []; let first = true;
  for (const para of text.replace(/\t/g, "    ").split("\n")) {
    const toks = para.match(/\S+|\s+/g) || [""]; let line = ""; let avail = width - (first ? indent : 0);
    const W = s => font.widthOfTextAtSize(s, size);
    for (let tok of toks) {
      if (W(line + tok) <= avail || (!line && /^\s+$/.test(tok))) { line += tok; continue; }
      if (/^\s+$/.test(tok)) { out.push(line); first = false; line = ""; avail = width; continue; }
      if (line.trim()) { out.push(line.replace(/\s+$/, "")); first = false; line = ""; avail = width; }
      while (W(line + tok) > avail) {
        let k = 1; while (k < tok.length && W(line + tok.slice(0, k + 1)) <= avail) k++;
        out.push(line + tok.slice(0, k)); first = false; line = ""; avail = width; tok = tok.slice(k);
      }
      line += tok;
    }
    out.push(line.replace(/\s+$/, "")); first = false;
  }
  return out;
}
async function exportPDF() {
  const btn = $("#exportBtn"); btn.disabled = true;
  try {
    busy(true, "Building your PDF…", 0);
    const { PDFDocument, rgb, LineCapStyle } = PDFLib;
    const srcDoc = await PDFDocument.load(doc.bytes.slice(0), { ignoreEncryption: true, updateMetadata: false });
    const out = await PDFDocument.create(); out.registerFontkit(fontkit);
    const [fb1, fb2] = await fontBytes();
    const sans = await out.embedFont(fb1, { subset: true }), mono = await out.embedFont(fb2, { subset: true });
    const okS = new Set(sans.getCharacterSet()), okM = new Set(mono.getCharacterSet());
    const clean = (t, set) => [...t].map(ch => ch === "\n" || set.has(ch.codePointAt(0)) ? ch : (ch === "\t" ? "    " : "?")).join("");
    const hex = c => { const n = parseInt(c.slice(1), 16); return rgb((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255); };
    // copy every page in one go: PDFs whose pages share one bundle of images/fonts then keep sharing it,
    // instead of every page getting its own copy of everything (a 25-page scan once came out at 134 MB)
    const copied = await out.copyPages(srcDoc, srcDoc.getPageIndices());
    for (let p = 0; p < doc.pages.length; p++) {
      busy(true, `Building your PDF… page ${p + 1} of ${doc.pages.length}`, p / doc.pages.length);
      const P = doc.pages[p], srcPage = srcDoc.getPage(p), cb = srcPage.getCropBox(), rot = (srcPage.getRotation().angle % 360 + 360) % 360;
      const G = totalGap(p), gaps = gapList(p);
      let page, tx, ty;
      if (!G && rot === 0) {
        page = out.addPage(copied[p]);
        tx = x => cb.x + x; ty = y => cb.y + cb.height - y;
      } else {
        const newH = P.h + G; page = out.addPage([P.w, newH]); tx = x => x; ty = y => newH - y;
        const bands = gaps.map(g => ({ at: g.at, h: g.h })); bands.push({ at: P.h, h: 0 });
        if (rot === 0) {
          let sTop = 0, dTop = 0;
          for (const b of bands) {
            const hS = b.at - sTop;
            if (hS > 0.5) { const emb = await out.embedPage(copied[p], { left: cb.x, right: cb.x + cb.width, top: cb.y + cb.height - sTop, bottom: cb.y + cb.height - b.at }); page.drawPage(emb, { x: 0, y: newH - (dTop + hS), width: P.w, height: hS }); }
            dTop += hS + b.h; sTop = b.at;
          }
        } else { // rotated page: flatten it to a picture, then add everything on top
          const c2 = await pageRaster(p, 2.5, false);
          const img = await out.embedJpg(await (await fetch(c2.toDataURL("image/jpeg", 0.9))).arrayBuffer());
          page.drawImage(img, { x: 0, y: 0, width: P.w, height: P.h + G }); c2.width = 0;
        }
        for (const g of gaps) {
          const r = P.regions.find(q => q.id === g.rid);
          for (const y of gapRules(p, r, g)) page.drawLine({ start: { x: r.x0, y: ty(y) }, end: { x: r.x1, y: ty(y) }, thickness: 0.5, color: rgb(0.6, 0.63, 0.62), dashArray: [1.2, 2.2] });
        }
      }
      const ansCol = hex(ansStyle().c);
      for (const r of P.regions) {
        const raw = doc.text[r.id]; if (!raw || !raw.trim()) continue;
        if (r.kind === "choice") {                                       // a chosen box gets a tick, a chosen oval is filled in
          const R = regionRect(p, r), w = R.x1 - R.x0, h = R.y1 - R.y0;
          if (r.shape === "oval") { const m = choiceMark(r), mx0 = R.x0 + w * m[0], mx1 = R.x0 + w * m[2], my0 = R.y0 + h * m[1], my1 = R.y0 + h * m[3]; page.drawEllipse({ x: tx((mx0 + mx1) / 2), y: ty((my0 + my1) / 2), xScale: (mx1 - mx0) / 2, yScale: (my1 - my0) / 2, color: ansCol }); }
          else page.drawSvgPath(`M${R.x0 + w * 0.2} ${R.y0 + h * 0.55} L${R.x0 + w * 0.42} ${R.y0 + h * 0.8} L${R.x0 + w * 0.85} ${R.y0 + h * 0.18}`, { x: tx(0), y: ty(0), borderColor: ansCol, borderWidth: Math.max(1, h * 0.12), borderLineCap: LineCapStyle.Round });
          continue;
        }
        if (ansStyle().bg) { const R = regionRect(p, r); page.drawRectangle({ x: tx(R.x0 - 1), y: ty(R.y1 + 1), width: R.x1 - R.x0 + 2, height: R.y1 - R.y0 + 2, color: hex(ansStyle().bg), opacity: 0.45 }); }
        const font = r.code ? mono : sans, txt = clean(raw, r.code ? okM : okS);
        const R = regionRect(p, r), pad = r.kind === "box" ? 4 : 0, width = r.x1 - r.x0 - 2 * pad;
        const f0 = fitOf(r); let fs = f0.fs, L = f0.L, lines, top;
        for (;;) {
          lines = wrapText(txt, font, fs * fontScale(r), width, r.kind === "lines" ? r.indent || 0 : 0);
          top = fieldTop(p, r, { fs, L });
          const fitsNow = r.kind === "lines"
            ? top + (lines.length - 1) * L + baseInLine(fs, L) <= R.y1 - 3.5 + 0.5   // last baseline on or above the last printed line
            : top + lines.length * L <= R.y1 - pad + 0.5;
          if (fitsNow || fs <= 5) break;
          L = L * (fs - 0.25) / fs; fs = fs - 0.25;
        }
        if (r.kind === "cell") top = R.y0 + Math.max(0, ((R.y1 - R.y0) - lines.length * L) / 2);
        lines.forEach((ln, i) => {
          if (!ln) return;
          const w = font.widthOfTextAtSize(ln, fs * fontScale(r));
          const x = r.kind === "cell" ? (r.x0 + r.x1) / 2 - w / 2 : r.x0 + pad + (i === 0 && r.kind === "lines" ? r.indent || 0 : 0);
          page.drawText(ln, { x: tx(x), y: ty(top + i * L + baseInLine(fs, L)), size: fs * fontScale(r), font, color: ansCol });
          if (ansStyle().bold) page.drawText(ln, { x: tx(x) + fs * 0.035, y: ty(top + i * L + baseInLine(fs, L)), size: fs * fontScale(r), font, color: ansCol });   // a second pass a hair to the right: bold
        });
      }
      const S = (doc.strokes[p] || []).slice().sort((a, b) => (a.t === "hl" ? 0 : 1) - (b.t === "hl" ? 0 : 1));
      for (const s of S) {
        let pts = dispPts(p, s); if (!pts.length) continue;
        const runs = pressureRuns(s, pts), f2 = q => `${q[0].toFixed(2)} ${q[1].toFixed(2)}`;
        if (runs) {
          for (const run of runs) {
            const d = "M" + f2(run.segs[0].a) + run.segs.map(g => g.c ? ` Q${f2(g.c)} ${f2(g.b)}` : ` L${f2(g.b)}`).join("");
            page.drawSvgPath(d, { x: tx(0), y: ty(0), borderColor: hex(s.c), borderWidth: run.w, borderLineCap: LineCapStyle.Round });
          }
          continue;
        }
        if (pts.length === 1) pts = [pts[0], [pts[0][0] + 0.05, pts[0][1]]];
        const d = "M" + pts.map(f2).join(" L");
        page.drawSvgPath(d, { x: tx(0), y: ty(0), borderColor: hex(s.c), borderWidth: s.w, borderOpacity: s.t === "hl" ? 0.35 : 1, borderLineCap: s.t === "hl" ? LineCapStyle.Butt : LineCapStyle.Round });
      }
    }
    out.setTitle(doc.name + " (answered)"); out.setSubject(JSON.stringify(aiJSON(false))); out.setCreator("TypePDF"); out.setProducer("TypePDF");
    // carry the untouched paper and the answers inside, so opening this file in TypePDF brings back editable answers
    // (instead of answers baked into the page)
    await out.attach(new Uint8Array(doc.bytes.slice(0)), "typepdf-original.pdf", { mimeType: "application/pdf", description: "The original paper, for reopening in TypePDF" });
    await out.attach(new TextEncoder().encode(JSON.stringify({ format: "typepdf-state", v: 2, state: strip(doc) })), "typepdf-answers.json", { mimeType: "application/json", description: "Your answers, for reopening in TypePDF" });
    const bytes = await out.save();
    download(new Blob([bytes], { type: "application/pdf" }), doc.name + " - answered.pdf");
    busy(false); toast("PDF exported.");
  } catch (e) { console.error(e); busy(false); toast("Export failed: " + (e.message || e), 6000); }
  finally { btn.disabled = false; }
}
$("#exportBtn").onclick = exportPDF;
function download(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); }

// a page as a picture (with extra space, optionally with ink), for flattening and for AI crops
async function pageRaster(p, scale, withInk, grey) {
  const P = doc.pages[p], pg = await pdf.getPage(p + 1), vp = pg.getViewport({ scale });
  const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height); await pg.render({ canvasContext: cx, viewport: vp }).promise;
  const G = totalGap(p), c2 = document.createElement("canvas"); c2.width = c.width; c2.height = Math.ceil((P.h + G) * scale);
  const x2 = c2.getContext("2d"); x2.fillStyle = "#fff"; x2.fillRect(0, 0, c2.width, c2.height);
  let sTop = 0, dTop = 0; const bands = gapList(p).map(g => ({ at: g.at, h: g.h })); bands.push({ at: P.h, h: 0 });
  for (const b of bands) { const hS = b.at - sTop; if (hS > 0) x2.drawImage(c, 0, sTop * scale, c.width, hS * scale, 0, dTop * scale, c.width, hS * scale); dTop += hS + b.h; sTop = b.at; }
  c.width = 0;
  if (withInk) for (const pass of ["hl", "pen"]) for (const s of doc.strokes[p] || []) if ((s.t === "hl") === (pass === "hl")) drawStroke(x2, s, dispPts(p, s), scale);
  if (grey) x2.filter = "none";
  return c2;
}

// ---------------- export for AI: typed answers as JSON + only the hand-drawn work as a small PDF ----------------
function aiJSON(withQuestion) {
  const list = answerList(withQuestion);
  const answered = list.filter(e => e.answer), blank = list.filter(e => !e.answer).map(e => e.q + (e.part ? ` [${e.part}]` : "") + (e.cell ? " [cell]" : ""));
  // group table cells under one entry so a filled truth table reads as rows
  const answers = [];
  for (const e of answered) {
    const last = answers[answers.length - 1];
    if (e.cell && last && last.cells && last.q === e.q && last.page === e.page) { last.cells.push(e.answer); continue; }
    if (e.cell) { const { answer, cell, ...rest } = e; answers.push({ ...rest, cells: [answer] }); continue; }
    answers.push(e);
  }
  const o = { paper: doc.name, exported: new Date().toISOString() };
  if (doc.timer) o.time_used = fmtT(timerUsed(doc.timer)) + (doc.timer.up ? "" : " of " + fmtT(doc.timer.total));
  o.note = "Typed answers are listed by question number. Table cells are given left-to-right, top-to-bottom. Handwritten or drawn work is in the separate workings PDF, one cropped image per area, captioned with page and question.";
  o.answers = answers;
  if (blank.length) o.blank = [...new Set(blank)];
  const wk = workingsAreas(); if (wk.length) o.handwritten = wk.map(a => ({ q: a.q, page: a.p + 1 }));
  const idx = labelIndex(), fl = [];
  doc.pages.forEach((P, p) => P.regions.forEach(r => { if (doc.flags && doc.flags[r.id]) fl.push(labelAt(idx, p, r.y0 + 6) + (r.label && r.label !== "label" ? ` [${r.label.replace(/[.\s]+$/, "")}]` : "")); }));
  if (fl.length) o.flagged = fl;
  return o;
}
function workingsAreas() {
  const idx = labelIndex(); const areas = [];
  doc.pages.forEach((P, p) => {
    const boxes = (doc.strokes[p] || []).filter(s => s.t === "pen" && s.pts.length).map(s => { const pts = dispPts(p, s); const ys = pts.map(q => q[1]); return [Math.min(...ys), Math.max(...ys)]; }).sort((a, b) => a[0] - b[0]);
    const bands = [];
    for (const b of boxes) { const l = bands[bands.length - 1]; if (l && b[0] - l[1] < 70) l[1] = Math.max(l[1], b[1]); else bands.push([b[0], b[1]]); }
    const H = P.h + totalGap(p);
    for (const b of bands) { const y0 = Math.max(0, b[0] - 100), y1 = Math.min(H, b[1] + 18); areas.push({ p, y0, y1, q: labelAt(idx, p, src(p, b[0])) }); }
  });
  return areas;
}
async function workingsPDF() {
  const areas = workingsAreas(); if (!areas.length) return null;
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const out = await PDFDocument.create(); const font = await out.embedFont(StandardFonts.Helvetica);
  const scale = 1.6; let lastP = -1, ras = null;
  for (let i = 0; i < areas.length; i++) {
    const a = areas[i]; busy(true, `Preparing workings… ${i + 1} of ${areas.length}`, i / areas.length);
    if (a.p !== lastP) { if (ras) ras.width = 0; ras = await pageRaster(a.p, scale, true); lastP = a.p; }
    const P = doc.pages[a.p], hPt = a.y1 - a.y0;
    const c = document.createElement("canvas"); c.width = Math.round(P.w * scale); c.height = Math.round(hPt * scale);
    const cx = c.getContext("2d"); cx.filter = "grayscale(1)"; cx.drawImage(ras, 0, a.y0 * scale, c.width, c.height, 0, 0, c.width, c.height);
    const img = await out.embedJpg(await (await fetch(c.toDataURL("image/jpeg", 0.72))).arrayBuffer()); c.width = 0;
    const page = out.addPage([P.w, hPt + 18]);
    page.drawImage(img, { x: 0, y: 0, width: P.w, height: hPt });
    page.drawText(`Page ${a.p + 1} · Question ${a.q}`, { x: 10, y: hPt + 5, size: 9, font, color: rgb(0.2, 0.2, 0.2) });
  }
  if (ras) ras.width = 0;
  out.setTitle(doc.name + " – handwritten workings"); out.setCreator("TypePDF");
  return out.save();
}
$("#aiBtn").onclick = async () => { await ensureOcr(); $("#aiDlg").showModal(); updateAiInfo(); };
$("#aiQ").onchange = updateAiInfo;
function updateAiInfo() {
  const o = aiJSON($("#aiQ").checked); const txt = JSON.stringify(o);
  const wk = workingsAreas();
  $("#aiInfo").textContent = `${o.answers.length} typed answers, ${(o.blank || []).length} blank. ${wk.length ? wk.length + " area" + (wk.length > 1 ? "s" : "") + " of handwriting go in the workings PDF." : "No handwriting, so no workings PDF is needed."} About ${Math.round(txt.length / 4).toLocaleString()} tokens of text.`;
  $("#aiWork").disabled = !wk.length;
}
$("#aiCopy").onclick = async () => { const t = JSON.stringify(aiJSON($("#aiQ").checked), null, 1); try { await navigator.clipboard.writeText(t); toast("Answers copied as JSON."); } catch (e) { fallbackCopy(t); } };
$("#aiJson").onclick = () => download(new Blob([JSON.stringify(aiJSON($("#aiQ").checked), null, 1)], { type: "application/json" }), doc.name + " - answers.json");
$("#aiWork").onclick = async () => { try { const b = await workingsPDF(); busy(false); if (b) download(new Blob([b], { type: "application/pdf" }), doc.name + " - workings.pdf"); } catch (e) { busy(false); toast("Couldn't build the workings PDF: " + e.message); } };
$("#aiBoth").onclick = async () => { $("#aiJson").click(); if (!$("#aiWork").disabled) setTimeout(() => $("#aiWork").click(), 600); };
$("#aiClose").onclick = () => $("#aiDlg").close();
function fallbackCopy(t) { const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); toast("Copied."); }

// ---------------- backups ----------------
function b64(buf) { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; }
function downloadBackup(d) { const o = { format: "typepdf", v: 2, pdf: b64(d.bytes), state: strip(d) }; download(new Blob([JSON.stringify(o)], { type: "application/json" }), d.name + ".typepdf"); }
async function fromExport(buf) {
  let t = null;
  try {
    t = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false }).promise;
    const att = await t.getAttachments(); if (!att) return null;
    const orig = att["typepdf-original.pdf"], st = att["typepdf-answers.json"];
    if (!orig || !st) return null;
    const o = JSON.parse(new TextDecoder().decode(st.content)); if (o.format !== "typepdf-state" || !o.state) return null;
    const d = o.state; d.bytes = orig.content.buffer.slice(orig.content.byteOffset, orig.content.byteOffset + orig.content.byteLength);
    d.seq = 0; d.dirty = {};
    return d;
  } catch (e) { return null; } finally { if (t) t.destroy(); }
}
async function openRestored(d) {
  const mine = await DB.get(d.id).catch(() => null);
  if (mine && (mine.updated || 0) > (d.updated || 0)) { toast("You already have a newer copy of this paper here, so that's what's open. The export was older."); return openDoc(mine); }
  toast("This is a TypePDF export, so the original paper and your answers are back, all editable.", 5000);
  if (window.Sync && Sync.user) { await DB.put(d).catch(() => {}); await DB.putMeta({ id: d.id, name: d.name, pdf: d.pdf || d.id, updated: d.updated || Date.now(), local: true, owner: Sync.info && Sync.info.user }).catch(() => {}); }
  return openDoc(d);
}
async function openBackup(buf) {
  try {
    const o = JSON.parse(new TextDecoder().decode(buf)); if (!/^(typepdf|paperwork)$/.test(o.format)) throw new Error("not a TypePDF backup");
    const d = o.state; d.bytes = unb64(o.pdf); d.seq = 0; d.dirty = {}; await DB.put(d); toast("Backup restored."); openDoc(d);
  } catch (e) { toast("Couldn't open that backup: " + e.message); }
}

window.addEventListener("beforeunload", e => {
  if (!doc) return;
  saveView();
  if (canSave()) DB.put(doc);
  else if (!doc.shared && hasWork()) { e.preventDefault(); e.returnValue = ""; }    // nothing is saved without an account: ask before leaving
});
// ---------------- flags: mark an answer space to come back to ----------------
let flagFor = null;   // {p, r} of the focused answer space
function showFlagFloat(p, r) { flagFor = { p, r }; placeFlagFloat(); }
function hideFlagFloat() { flagFor = null; const b = $("#flagFloat"); if (b) b.hidden = true; const c = $("#codeFloat"); if (c) c.hidden = true; }
function placeFlagFloat() {
  const b = $("#flagFloat"); if (!flagFor || !b) return;
  const { p, r } = flagFor, v = views[p]; if (!v) return;
  const R = regionRect(p, r), on = !!(doc.flags && doc.flags[r.id]);
  if (b.parentElement !== v.el) v.el.appendChild(b);
  b.hidden = false; b.classList.toggle("on", on);
  b.textContent = on ? "⚑ Flagged" : "⚑ Flag";
  b.title = on ? "Remove the flag" : "Flag this to come back to (e.g. to draw it on the iPad, or because it's hard)";
  // just outside the box, halfway down its right-hand side
  const ta = r._el;
  b.style.left = (ta.offsetLeft + ta.offsetWidth + 8) + "px";
  b.style.top = (ta.offsetTop + ta.offsetHeight / 2 - b.offsetHeight / 2) + "px";
  // the code switch sits just right of the flag
  const c = $("#codeFloat");
  if (c) {
    if (c.parentElement !== v.el) v.el.appendChild(c);
    c.hidden = r.kind === "cell"; c.classList.toggle("on", !!r.code);
    c.textContent = r.code ? "</> Code on" : "</> Code";
    c.title = r.code ? "Code mode is on: monospace, no capitals or corrections, Tab indents. Click to turn it off." : "Typing code? Turn on code mode: monospace, no capitals or corrections, Tab indents.";
    c.style.left = parseFloat(b.style.left) + b.offsetWidth + 4 + "px"; c.style.top = b.style.top;
  }
}
function toggleFlag(p, r) {
  doc.flags ||= {};
  if (doc.flags[r.id]) delete doc.flags[r.id]; else doc.flags[r.id] = Date.now();
  emit("flag:" + r.id); layoutPage(p); renderFlags(); scheduleSave();
  toast(doc.flags[r.id] ? "Flagged. Find it again under Flags." : "Flag removed.");
}
$("#flagFloat").addEventListener("pointerdown", e => e.preventDefault());   // keep the cursor in the answer
$("#codeFloat").addEventListener("pointerdown", e => e.preventDefault());
$("#codeFloat").addEventListener("click", () => { if (!flagFor) return; const { p, r } = flagFor; setCode(p, r, !r.code, true); toast(r.code ? "Code mode on for this space." : "Code mode off for this space.", 1500); });
$("#flagFloat").addEventListener("click", () => { if (flagFor) toggleFlag(flagFor.p, flagFor.r); placeFlagFloat(); });
function renderFlags() {
  const n = doc ? Object.keys(doc.flags || {}).filter(id => findRegion(id)).length : 0;
  $("#flagsBtn").textContent = n ? `⚑ ${n}` : "⚑ Flags"; $("#flagsBtn").classList.toggle("has", n > 0);
}
$("#flagsBtn").onclick = e => {
  const pop = $("#flagsPop");
  if (!pop.hidden) { pop.hidden = true; return; }
  const idx = labelIndex(), rows = [];
  doc.pages.forEach((P, p) => [...P.regions].sort((a, b) => a.y0 - b.y0).forEach(r => { if (doc.flags[r.id]) rows.push({ p, r, q: labelAt(idx, p, r.y0 + 6) }); }));
  pop.innerHTML = rows.length ? `<b>Flagged answer spaces</b>` : `<b>No flags yet</b><p>Click into an answer space and press ⚑ Flag to mark it to come back to.</p>`;
  for (const x of rows) {
    const b = document.createElement("button"); const t = (doc.text[x.r.id] || "").trim();
    b.innerHTML = `<span>Q${x.q}${x.r.label && x.r.label !== "label" ? " · " + x.r.label.replace(/[.\s]+$/, "") : ""}</span><small>page ${x.p + 1}${t ? " · " + t.slice(0, 40).replace(/</g, "&lt;") : " · not answered"}</small>`;
    b.onclick = () => { pop.hidden = true; const ta = x.r._el; ta.scrollIntoView({ block: "center", behavior: "smooth" }); ta.focus({ preventScroll: true }); };
    pop.appendChild(b);
  }
  const r = e.currentTarget.getBoundingClientRect(); pop.style.top = r.bottom + 6 + "px"; pop.style.left = Math.max(8, Math.min(window.innerWidth - 300, r.left - 120)) + "px"; pop.hidden = false;
};
document.addEventListener("pointerdown", e => { const pop = $("#flagsPop"); if (pop && !pop.hidden && !pop.contains(e.target) && !$("#flagsBtn").contains(e.target)) pop.hidden = true; });

// ---------------- jump to a question or page, and to the next empty answer space ----------------
// an answer space counts as answered when something is typed in it or any ink has been drawn inside it
function inkedRegions() {
  const out = new Set();
  doc.pages.forEach((P, p) => {
    const S = doc.strokes[p] || []; if (!S.length || !P) return;
    const rects = P.regions.map(r => [r.id, regionRect(p, r)]);
    for (const s of S) {
      if (s.t === "hl") continue;                                    // highlighting the question isn't an answer
      const pts = dispPts(p, s), step = Math.max(1, Math.floor(pts.length / 12));
      for (let i = 0; i < pts.length; i += step) { const q = pts[i]; for (const [id, R] of rects) if (!out.has(id) && q[0] >= R.x0 - 2 && q[0] <= R.x1 + 2 && q[1] >= R.y0 - 4 && q[1] <= R.y1 + 4) out.add(id); }
    }
  });
  return out;
}
const isAnswered = (r, inked) => !!((doc.text[r.id] || "").trim() || inked.has(r.id));
const normQ = s => String(s).toLowerCase().replace(/^\s*(question|q)\s*/, "").replace(/^0+(?=\d)/, "").replace(/[\s().,]/g, "");
// every question label in reading order, with the answer spaces that belong to it
// answered or not, per answer unit (a multiple-choice question is answered once any of its options is chosen or drawn on)
function unitChecker() {
  const inked = inkedRegions(), unitOf = new Map();
  for (const u of answerUnits()) for (const id of u.ids) unitOf.set(id, u);
  const done = u => u.ids.some(id => (doc.text[id] || "").trim() || inked.has(id));
  return { unitOf: id => unitOf.get(id), done };
}
function questionMap() {
  const idx = labelIndex(), U = unitChecker(), byLabel = new Map();
  for (const e of idx) if (!byLabel.has(e.label)) byLabel.set(e.label, { label: e.label, q: e.q, p: e.p, y: e.y, m: e.m, regions: [] });
  for (const [p, r] of orderedRegions(true)) { const lab = labelAt(idx, p, r.y0 + (r.kind === "choice" ? 2 : 6)); const e = byLabel.get(lab); if (e) e.regions.push([p, r]); }
  const list = [...byLabel.values()];
  for (const e of list) {
    const us = [...new Set(e.regions.map(([, r]) => U.unitOf(r.id)).filter(Boolean))], n = us.filter(U.done).length;
    e.total = us.length; e.done = n; e.flag = e.regions.some(([, r]) => doc.flags && doc.flags[r.id]);
    e.state = !e.total ? "" : n === e.total ? "done" : n ? "part" : "";
  }
  return list;
}
function flashRegions(list) {
  for (const [, r] of list) { const ta = r._el; if (!ta) continue; ta.classList.remove("jumpflash"); void ta.offsetWidth; ta.classList.add("jumpflash"); setTimeout(() => ta.classList.remove("jumpflash"), 1600); }
}
// scroll so a point on a page sits near the top of the screen (glides when it's close by)
function scrollToPoint(p, y, frac = 0.18) {
  const host = $("#pages"), v = views[p]; if (!v) return;
  const target = clamp(pageTop(p) + disp(p, y) * zoom - host.clientHeight * frac, 0, host.scrollHeight - host.clientHeight);
  if (Math.abs(target - host.scrollTop) < host.clientHeight * 6) glideTo(host, target); else { cancelAnimationFrame(glideRaf); host.scrollTop = target; }
}
// typing straight in only makes sense with a keyboard tool; with the pen the space just lights up
function canFocusOnJump() { return (tool === "text" || tool === "smart") && !matchMedia("(pointer: coarse)").matches && !(doc.shared && doc.shared.role === "view"); }
function goToQuestion(e) {
  if (!e) return;
  hideJump();
  scrollToPoint(e.p, e.y, 0.12);
  flashRegions(e.regions);
  const mk = e.m && $(`.qmark[data-qid="${e.m.id}"]`); if (mk) { mk.classList.remove("flash"); void mk.offsetWidth; mk.classList.add("flash"); }
  const typed = e.regions.filter(([, r]) => r.kind !== "choice");
  const first = typed.find(([, r]) => !(doc.text[r.id] || "").trim()) || typed[0];
  if (first && canFocusOnJump()) { const ta = first[1]._el; ta.focus({ preventScroll: true }); const L = ta.value.length; ta.setSelectionRange(L, L); }
  lastJump = e.label;
}
function goToPage(n) {
  const p = clamp(n - 1, 0, views.length - 1); hideJump();
  const host = $("#pages"); cancelAnimationFrame(glideRaf); host.scrollTop = pageTop(p) - 12;
  toast(`Page ${p + 1} of ${views.length}`, 1200);
}
let lastJump = "";
function jumpTo(text) {
  const t = text.trim(); if (!t) return;
  const pm = t.match(/^p(?:age|g)?\.?\s*(\d+)$/i);
  if (pm) return goToPage(+pm[1]);
  const want = normQ(t), list = questionMap();
  const hit = list.find(e => normQ(e.label) === want) || list.find(e => normQ(e.label).startsWith(want));
  if (hit) return goToQuestion(hit);
  if (/^\d+$/.test(t) && !list.length) return goToPage(+t);    // no question numbers on this paper: a number means a page
  toast(list.length ? `There's no question ${t} on this paper. Type p${t} to go to page ${t}.` : "No question numbers were found on this paper. Type p and a page number, e.g. p3.", 4000);
}
function hideJump() { $("#jumpPop").hidden = true; }
function openJump(anchorEl) {
  if (!doc) return;
  const pop = $("#jumpPop"), list = $("#jumpList");
  if (!pop.hidden) { hideJump(); return; }
  const qs = questionMap(), cur = currentPage();
  list.innerHTML = "";
  if (qs.length) {
    // one row per question number, with its parts as chips
    const groups = []; for (const e of qs) { const g = groups[groups.length - 1]; if (g && g.q === e.q) g.items.push(e); else groups.push({ q: e.q, items: [e] }); }
    for (const g of groups) {
      const row = document.createElement("div"); row.className = "jrow";
      const n = g.items.reduce((s, e) => s + e.total, 0), done = g.items.reduce((s, e) => s + e.done, 0);
      const head = document.createElement("button"); head.type = "button"; head.className = "jq " + (n && done === n ? "done" : done ? "part" : "") + (g.items.some(e => e.flag) ? " flag" : "") + (g.items.some(e => e.label === lastJump) ? " last" : "");
      head.innerHTML = `<b>Q${g.q}</b><small>${n ? `${done}/${n}` : "–"} · p${g.items[0].p + 1}</small>`;
      head.title = `Question ${g.q}, page ${g.items[0].p + 1}` + (n ? `: ${done} of ${n} answer spaces answered` : "");
      head.onclick = () => goToQuestion(g.items[0]);
      row.appendChild(head);
      for (const e of g.items) {
        if (e.label === g.q) continue;
        const c = document.createElement("button"); c.type = "button"; c.className = "jc " + e.state + (e.flag ? " flag" : "") + (e.label === lastJump ? " last" : "");
        c.textContent = e.label.slice(g.q.length).replace(/^\./, "").replace(/\)\(/g, " ").replace(/[()]/g, "");
        c.title = e.total ? `${e.label}: ${e.done} of ${e.total} answered` + (e.flag ? " · flagged" : "") : `${e.label}: the start of this part`;
        c.onclick = () => goToQuestion(e);
        row.appendChild(c);
      }
      list.appendChild(row);
    }
  } else {
    const m = document.createElement("p"); m.className = "note"; m.textContent = "No question numbers were found on this paper, so jump by page. To add them, use Boxes → Question and drag a box over each printed number."; list.appendChild(m);
  }
  // pages, always
  const pr = document.createElement("div"); pr.className = "jpages";
  views.forEach((v, i) => { const b = document.createElement("button"); b.type = "button"; b.textContent = i + 1; b.title = `Page ${i + 1}`; if (i === cur) b.className = "on"; b.onclick = () => goToPage(i + 1); pr.appendChild(b); });
  const lab = document.createElement("small"); lab.textContent = "Pages"; list.append(lab, pr);
  const r = (anchorEl || $("#jumpBtn")).getBoundingClientRect(), W = Math.min(340, window.innerWidth - 16);
  pop.style.width = W + "px"; pop.hidden = false;
  pop.style.left = clamp(r.left + r.width / 2 - W / 2, 8, window.innerWidth - W - 8) + "px";
  if (r.top > window.innerHeight / 2) { pop.style.top = ""; pop.style.bottom = window.innerHeight - r.top + 6 + "px"; }
  else { pop.style.bottom = ""; pop.style.top = r.bottom + 6 + "px"; }
  $("#jumpIn").value = "";
  if (!matchMedia("(pointer: coarse)").matches) $("#jumpIn").focus();
  const lastEl = $(".last", list); if (lastEl) lastEl.scrollIntoView({ block: "nearest" });
}
$("#jumpBtn").onclick = e => openJump(e.currentTarget);
$("#pageInd").onclick = e => openJump(e.currentTarget);
$("#jumpForm").addEventListener("submit", e => { e.preventDefault(); jumpTo($("#jumpIn").value); });
$("#jumpIn").addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); hideJump(); } });
document.addEventListener("pointerdown", e => { const pop = $("#jumpPop"); if (!pop.hidden && !pop.contains(e.target) && !$("#jumpBtn").contains(e.target) && !$("#pageInd").contains(e.target)) hideJump(); });
// the next answer space after the one you're in (or after what's on screen) with nothing written in it yet
function nextEmpty() {
  if (!doc) return;
  const all = orderedRegions(true), U = unitChecker(); if (!all.length) return;
  const a = document.activeElement, host = $("#pages");
  let from = a && a.classList && a.classList.contains("ans") ? all.findIndex(([, r]) => r._el === a) : -1;
  if (from < 0) { const top = host.scrollTop + 8; from = all.findIndex(([p, r]) => pageTop(p) + disp(p, r.y0) * zoom >= top) - 1; if (from < -1) from = all.length - 1; }
  for (let k = 1; k <= all.length; k++) {
    const [p, r] = all[(from + k) % all.length];
    const u = U.unitOf(r.id); if (!u || U.done(u) || (u.choice && u.ids[0] !== r.id)) continue;
    const wrapped = from + k >= all.length;
    { const host = $("#pages"), t = readableScroll(p, r); if (Math.abs(t - host.scrollTop) < host.clientHeight * 6) glideTo(host, t); else host.scrollTop = t; } flashRegions([[p, r]]);
    if (canFocusOnJump() && r.kind !== "choice") { r._el.focus({ preventScroll: true }); }
    const lab = labelAt(labelIndex(), p, r.y0 + 6);
    toast((lab !== "?" ? `Q${lab} · ` : "") + `page ${p + 1}` + (wrapped ? " (back to the start)" : ""), 1600);
    return;
  }
  toast("Every answer space has something in it.", 2500);
}
$("#nextBtn").onclick = () => { hideJump(); nextEmpty(); };

// bring papers across from the earlier single-device version (same site, older storage name)
(async () => {
  try {
    if (localStorage.getItem("migrated-paperwork")) return;
    const old = await new Promise(res => { const r = indexedDB.open("paperwork"); r.onupgradeneeded = () => { r.transaction.abort(); res(null); }; r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
    if (old && old.objectStoreNames.contains("docs")) {
      const all = await new Promise(res => { const q = old.transaction("docs").objectStore("docs").getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); });
      for (const d of all) {
        if (await DB.get(d.id).catch(() => null)) continue;
        d.seq = 0; d.dirty = {}; d.fit = {};
        for (const arr of Object.values(d.strokes || {})) for (const s of arr) { s.id ||= rid8(); s.t ||= "pen"; }
        await DB.put(d); await DB.putMeta({ id: d.id, name: d.name, updated: d.updated || Date.now(), pages: d.pages.length, filled: Object.keys(d.text || {}).length, total: d.pages.reduce((s, P) => s + P.regions.length, 0) });
      }
      old.close();
    }
    localStorage.setItem("migrated-paperwork", "1");
  } catch (e) {}
  if (window.renderHomeList) renderHomeList();
})();

// ask the browser to keep saved papers even when the device is low on space
if (navigator.storage && navigator.storage.persist) navigator.storage.persisted().then(p => { if (!p) navigator.storage.persist().catch(() => {}); }).catch(() => {});
