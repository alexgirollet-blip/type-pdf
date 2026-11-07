// marking.js — a marking from an outside marker (e.g. Claude), drawn on the paper as if a teacher had marked it.
//
// Flow: Export for AI gives every answer an id (and remembers which answer spaces each id is). The marker sends back
// "<paper> - marking.json" (format typepdf-marking v1, see docs/marking-schema.json). Import it here (file, paste, or a
// #mark= link) and the marks appear as their own layer: red pen comments, green ticks, red crosses, a score in a
// circle beside each part, a bracketed total for each question, and a summary on the front page.
//
// The layer never touches your answers. It is stored with the paper (doc.marking, synced like the answers), can be
// hidden, edited (move or delete any mark, add your own) and flattened into a "marked" PDF.
//
// Everything is laid out once as a list of simple shapes per page (in page points, the same coordinates the page
// uses on screen, extra space included), then drawn as SVG on screen or with pdf-lib into the marked PDF.
"use strict";
const Marking = window.Marking = (() => {
  const RED = "#cc1f1a", GREEN = "#17853b", GREY = "#8c9290", PAPER = "#ffffff";     // never blue: blue is your own pen
  const HAND = '"TP-hand", "Patrick Hand", cursive', SANS = "system-ui, -apple-system, Segoe UI, sans-serif";
  const VERDICTS = ["correct", "partial", "wrong", "blank", "excluded"];
  const TYPES = ["tick", "cross", "underline", "circle", "caret", "note", "bracket", "arrow", "sketch", "symbol"];
  const GATES = ["and", "or", "not", "nand", "nor", "xor", "xnor", "buffer"];
  let lay = null;                  // { pages: [[shape]], warn, parts } for the current marking
  let editMode = false, addType = null, sel = null;
  const $ = s => document.querySelector(s);

  // ---------------- reading a marking ----------------
  function parse(text) {
    let j;
    try { j = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); }
    catch (e) { throw new Error("That isn't valid JSON: " + e.message); }
    if (!j || typeof j !== "object") throw new Error("That isn't a marking file.");
    if (j.format !== "typepdf-marking") throw new Error('That isn\'t a TypePDF marking (its "format" should be "typepdf-marking").');
    const warn = [];
    if (j.version !== 1) { if (+j.version > 1) warn.push(`This marking is version ${j.version}; this TypePDF reads version 1, so some of it may be ignored.`); else throw new Error("This marking has no version 1."); }
    if (!Array.isArray(j.parts)) throw new Error('A marking needs a "parts" list.');
    const parts = [];
    j.parts.forEach((pt, i) => {
      if (!pt || typeof pt !== "object") { warn.push(`Part ${i + 1} isn't an object: skipped.`); return; }
      const id = String(pt.id || "").trim(); if (!id && !pt.q) { warn.push(`Part ${i + 1} has no id: skipped.`); return; }
      const verdict = VERDICTS.includes(pt.verdict) ? pt.verdict : (pt.awarded != null && pt.max != null ? (+pt.awarded >= +pt.max ? "correct" : +pt.awarded > 0 ? "partial" : "wrong") : "partial");
      if (pt.verdict && !VERDICTS.includes(pt.verdict)) warn.push(`${id || pt.q}: unknown verdict "${pt.verdict}", read as ${verdict}.`);
      const anns = (Array.isArray(pt.annotations) ? pt.annotations : []).filter(a => a && TYPES.includes(a.type));
      if (Array.isArray(pt.annotations) && anns.length < pt.annotations.length) warn.push(`${id || pt.q}: ${pt.annotations.length - anns.length} mark(s) of an unknown type skipped.`);
      const co = [].concat(pt.correctOptions ?? pt.correctOption ?? pt.correctAnswer ?? []).map(x => String(x).trim().toUpperCase()).filter(x => /^[A-H]$/.test(x));
      const working = [].concat(pt.working ?? []).map(str).filter(x => x.trim());
      for (const a of anns) if (a.type === "symbol" && !GATES.includes(String(a.symbol || "").toLowerCase())) warn.push(`${id || pt.q}: unknown symbol "${a.symbol}" (use ${GATES.join(", ")}).`);
      parts.push({ id, q: String(pt.q || id), awarded: num(pt.awarded), max: num(pt.max), verdict, comment: str(pt.comment), correction: str(pt.correction), correctOptions: co, working,
        annotations: anns.map(a => ({ type: a.type, anchor: a.anchor && typeof a.anchor === "object" ? a.anchor : { kind: "part" }, text: str(a.text),
          ...(a.from && typeof a.from === "object" ? { from: { x: +a.from.x, y: +a.from.y } } : {}), ...(a.path ? { path: String(a.path).slice(0, 4000) } : {}), ...(a.symbol ? { symbol: String(a.symbol).toLowerCase() } : {}) })) });
    });
    const sm = j.summary && typeof j.summary === "object" ? j.summary : {};
    return {
      m: {
        format: "typepdf-marking", version: 1, paperId: str(j.paperId), paperTitle: str(j.paperTitle), exported: str(j.exported), marker: str(j.marker) || "Marker", markedAt: str(j.markedAt),
        summary: { score: num(sm.score), outOf: num(sm.outOf), grade: str(sm.grade), gradeNote: str(sm.gradeNote), comment: str(sm.comment), perQuestion: Array.isArray(sm.perQuestion) ? sm.perQuestion.filter(x => x && x.q != null).map(x => ({ q: String(x.q), awarded: num(x.awarded), max: num(x.max) })) : [] },
        parts, extra: [], edits: {}
      }, warn
    };
  }
  const num = v => v == null || v === "" || isNaN(+v) ? null : +v;
  const str = v => v == null ? "" : String(v);

  // import: check it's for this paper, work out where every id is, keep the last marking for undo
  async function importText(text) {
    if (!doc) throw new Error("Open the paper first.");
    const { m, warn } = parse(text);
    if (m.paperId && m.paperId !== doc.id) warn.unshift(`This marking says it's for a different paper (${m.paperTitle || m.paperId}). It has been put on this one anyway.`);
    const ex = doc.aiExport;
    if (!ex) warn.push("This paper hasn't been exported for AI on this account, so the marks are placed from a fresh reading of your answers.");
    else if (m.exported && ex.exported && m.exported !== ex.exported) warn.push(`This marking is for an export made ${when(m.exported)}, but the latest export was ${when(ex.exported)}. Answers changed since then may not line up.`);
    // where each id is: the export's own record, then a fresh export, then the part label
    const map = { ...((ex && ex.ids) || {}) };
    const missing = m.parts.filter(pt => !map[pt.id]);
    if (missing.length && typeof aiJSON === "function") {
      try { await aiPrep(); const fresh = aiJSON(false); for (const e of fresh._all || fresh.answers) if (!map[e.id]) map[e.id] = { q: e.q, type: e.type, r: (e._r || []).map(x => x.id), page: e.page, ...(e._L ? { L: e._L } : {}), ...(e.workings ? { w: e.workings } : {}) }; } catch (e) { console.warn(e); }
    }
    for (const pt of m.parts) {
      if (map[pt.id]) continue;
      const byQ = Object.entries(map).find(([, v]) => v.q === pt.q);
      if (byQ) { warn.push(`${pt.id}: no answer has that id, so it was matched by its label ${pt.q}.`); pt.id = byQ[0]; }
      else if (typeof labelIndex === "function" && labelIndex().some(e => e.label === pt.q)) { map[pt.id] = { q: pt.q, r: [] }; warn.push(`${pt.id}: no answer has that id; its marks go beside question ${pt.q}.`); }
      else warn.push(`${pt.id || pt.q}: not found on this paper. It's listed under Marks but not drawn.`);
    }
    m.map = map; m.importedAt = new Date().toISOString(); m.warn = warn;
    if (doc.marking) { doc.markingPrev = doc.marking; emit("markingPrev"); }
    doc.marking = m; emit("marking"); scheduleSave();
    setOn(true); refresh();
    return warn;
  }
  const when = iso => { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); };

  // ---------------- where things are on the page ----------------
  const pageOf = id => doc.pages.findIndex(P => P && P.regions && P.regions.some(r => r.id === id));
  // the rectangles a part's answer takes up (display coordinates), on whichever pages
  function partRects(pt) {
    const m = (doc.marking.map || {})[pt.id]; if (!m) return [];
    const out = [];
    for (const rid of m.r || []) {
      const p = pageOf(rid); if (p < 0) continue;
      const r = doc.pages[p].regions.find(q => q.id === rid);
      // a multiple-choice question: the option chosen (or the first)
      if (r.kind === "choice" && out.some(o => o.r && o.r.kind === "choice")) { if (doc.text[r.id]) { const k = out.findIndex(o => o.r && o.r.kind === "choice"); out[k] = { p, r, ...regionRect(p, r) }; } continue; }
      out.push({ p, r, ...regionRect(p, r) });
    }
    if (!out.length && m.w && m.w.crops) for (const c of m.w.crops) {
      const p = c.page - 1, P = doc.pages[p]; if (!P) continue;
      const y0 = disp(p, c.y0), y1 = disp(p, c.y1), xs = [], ys = [];
      for (const st of doc.strokes[p] || []) { if (st.t !== "pen") continue; for (const q of dispPts(p, st)) if (q[1] >= y0 - 2 && q[1] <= y1 + 2) { xs.push(q[0]); ys.push(q[1]); } }
      out.push(xs.length ? { p, x0: Math.min(...xs) - 6, x1: Math.max(...xs) + 6, y0: Math.min(...ys) - 6, y1: Math.max(...ys) + 6, drawn: true } : { p, x0: 40, x1: P.w - 40, y0, y1 });
    }
    if (!out.length) { const e = labelIndex().find(x => x.label === (m.q || pt.q)); if (e) out.push({ p: e.p, x0: e.x, x1: doc.pages[e.p].w - 50, y0: disp(e.p, e.y), y1: disp(e.p, e.y) + 26 }); }
    return out;
  }
  function optionRects(pt) {
    const m = (doc.marking.map || {})[pt.id]; if (!m) return [];
    const out = [];
    (m.r || []).forEach((rid, k) => {
      const p = pageOf(rid); if (p < 0) return;
      const r = doc.pages[p].regions.find(q => q.id === rid); if (!r || r.kind !== "choice") return;
      const L = (m.L && m.L[k]) || r.L || ((String(r.opt || "").match(/^\(?([A-H])\b/) || [])[1]) || "ABCDEFGH"[out.length];
      out.push({ L, p, r, chosen: !!doc.text[r.id], ...regionRect(p, r) });
    });
    return out;
  }
  // the cells of a table part, in the export's order
  function cellRects(pt) {
    const m = (doc.marking.map || {})[pt.id]; if (!m) return [];
    return (m.r || []).map(rid => { const p = pageOf(rid); if (p < 0) return null; const r = doc.pages[p].regions.find(q => q.id === rid); return r ? { p, r, ...regionRect(p, r) } : null; }).filter(Boolean);
  }
  // a text anchor: the lines a phrase of your typed answer takes up, found where it's printed in its answer space
  function findText(pt, rects, a) {
    const want = String(a.match || ""); if (!want.trim()) return null;
    const occ = Math.max(1, +a.occurrence || 1);
    const norm = s => s.toLowerCase().replace(/\s+/g, " ");
    let seen = 0;
    for (const R of rects) {
      if (!R.r || R.r.kind === "choice" || !R.r._el) continue;
      const ta = R.r._el, t = ta.value || doc.text[R.r.id] || "";
      // exact, then ignoring case and runs of spaces (same length either way, so the index still fits the text)
      for (const [hay, ndl] of [[t, want], [norm(t), norm(want)]]) {
        let i = -1, n = 0;
        while ((i = hay.indexOf(ndl, i + 1)) >= 0) { n++; if (seen + n === occ) return lineSegs(R, ta, i, i + ndl.length); }
        if (n) { seen += n; break; }
      }
    }
    return null;
  }
  function lineSegs(R, ta, a, b) {
    const z = zoom, s = caretRect(ta, a), e = caretRect(ta, b), lh = s.h / z || 12;
    const sx = s.x / z, sy = s.y / z, ex = e.x / z, ey = e.y / z, segs = [];
    if (Math.abs(sy - ey) < lh * 0.5) segs.push({ x0: sx, x1: ex, y: sy, h: lh });
    else {
      segs.push({ x0: sx, x1: R.x1, y: sy, h: lh });
      for (let y = sy + lh; y < ey - lh * 0.5; y += lh) segs.push({ x0: R.x0, x1: R.x1, y, h: lh });
      segs.push({ x0: R.x0, x1: ex, y: ey, h: lh });
    }
    return { p: R.p, segs, x: segs[0].x0, y: segs[0].y + lh * 0.55, ex: segs[segs.length - 1].x1, ey: segs[segs.length - 1].y + lh * 0.55 };
  }
  // where an annotation goes: { p, x, y } (its spot) plus the lines (text) or box (workings) it covers
  function resolve(pt, rects, a, warn) {
    const an = a.anchor || { kind: "part" };
    if (an.kind === "text") { const t = findText(pt, rects, an); if (t) return { ...t, kind: "text" }; warn.push(`${pt.id}: couldn't find "${String(an.match).slice(0, 40)}" in the answer, so that mark is beside the whole answer.`); }
    if (an.kind === "workings") {
      const m = (doc.marking.map || {})[pt.id], w = m && m.w;
      if (w && w.crops && w.crops.length) {
        const H = w.height, W = w.width, iy = clamp01(+an.y) * H, ix = clamp01(+an.x) * W;
        const c = w.crops.find(c => iy >= c.imageY0 - 3 && iy <= c.imageY1 + 3) || w.crops[0];
        const p = c.page - 1;
        if (doc.pages[p]) {
          const y = disp(p, c.y0 + (iy - c.imageY0)), bw = (+an.w || 0) * W, bh = (+an.h || 0) * H;
          return { kind: "box", p, x: ix, y, box: { x0: ix, y0: y, x1: ix + bw, y1: y + bh } };
        }
      }
      warn.push(`${pt.id}: this answer has no workings image, so a workings mark is beside the whole answer.`);
    }
    if (an.kind === "option") {
      const o = optionRects(pt).find(o => o.L === String(an.letter || "").toUpperCase());
      if (o) return { kind: "box", p: o.p, x: o.x0 - 12, y: (o.y0 + o.y1) / 2, box: { x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1 }, opt: true };
      warn.push(`${pt.id}: no option ${an.letter}, so that mark is beside the whole answer.`);
    }
    if (an.kind === "cell") {
      const c = cellRects(pt)[(+an.index || 0)];
      if (c) return { kind: "box", p: c.p, x: c.x1 + 7, y: (c.y0 + c.y1) / 2, box: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }, cell: true };
      warn.push(`${pt.id}: no cell ${an.index}, so that mark is beside the whole answer.`);
    }
    if (an.kind === "page") {
      const p = (+an.page || 1) - 1, P = doc.pages[p];
      if (P) return { kind: "point", p, x: clamp01(+an.x) * P.w, y: disp(p, clamp01(+an.y) * P.h) };
    }
    const R = rects[0]; if (!R) return null;
    if (R.r && R.r.kind === "choice") return { kind: "point", p: R.p, x: R.x0 - 12, y: (R.y0 + R.y1) / 2 };
    if (R.r && R.r.kind === "cell" || (R.y1 - R.y0 < 30 && R.x1 - R.x0 < 120)) return { kind: "box", p: R.p, x: R.x1 + 7, y: (R.y0 + R.y1) / 2, box: { x0: R.x0, y0: R.y0, x1: R.x1, y1: R.y1 }, cell: true };
    if (R.drawn) return { kind: "box", p: R.p, x: R.x1 + 4, y: R.y0 + 8, box: { x0: R.x0, y0: R.y0, x1: R.x1, y1: R.y1 } };
    return { kind: "part", p: R.p, x: Math.max(R.x0 + 10, R.x1 - 14), y: R.y0 + Math.min(10, (R.y1 - R.y0) / 2), box: { x0: R.x0, y0: R.y0, x1: R.x1, y1: R.y1 } };
  }
  const an0 = a => (a.anchor && a.anchor.kind) || "part";
  const clamp01 = v => isNaN(v) ? 0.5 : Math.max(0, Math.min(1, v));

  // ---------------- measuring hand-lettering ----------------
  let mctx = null;
  function textW(s, size, font) { mctx ||= document.createElement("canvas").getContext("2d"); mctx.font = `${size}px ${font === "sans" ? SANS : HAND}`; return mctx.measureText(s).width; }
  function wrap(s, size, w, font) {
    const out = [];
    for (const para of String(s).split(/\n/)) {
      let cur = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const nx = cur ? cur + " " + word : word;
        if (cur && textW(nx, size, font) > w) { out.push(cur); cur = word; } else cur = nx;
      }
      out.push(cur);
    }
    return out;
  }

  // ---------------- the shapes ----------------
  // shapes: { k: "path", d, stroke, w } · { k: "ell", cx, cy, rx, ry, stroke, w, fill } · { k: "text", x, y, s, size, font, fill }
  //         { k: "rect", x, y, w, h, fill, op, stroke, sw } · { k: "line", x1, y1, x2, y2, stroke, w }   each with g: the group (for editing)
  const tickD = (x, y, s = 1) => `M${x - 5 * s} ${y - 0.5 * s} L${x - 1.5 * s} ${y + 4 * s} L${x + 6 * s} ${y - 7 * s}`;
  const crossD = (x, y, s = 1) => `M${x - 4.5 * s} ${y - 4.5 * s} L${x + 4.5 * s} ${y + 4.5 * s} M${x + 4.5 * s} ${y - 4.5 * s} L${x - 4.5 * s} ${y + 4.5 * s}`;
  function layout() {
    const M = doc.marking, warn = [], pages = doc.pages.map(() => []), notes = doc.pages.map(() => []), circles = doc.pages.map(() => []), workings = [];
    const ed = M.edits || {};
    const add = (p, g, sh) => { if (pages[p] && !(ed[g] && ed[g].del)) pages[p].push({ ...sh, g }); };
    const geo = {};
    M.parts.forEach((pt, i) => {
      const rects = partRects(pt); geo[pt.id] = rects;
      if (!rects.length) return;
      const ex = pt.verdict === "excluded", col = ex ? GREY : RED, R0 = rects[0];
      // the score in a circle in the right margin, beside where the answer starts
      if (pt.max != null || ex) {
        const P = doc.pages[R0.p], s = ex ? "excl." : `${fmt(pt.awarded)}/${fmt(pt.max)}`, size = ex ? 7.5 : 9;
        const tw = textW(s, size), rx = Math.max(10.5, tw / 2 + 4);
        circles[R0.p].push({ g: "s:" + i, y: Math.max(16, R0.y0 + 9), rx, s, size, col, x: P.w - 6 - rx });
      }
      // marks at their anchors
      pt.annotations.forEach((a, k) => {
        const g = `a:${i}:${k}`, at = resolve(pt, rects, a, warn); if (!at) return;
        const p = at.p, c = ex ? GREY : a.type === "tick" ? GREEN : RED;
        if (a.type === "tick" || a.type === "cross") {
          const x = at.kind === "text" ? at.ex + 8 : at.opt || at.cell ? at.x : at.kind === "box" && at.box.x1 > at.box.x0 ? at.box.x1 + 6 : at.x, y = at.kind === "text" ? at.ey - 1 : at.y;
          add(p, g, { k: "path", d: a.type === "tick" ? tickD(x, y, 1.15) : crossD(x, y, 1.05), stroke: c, w: 1.8 });
        } else if (a.type === "underline") {
          if (at.segs) for (const sg of at.segs) add(p, g, { k: "path", d: `M${sg.x0} ${sg.y + sg.h * 0.92} Q${(sg.x0 + sg.x1) / 2} ${sg.y + sg.h * 0.92 + 1.6} ${sg.x1} ${sg.y + sg.h * 0.9}`, stroke: c, w: 1.2 });
          else { const b = at.box || { x0: at.x - 20, x1: at.x + 20, y1: at.y + 4 }; add(p, g, { k: "path", d: `M${b.x0} ${b.y1 + 1.5} L${b.x1} ${b.y1 + 1}`, stroke: c, w: 1.2 }); }
        } else if (a.type === "circle") {
          let b = at.box;
          if (at.segs) { const xs = at.segs.flatMap(s => [s.x0, s.x1]), ys = at.segs.flatMap(s => [s.y, s.y + s.h]); b = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; }
          if (!b || b.x1 - b.x0 < 4) b = { x0: at.x - 12, x1: at.x + 12, y0: at.y - 8, y1: at.y + 8 };
          add(p, g, { k: "ell", cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, rx: (b.x1 - b.x0) / 2 + 4, ry: (b.y1 - b.y0) / 2 + 3, stroke: c, w: 1.3 });
        } else if (a.type === "caret") {
          const x = at.x, y = at.segs ? at.segs[0].y + at.segs[0].h : at.y + 6;
          add(p, g, { k: "path", d: `M${x - 3.5} ${y + 5} L${x} ${y - 1} L${x + 3.5} ${y + 5}`, stroke: c, w: 1.3 });
        } else if (a.type === "arrow") {
          // pointing at the spot; from where "from" says (same units as the anchor), else from up and to the right
          let fx = at.x + 34, fy = at.y - 26;
          if (a.from && !isNaN(a.from.x)) { const f = resolve(pt, rects, { anchor: { ...(a.anchor || {}), x: a.from.x, y: a.from.y, w: 0, h: 0 } }, []); if (f && f.p === p) { fx = f.x; fy = f.y; } }
          const tx2 = at.box && at.kind === "box" && !at.opt && !at.cell ? (at.box.x0 + at.box.x1) / 2 : at.x, ty2 = at.box && at.kind === "box" && !at.opt && !at.cell ? (at.box.y0 + at.box.y1) / 2 : at.y;
          const ang = Math.atan2(ty2 - fy, tx2 - fx), hl = 6;
          add(p, g, { k: "path", d: `M${fx} ${fy} L${tx2} ${ty2} M${tx2 - hl * Math.cos(ang - 0.45)} ${ty2 - hl * Math.sin(ang - 0.45)} L${tx2} ${ty2} L${tx2 - hl * Math.cos(ang + 0.45)} ${ty2 - hl * Math.sin(ang + 0.45)}`, stroke: c, w: 1.3 });
          at.tail = { x: fx, y: fy, right: fx >= tx2 };
        } else if (a.type === "sketch" || a.type === "symbol") {
          // drawn into the anchor's box: a sketch's path is in 0–1 of the box; a gate symbol keeps its shape (1.6 : 1)
          let b = at.box && at.box.x1 - at.box.x0 > 4 && at.box.y1 - at.box.y0 > 4 ? at.box : { x0: at.x, y0: at.y - 16, x1: at.x + 52, y1: at.y + 16 };
          if (a.type === "sketch" && a.path) add(p, g, { k: "path", d: mapPath(a.path, (x, y) => [b.x0 + x * (b.x1 - b.x0), b.y0 + y * (b.y1 - b.y0)]), stroke: c, w: 1.4 });
          if (a.type === "symbol" && GATES.includes(a.symbol)) {
            const h = Math.min(b.y1 - b.y0, (b.x1 - b.x0) / 1.6), ox = (b.x0 + b.x1) / 2 - h * 0.8, oy = (b.y0 + b.y1) / 2 - h / 2;
            const G = gate(a.symbol);
            add(p, g, { k: "path", d: mapPath(G.d, (x, y) => [ox + x * h, oy + y * h]), stroke: c, w: 1.4 });
            if (G.bub) add(p, g, { k: "ell", cx: ox + G.bub * h, cy: oy + 0.5 * h, rx: 0.07 * h, ry: 0.07 * h, stroke: c, w: 1.3 });
          }
        } else if (a.type === "bracket") {
          let y0 = at.y - 7, y1 = at.y + 7, x = at.x - 6;
          if (at.segs) { y0 = at.segs[0].y; y1 = at.segs[at.segs.length - 1].y + at.segs[at.segs.length - 1].h; x = Math.min(...at.segs.map(s => s.x0)) - 5; }
          else if (at.box) { y0 = at.box.y0; y1 = Math.max(at.box.y1, at.box.y0 + 12); x = at.box.x0 - 5; }
          add(p, g, { k: "path", d: `M${x + 3} ${y0} L${x} ${y0} L${x} ${y1} L${x + 3} ${y1}`, stroke: c, w: 1.3 });
        }
        // a short label is written right by its mark (above a caret, after a tick); a longer one goes in the margin
        if (a.text && a.type !== "note" && a.text.length <= 28) {
          const size = 11, lx = a.type === "caret" ? at.x - 4 : a.type === "tick" || a.type === "cross" ? (at.kind === "text" ? at.ex + 18 : (at.kind === "box" && at.box.x1 > at.box.x0 ? at.box.x1 + 18 : at.x + 10)) : at.x;
          const ly = a.type === "caret" ? (at.segs ? at.segs[0].y - 1 : at.y - 9) : a.type === "tick" || a.type === "cross" ? (at.kind === "text" ? at.ey + 3 : at.y + 4) : (at.segs ? at.segs[0].y - 1 : at.y - 8);
          const P2 = doc.pages[p], w2 = textW(a.text, size);
          let x2 = Math.min(lx, P2.w - 40 - w2), ly2 = ly;
          if (a.type === "arrow" && at.tail) {
            // at the tail, clear of the comment column down the right of the page
            const lim = P2.w - 170 - w2; x2 = at.tail.right ? at.tail.x + 3 : at.tail.x - w2 - 3;
            if (x2 > lim) x2 = Math.max(8, at.tail.x - w2 - 3 > lim ? lim : at.tail.x - w2 - 3);
            ly2 = at.tail.y - 3;
          }
          add(p, g, { k: "rect", x: x2 - 2, y: ly2 - size + 1, w: w2 + 4, h: size + 2, fill: PAPER, op: 0.75 });
          add(p, g, { k: "text", x: x2, y: ly2, s: a.text, size, font: "hand", fill: c });
        } else if (a.type === "note" && an0(a) === "page") {
          const P2 = doc.pages[p], ls = wrap(a.text || "", 11.5, Math.min(220, P2.w - at.x - 30));
          ls.forEach((l, k2) => add(p, g, { k: "text", x: Math.min(at.x, P2.w - 30 - textW(l, 11.5)), y: at.y + k2 * 14, s: l, size: 11.5, font: "hand", fill: c }));
        } else if (a.text || a.type === "note") notes[p].push({ g: g + ":n", ay: at.y, ax: at.kind === "text" ? at.ex : at.x, lines: a.text || "", corr: "", col: c });
      });
      // multiple choice with the right answer given: your choice ticked (right) or crossed (wrong), and the right one
      // circled with a tick in green, so you can see it at a glance
      if (pt.correctOptions.length && !ex) {
        const opts = optionRects(pt), right = new Set(pt.correctOptions);
        for (const o of opts) {
          const g = "o:" + i + ":" + o.L, cy = (o.y0 + o.y1) / 2;
          if (o.chosen && right.has(o.L)) add(o.p, g, { k: "path", d: tickD(o.x0 - 12, cy, 1.15), stroke: GREEN, w: 1.8 });
          else if (o.chosen) add(o.p, g, { k: "path", d: crossD(o.x0 - 12, cy, 1.05), stroke: RED, w: 1.8 });
          else if (right.has(o.L)) {
            const w = o.x1 - o.x0, h = o.y1 - o.y0;
            add(o.p, g, { k: "ell", cx: o.x0 + w / 2, cy, rx: w / 2 + 3.5, ry: h / 2 + 3.5, stroke: GREEN, w: 1.6 });
            add(o.p, g, { k: "path", d: tickD(o.x0 - 12, cy, 1.15), stroke: GREEN, w: 1.8 });
            if (!opts.some(x => x.chosen)) add(o.p, g, { k: "text", x: o.x0 - 34, y: cy + 3.5, s: "ans", size: 9, font: "hand", fill: GREEN });
          }
        }
        if (!opts.length) warn.push(`${pt.id}: has correctOptions but isn't a multiple-choice answer on this paper.`);
      }
      if (pt.working.length && pt.verdict !== "correct" && !ex) workings.push({ i, pt, rects });
      // the part's comment (and the right answer) in the margin, pointing at the start of the answer
      if (pt.comment || pt.correction) notes[R0.p].push({ g: "c:" + i, ay: R0.y0 + 8, ax: R0.x1 - 4, lines: pt.comment, corr: pt.correction, col: ex ? GREY : RED });
    });
    const taken = doc.pages.map(() => []);
    for (const { i, pt, rects } of workings) {
      const last = rects.reduce((a, b) => (b.p > a.p || (b.p === a.p && b.y1 > a.y1)) ? b : a), p = last.p, P = doc.pages[p];
      const X0 = Math.max(56, Math.min(...rects.filter(r => r.p === p).map(r => r.x0))), X1 = P.w - 170, W = X1 - X0;
      const steps = pt.working.length > 1 ? pt.working.map((t, k) => `${k + 1}. ${t}`) : pt.working;
      const g = "w:" + i;
      // never past the start of the next question: the working belongs with this one
      const lastSrc = src(p, last.y1), next = labelIndex().filter(e => e.p === p && e.y > lastSrc + 2).map(e => disp(p, e.y) - 14), limit = next.length ? Math.min(...next) : null;
      const first = rects.filter(r => r.p === p).reduce((a, b) => b.y0 < a.y0 ? b : a);
      const box = (x0, w, top0) => { const ls = steps.flatMap(t => wrap(t, 11, w - 16)), h = 20 + ls.length * 13.5 + 6; const top = findSpace(p, top0, h, x0, x0 + w, taken[p], limit); return top == null ? null : { x0, w, top, h, ls }; };
      // under the answer if there's room before the next question; else beside it (where a multiple-choice question's
      // options leave the right of the page empty); else in the margin
      let at = W >= 180 ? box(X0, W, last.y1 + 4) : null;
      if (!at) {
        const P2 = doc.pages[p], band = (P2.items || []).filter(it => disp(p, it.y) > first.y0 - 4 && disp(p, it.y) < last.y1 + 4 && it.x < P2.w - 170).map(it => it.x1);
        const xr = Math.max(first.x1, ...band) + 22, w2 = P2.w - 170 - xr;
        if (w2 >= 150) at = box(xr, w2, Math.max(16, first.y0 - 6));
      }
      if (at) {
        taken[p].push([at.top, at.top + at.h]);
        add(p, g, { k: "rect", x: at.x0, y: at.top, w: at.w, h: at.h, fill: PAPER, op: 0.9, stroke: RED, sw: 0.8, dash: true });
        add(p, g, { k: "text", x: at.x0 + 8, y: at.top + 14, s: "Working", size: 9.5, font: "sans", fill: "#8f1713", bold: true });
        at.ls.forEach((l, k) => add(p, g, { k: "text", x: at.x0 + 8, y: at.top + 28 + k * 13.5, s: l, size: 11, font: "hand", fill: RED }));
        continue;
      }
      notes[last.p].push({ g, ay: last.y1 - 6, ax: last.x1, lines: "Working: " + steps.join("  "), corr: "", col: RED });
    }
    // a bracket with each question's total, at the end of its last part
    for (const qt of questionTotals(M)) {
      const rs = qt.parts.flatMap(pt => geo[pt.id] || []); if (!rs.length) continue;
      const last = rs.reduce((a, b) => (b.p > a.p || (b.p === a.p && b.y1 > a.y1)) ? b : a), P = doc.pages[last.p];
      const first = rs.filter(r => r.p === last.p).reduce((a, b) => b.y0 < a.y0 ? b : a);
      const g = "t:" + qt.q, x = P.w - 4, y1 = last.y1 + 2, y0 = Math.max(first.y0, y1 - 70);
      add(last.p, g, { k: "path", d: `M${x - 4} ${y0} L${x} ${y0} L${x} ${y1} L${x - 4} ${y1}`, stroke: RED, w: 1.2 });
      const s = `${qName(qt.q)}: ${fmt(qt.awarded)}/${fmt(qt.max)}`, tw = textW(s, 10.5);
      add(last.p, g, { k: "rect", x: x - tw - 12, y: y1 + 2, w: tw + 8, h: 15, fill: PAPER, op: 0.9, stroke: RED, sw: 0.9 });
      add(last.p, g, { k: "text", x: x - tw - 8, y: y1 + 13.5, s, size: 10.5, font: "hand", fill: RED });
    }
    // score circles: no two on top of each other
    circles.forEach((cs, p) => {
      cs.sort((a, b) => a.y - b.y); let prev = -1e9;
      for (const c of cs) { c.y = Math.max(c.y, prev + 2 * 11 + 3); prev = c.y;
        add(p, c.g, { k: "ell", cx: c.x, cy: c.y, rx: c.rx, ry: 10.5, stroke: c.col, w: 1.4, fill: PAPER, op: 0.85 });
        add(p, c.g, { k: "text", x: c.x - textW(c.s, c.size) / 2, y: c.y + c.size * 0.36, s: c.s, size: c.size, font: "hand", fill: c.col }); }
    });
    // margin notes: a column just inside the right edge, stacked so none overlap, each with a thin line to its spot
    notes.forEach((ns, p) => {
      const P = doc.pages[p]; if (!P || !ns.length) return;
      const W = 128, X = P.w - 32 - W, H = P.h + totalGap(p), boxes = [];
      for (const n of ns.sort((a, b) => a.ay - b.ay)) {
        const ls = n.lines ? wrap(n.lines, 10.5, W - 8) : [], cs = n.corr ? wrap("Answer: " + n.corr, 8.5, W - 8, "sans") : [];
        const h = 5 + ls.length * 12.5 + cs.length * 10.5 + 4;
        boxes.push({ n, ls, cs, h, top: n.ay - 8 });
      }
      let prev = 14; for (const b of boxes) { b.top = Math.max(b.top, prev + 4); prev = b.top + b.h; }
      let lim = H - 14; for (let i = boxes.length - 1; i >= 0; i--) { const b = boxes[i]; if (b.top + b.h > lim) b.top = lim - b.h; lim = b.top - 4; }
      for (const b of boxes) {
        const { n } = b, g = n.g;
        if (Math.abs(n.ax - X) > 6 || Math.abs(n.ay - (b.top + 9)) > 4) {
          const ax = Math.min(n.ax + 2, X - 8), ly = n.ay + 6;
          add(p, g, { k: "path", d: `M${ax} ${ly} L${X - 6} ${ly} L${X - 6} ${b.top + 9} L${X} ${b.top + 9}`, stroke: n.col, w: 0.6 });
        }
        add(p, g, { k: "rect", x: X, y: b.top, w: W, h: b.h, fill: PAPER, op: 0.9 });
        add(p, g, { k: "line", x1: X, y1: b.top, x2: X, y2: b.top + b.h, stroke: n.col, w: 1.1 });
        let y = b.top + 4;
        for (const l of b.ls) { y += 12.5; add(p, g, { k: "text", x: X + 5, y: y - 2.5, s: l, size: 10.5, font: "hand", fill: n.col }); }
        for (const l of b.cs) { y += 10.5; add(p, g, { k: "text", x: X + 5, y: y - 2, s: l, size: 8.5, font: "sans", fill: "#8f1713", bold: /^Answer:/.test(l) }); }
      }
    });
    summary(pages, add);
    // marks you added yourself
    (M.extra || []).forEach((x, i) => {
      const p = x.p, P = doc.pages[p]; if (!P) return;
      const g = "x:" + i, y = disp(p, x.y);
      if (x.type === "tick") add(p, g, { k: "path", d: tickD(x.x, y, 1.15), stroke: GREEN, w: 1.8 });
      else if (x.type === "cross") add(p, g, { k: "path", d: crossD(x.x, y, 1.05), stroke: RED, w: 1.8 });
      else if (x.type === "circle") add(p, g, { k: "ell", cx: x.x, cy: y, rx: 14, ry: 9, stroke: RED, w: 1.3 });
      if (x.text) wrap(x.text, 10.5, 150).forEach((l, k) => add(p, g, { k: "text", x: x.x + (x.type === "note" ? -4 : 10), y: y + 4 + k * 12.5, s: l, size: 10.5, font: "hand", fill: RED }));
    });
    lay = { pages, warn: [...new Set([...(M.warn || []), ...warn])], geo };
    return lay;
  }
  const fmt = v => v == null ? "–" : Math.round(v * 10) / 10;
  // the first band of the page from y0 down (within the next 320 pt) at least h tall, between x0 and x1, with
  // nothing printed, written, drawn or answered in it
  function findSpace(p, y0, h, x0, x1, extra, limit) {
    const P = doc.pages[p], H = P.h + totalGap(p), occ = [...(extra || [])];
    for (const it of P.items || []) if (it.x < x1 && it.x1 > x0) occ.push([disp(p, it.y - (it.h || 10)), disp(p, it.y + 3)]);
    for (const r of P.regions || []) { const R = regionRect(p, r); if (R.x0 < x1 && R.x1 > x0) occ.push([R.y0, R.y1]); }
    for (const st of doc.strokes[p] || []) { const q = dispPts(p, st), xs = q.map(v => v[0]), ys = q.map(v => v[1]); if (q.length && Math.min(...xs) < x1 && Math.max(...xs) > x0) occ.push([Math.min(...ys) - 3, Math.max(...ys) + 3]); }
    for (let top = y0; top + h <= Math.min(H - 36, y0 + 320, limit ?? 1e9); top += 2) if (!occ.some(([a, b]) => a < top + h + 3 && b > top - 3)) return top;
    return null;
  }
  // every x y pair in a path (absolute M L Q C commands), moved by f
  const mapPath = (d, f) => String(d).replace(/(-?\d*\.?\d+)[\s,]+(-?\d*\.?\d+)/g, (_, a, b) => { const [x, y] = f(+a, +b); return `${+x.toFixed(2)} ${+y.toFixed(2)}`; });
  // logic gates in a 1.6 × 1 box: inputs on the left (at 0.3 and 0.7, or 0.5 for NOT), output on the right at 0.5
  function gate(n) {
    const AND = "M0.35 0.1 L0.8 0.1 Q1.2 0.1 1.2 0.5 Q1.2 0.9 0.8 0.9 L0.35 0.9 Z", OR = "M0.3 0.1 Q0.52 0.5 0.3 0.9 Q0.9 0.9 1.2 0.5 Q0.9 0.1 0.3 0.1 Z";
    const IN2 = " M0 0.3 L0.4 0.3 M0 0.7 L0.4 0.7", XB = " M0.2 0.1 Q0.42 0.5 0.2 0.9", TRI = "M0.35 0.15 L0.35 0.85 L1.1 0.5 Z M0 0.5 L0.35 0.5";
    const out = x => ` M${x} 0.5 L1.6 0.5`;
    return {
      and: { d: AND + IN2 + out(1.2) }, nand: { d: AND + IN2 + out(1.34), bub: 1.27 },
      or: { d: OR + IN2 + out(1.2) }, nor: { d: OR + IN2 + out(1.34), bub: 1.27 },
      xor: { d: OR + XB + IN2 + out(1.2) }, xnor: { d: OR + XB + IN2 + out(1.34), bub: 1.27 },
      not: { d: TRI + out(1.24), bub: 1.17 }, buffer: { d: TRI + out(1.1) },
    }[n];
  }
  // question totals: the marker's own per-question figures when given, else the sum of the parts
  const topQ = q => { const s = String(q); const m = s.match(/^(.*?\d+)(?=[.(]|$)/); return m ? m[1] : s; };
  function questionTotals(M) {
    const groups = new Map();
    for (const pt of M.parts) { const k = topQ(pt.q); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(pt); }
    return [...groups].map(([q, parts]) => {
      const own = (M.summary.perQuestion || []).find(x => x.q === q || topQ(x.q) === q);
      const live = parts.filter(p => p.verdict !== "excluded");
      return { q, parts, awarded: own && own.awarded != null ? own.awarded : sum(live, "awarded"), max: own && own.max != null ? own.max : sum(live, "max") };
    }).filter(t => t.max);
  }
  const sum = (a, k) => a.reduce((t, x) => t + (+x[k] || 0), 0);
  function totals(M) {
    const live = M.parts.filter(p => p.verdict !== "excluded");
    const score = M.summary.score != null ? M.summary.score : sum(live, "awarded"), outOf = M.summary.outOf != null ? M.summary.outOf : sum(live, "max");
    return { score, outOf, pct: outOf ? Math.round(score / outOf * 100) : null };
  }
  // ---- the front page: the score (in the paper's own "Total" box if it has one) and a summary in the emptiest space ----
  function summary(pages, add) {
    const M = doc.marking, P = doc.pages[0]; if (!P) return;
    const T = totals(M), sm = M.summary, items = (P.items || []);
    // 1. a printed spot for the total: "Total marks … / 85", or a TOTAL label with room beside it
    const tot = items.find(it => /^total(\s*marks?)?$/i.test(it.s.trim()) || /^total\s*marks?\s*\/?\s*\d*$/i.test(it.s.trim()));
    if (tot) {
      const slash = items.find(it => /^\/\s*\d+$/.test(it.s.trim()) && Math.abs(it.y - tot.y) < 30 && it.x > tot.x) || items.find(it => /\/\s*\d+$/.test(it.s.trim()) && Math.abs(it.y - tot.y) < 30 && it.x >= tot.x);
      const s = fmt(T.score), size = 18, w = textW(String(s), size);
      const x = slash ? slash.x - w - 4 : tot.x1 + 18, y = disp(0, slash ? slash.y : tot.y) + 2;
      add(0, "spot", { k: "text", x, y, s: String(s), size, font: "hand", fill: RED });
      if (sm.grade) { const gw = textW(sm.grade, 15); add(0, "spot", { k: "ell", cx: x + w / 2, cy: y + 19, rx: Math.max(9, gw / 2 + 5), ry: 9, stroke: RED, w: 1.1 }); add(0, "spot", { k: "text", x: x + w / 2 - gw / 2, y: y + 24, s: sm.grade, size: 15, font: "hand", fill: RED }); }
    }
    // 2. the summary box: the largest band of the front page with nothing printed in it (or over the bottom if none fits)
    const W = Math.min(P.w - 100, 470), X = (P.w - W) / 2;
    const cmt = sm.comment ? wrap(sm.comment, 11.5, W - 20) : [];
    const qs = (sm.perQuestion || []).length ? sm.perQuestion : questionTotals(M), cols = Math.max(1, Math.floor((W - 20) / 78)), rows = Math.ceil(qs.length / cols);
    const note = sm.gradeNote ? wrap(sm.gradeNote, 8.5, 104, "sans") : [];
    const h = 14 + 30 + Math.max(0, note.length - 1) * 10 + (cmt.length ? 8 + cmt.length * 14 : 0) + (rows ? 10 + rows * 15 : 0) + 12;
    const occ = items.map(it => [disp(0, it.y - (it.h || 10)), disp(0, it.y + 4)]).concat(P.regions.map(r => { const R = regionRect(0, r); return [R.y0, R.y1]; })).sort((a, b) => a[0] - b[0]);
    let best = null, at = 40;
    for (const [a, b] of occ.concat([[P.h + totalGap(0) - 40, 1e9]])) { if (a - at > (best ? best.h : 0)) best = { y: at, h: a - at }; at = Math.max(at, b); }
    let top = best && best.h >= h + 12 ? best.y + (best.h - h) / 2 : P.h + totalGap(0) - h - 46;
    const g = "sum";
    add(0, g, { k: "rect", x: X, y: top, w: W, h, fill: PAPER, op: 0.93, stroke: RED, sw: 1.3 });
    let y = top + 13;
    add(0, g, { k: "text", x: X + 10, y, s: `Marked by ${M.marker}${M.markedAt ? " · " + new Date(M.markedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : ""}`, size: 8, font: "sans", fill: "#8f1713" });
    y += 27;
    const big = `${fmt(T.score)}/${fmt(T.outOf)}`, bw = textW(big, 26);
    add(0, g, { k: "text", x: X + 10, y, s: big, size: 26, font: "hand", fill: RED });
    if (T.pct != null) add(0, g, { k: "text", x: X + 16 + bw, y, s: T.pct + "%", size: 15, font: "hand", fill: RED });
    if (sm.grade) {
      const gx = X + W - 150;
      add(0, g, { k: "ell", cx: gx + 16, cy: y - 8, rx: 16 + Math.max(0, textW(sm.grade, 22) - 20) / 2, ry: 14, stroke: RED, w: 1.4 });
      add(0, g, { k: "text", x: gx + 16 - textW(sm.grade, 22) / 2, y: y - 0.5, s: sm.grade, size: 22, font: "hand", fill: RED });
      note.forEach((l, k) => add(0, g, { k: "text", x: gx + 38, y: y - 12 + k * 10, s: l, size: 8.5, font: "sans", fill: "#8f1713" }));
      if (!note.length) add(0, g, { k: "text", x: gx + 38, y: y - 6, s: "grade", size: 8.5, font: "sans", fill: "#8f1713" });
    }
    y += Math.max(0, note.length - 1) * 10;
    if (cmt.length) { y += 8; for (const l of cmt) { y += 14; add(0, g, { k: "text", x: X + 10, y: y - 3, s: l, size: 11.5, font: "hand", fill: RED }); } }
    if (rows) {
      y += 10;
      qs.forEach((q, i) => { const c = i % cols, r = Math.floor(i / cols); add(0, g, { k: "text", x: X + 10 + c * 78, y: y + r * 15 + 10, s: `${qName(q.q)}  ${fmt(q.awarded)}/${fmt(q.max)}`, size: 10.5, font: "hand", fill: RED }); });
    }
  }

  // ---------------- on screen ----------------
  const isOn = () => { try { return localStorage.getItem("marksOn:" + (doc && doc.id)) !== "0"; } catch (e) { return true; } };
  function setOn(on) { try { localStorage.setItem("marksOn:" + doc.id, on ? "1" : "0"); } catch (e) {} draw(); panelHead(); }
  let raf = 0;
  function refresh() { lay = null; cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { draw(); renderPanel(); }); $("#marksBtn") && ($("#marksBtn").classList.toggle("has", !!(doc && doc.marking))); }
  // a page was laid out again (zoom, extra space, typing): redraw the marks soon
  function pageChanged() { if (!doc || !doc.marking) return; lay = null; cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }
  function draw() {
    if (typeof views === "undefined" || !doc) return;
    views.forEach(v => { const s = v.el.querySelector("svg.marks"); if (s) s.remove(); });
    if (!doc.marking || !isOn()) return;
    if (!lay) { try { layout(); } catch (e) { console.warn("marking layout", e); return; } }
    lay.pages.forEach((shapes, p) => {
      const v = views[p]; if (!v) return;
      const P = doc.pages[p], H = P.h + totalGap(p), ed = doc.marking.edits || {};
      const sv = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      sv.setAttribute("class", "marks" + (editMode ? " editing" : "")); sv.dataset.p = p;
      sv.setAttribute("viewBox", `0 0 ${P.w} ${H}`);
      Object.assign(sv.style, { width: P.w * zoom + "px", height: H * zoom + "px" });
      const groups = new Map();
      for (const sh of shapes) {
        if (!groups.has(sh.g)) { const g = document.createElementNS(sv.namespaceURI, "g"); g.dataset.g = sh.g; const o = ed[sh.g]; if (o && (o.dx || o.dy)) g.setAttribute("transform", `translate(${o.dx || 0} ${o.dy || 0})`); if (sel === sh.g + "@" + p) g.classList.add("sel"); groups.set(sh.g, g); sv.appendChild(g); }
        groups.get(sh.g).appendChild(svgOf(sv, sh));
      }
      v.el.appendChild(sv);
      if (editMode) bindEdit(sv, p);
    });
  }
  function svgOf(sv, sh) {
    const el = n => document.createElementNS(sv.namespaceURI, n), set = (e, o) => { for (const k in o) if (o[k] != null) e.setAttribute(k, o[k]); return e; };
    if (sh.k === "path") return set(el("path"), { d: sh.d, fill: "none", stroke: sh.stroke, "stroke-width": sh.w, "stroke-linecap": "round", "stroke-linejoin": "round" });
    if (sh.k === "line") return set(el("line"), { x1: sh.x1, y1: sh.y1, x2: sh.x2, y2: sh.y2, stroke: sh.stroke, "stroke-width": sh.w });
    if (sh.k === "ell") return set(el("ellipse"), { cx: sh.cx, cy: sh.cy, rx: sh.rx, ry: sh.ry, fill: sh.fill || "none", "fill-opacity": sh.op, stroke: sh.stroke, "stroke-width": sh.w });
    if (sh.k === "rect") return set(el("rect"), { x: sh.x, y: sh.y, width: sh.w, height: sh.h, rx: 2, fill: sh.fill || "none", "fill-opacity": sh.op, stroke: sh.stroke || "none", "stroke-width": sh.sw, "stroke-dasharray": sh.dash ? "3 2" : null });
    const t = set(el("text"), { x: sh.x, y: sh.y, fill: sh.fill, "font-size": sh.size, "font-weight": sh.bold ? 700 : null });
    t.style.fontFamily = sh.font === "sans" ? SANS : HAND; t.textContent = sh.s; return t;
  }

  // ---------------- editing: drag any mark, tap one to delete it, or tap the page to add your own ----------------
  function bindEdit(sv, p) {
    sv.addEventListener("pointerdown", e => {
      e.preventDefault(); e.stopPropagation();
      const pt = toPt(sv, e), gEl = e.target.closest && e.target.closest("g[data-g]");
      if (addType && !gEl) {
        const text = addType === "note" ? prompt("Your note:", "") : "";
        if (addType === "note" && !text) return;
        doc.marking.extra ||= []; doc.marking.extra.push({ type: addType, p, x: +pt.x.toFixed(1), y: +src(p, pt.y).toFixed(1), ...(text ? { text } : {}) });
        save(); return;
      }
      if (!gEl) { sel = null; draw(); hideSelBar(); return; }
      const g = gEl.dataset.g, o = (doc.marking.edits ||= {})[g] || {}, sx = o.dx || 0, sy = o.dy || 0; let moved = false;
      try { sv.setPointerCapture(e.pointerId); } catch (er) {}
      const mv = ev => { const q = toPt(sv, ev); if (!moved && Math.hypot(q.x - pt.x, q.y - pt.y) < 2) return; moved = true; gEl.setAttribute("transform", `translate(${sx + q.x - pt.x} ${sy + q.y - pt.y})`); };
      const up = ev => {
        sv.removeEventListener("pointermove", mv); sv.removeEventListener("pointerup", up); sv.removeEventListener("pointercancel", up);
        if (moved) { const q = toPt(sv, ev); doc.marking.edits[g] = { ...o, dx: +(sx + q.x - pt.x).toFixed(1), dy: +(sy + q.y - pt.y).toFixed(1) }; save(false); }
        else { sel = g + "@" + p; draw(); showSelBar(gEl, g); }
      };
      sv.addEventListener("pointermove", mv); sv.addEventListener("pointerup", up); sv.addEventListener("pointercancel", up);
    });
  }
  const toPt = (sv, e) => { const r = sv.getBoundingClientRect(), vb = sv.viewBox.baseVal; return { x: (e.clientX - r.left) / r.width * vb.width, y: (e.clientY - r.top) / r.height * vb.height }; };
  function showSelBar(gEl, g) {
    let b = $("#markSel"); if (!b) { b = document.createElement("div"); b.id = "markSel"; b.className = "marksel"; document.body.appendChild(b); }
    b.innerHTML = `<button type="button" data-a="del">Delete mark</button><button type="button" data-a="reset">Put back</button>`;
    const r = gEl.getBoundingClientRect(); b.style.left = Math.max(8, Math.min(innerWidth - 220, r.left)) + "px"; b.style.top = Math.max(8, r.top - 44) + "px"; b.hidden = false;
    b.onclick = ev => {
      const a = ev.target.dataset.a; if (!a) return;
      if (a === "del") { if (g.startsWith("x:")) doc.marking.extra.splice(+g.slice(2), 1); else doc.marking.edits[g] = { ...(doc.marking.edits[g] || {}), del: true }; }
      if (a === "reset" && !g.startsWith("x:")) delete doc.marking.edits[g];
      sel = null; hideSelBar(); save();
    };
  }
  function hideSelBar() { const b = $("#markSel"); if (b) b.hidden = true; }
  function save(relayout = true) { if (relayout) lay = null; emit("marking"); scheduleSave(); draw(); }
  function setEdit(on, type) {
    editMode = on; addType = on ? type || null : null; sel = null; hideSelBar();
    document.body.classList.toggle("markedit", on);
    draw(); panelHead();
  }

  // ---------------- the Marks panel ----------------
  function openPanel() { const pop = $("#marksPop"); if (!pop.hidden) { pop.hidden = true; return; } pop.hidden = false; renderPanel(); }
  function panelHead() {
    const h = $("#marksHead"); if (!h || !doc) return;
    const M = doc.marking;
    if (!M) { h.innerHTML = `<p class="note">No marking yet. Export for AI, have it marked, then import the marking file it sends back.</p><div class="row wrap"><button type="button" class="primary" data-a="import">Import marking…</button></div>`; return; }
    const T = totals(M), sm = M.summary;
    h.innerHTML = `<div class="mkscore"><b>${fmt(T.score)}/${fmt(T.outOf)}</b>${T.pct != null ? `<span>${T.pct}%</span>` : ""}${sm.grade ? `<em>Grade ${esc(sm.grade)}</em>` : ""}</div>
      ${sm.gradeNote ? `<small class="mknote">${esc(sm.gradeNote)}</small>` : ""}${sm.comment ? `<p class="mkcmt">${esc(sm.comment)}</p>` : ""}
      <div class="row wrap"><label class="chk"><input type="checkbox" data-a="on" ${isOn() ? "checked" : ""}> Show marks</label>
      <button type="button" data-a="edit" class="${editMode ? "on" : ""}">${editMode ? "Done editing" : "Edit marks"}</button>
      <button type="button" data-a="pdf">Export marked PDF</button></div>
      ${editMode ? `<div class="row wrap mkadd"><span>Tap the page to add:</span>${["tick", "cross", "circle", "note"].map(t => `<button type="button" data-a="add" data-t="${t}" class="${addType === t ? "on" : ""}">${{ tick: "✓ Tick", cross: "✗ Cross", circle: "◯ Circle", note: "✎ Note" }[t]}</button>`).join("")}</div><p class="note">Drag a mark to move it, tap one to delete it.</p>` : ""}
      <div class="row wrap"><button type="button" data-a="import">Import another…</button>${doc.markingPrev ? `<button type="button" data-a="undo">Undo last import</button>` : ""}<button type="button" data-a="remove" class="danger">Remove marking</button></div>
      ${(() => { const W = (lay && lay.warn) || M.warn || []; return W.length ? `<details class="mkwarn"><summary>${W.length} note${W.length > 1 ? "s" : ""} from the import</summary><ul>${W.map(w => `<li>${esc(w)}</li>`).join("")}</ul></details>` : ""; })()}`;
  }
  function renderPanel() {
    const pop = $("#marksPop"); if (!pop || pop.hidden || !doc) return;
    if (doc.marking && !lay) try { layout(); } catch (e) {}
    panelHead();
    const list = $("#marksList"); list.innerHTML = "";
    const M = doc.marking; if (!M) return;
    for (const pt of M.parts) {
      const b = document.createElement("button"); b.type = "button"; b.className = "mkrow v-" + pt.verdict;
      const where = (lay && lay.geo[pt.id] || [])[0];
      b.innerHTML = `<span class="mkq">${esc(qName(pt.q))}</span><span class="mkv">${pt.verdict}</span><span class="mkm">${pt.verdict === "excluded" ? "–" : `${fmt(pt.awarded)}/${fmt(pt.max)}`}</span>${pt.comment ? `<small>${esc(pt.comment)}</small>` : ""}${pt.correctOptions.length ? `<small class="mkans">Answer: ${pt.correctOptions.join(", ")}</small>` : ""}${pt.working.length ? `<small class="mkwork">${pt.working.map(esc).join("<br>")}</small>` : ""}`;
      if (where) b.onclick = () => { scrollToPoint(where.p, src(where.p, where.y0), 0.2); flash(pt); if (matchMedia("(max-width: 700px)").matches) $("#marksPop").hidden = true; };
      else { b.disabled = true; b.title = "Not found on this paper"; }
      list.appendChild(b);
    }
  }
  function flash(pt) { const els = []; for (const R of (lay && lay.geo[pt.id]) || []) if (R.r && R.r._el) els.push(R.r._el); for (const e of els) { e.classList.remove("jumpflash"); void e.offsetWidth; e.classList.add("jumpflash"); } }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function wire() {
    $("#marksBtn").onclick = openPanel;
    $("#marksPop").addEventListener("click", async e => {
      const t = e.target.closest("[data-a]"); if (!t) return;
      const a = t.dataset.a;
      if (a === "import") { $("#markDlg").showModal(); $("#markErr").textContent = ""; }
      if (a === "edit") setEdit(!editMode);
      if (a === "add") setEdit(true, addType === t.dataset.t ? null : t.dataset.t);
      if (a === "pdf") exportPDF(true);
      if (a === "undo" && doc.markingPrev) { const cur = doc.marking; doc.marking = doc.markingPrev; doc.markingPrev = cur; emit("marking"); emit("markingPrev"); scheduleSave(); refresh(); toast("The previous marking is back (Undo again to swap)."); }
      if (a === "remove" && confirm("Remove the marking from this paper? (Your answers stay as they are.)")) { doc.markingPrev = doc.marking; doc.marking = null; emit("marking"); emit("markingPrev"); setEdit(false); scheduleSave(); refresh(); }
    });
    $("#marksPop").addEventListener("change", e => { if (e.target.dataset.a === "on") setOn(e.target.checked); });
    document.addEventListener("pointerdown", e => { const pop = $("#marksPop"); if (pop && !pop.hidden && !pop.contains(e.target) && !$("#marksBtn").contains(e.target) && !e.target.closest("svg.marks") && !e.target.closest("#markSel") && !editMode) pop.hidden = true; });
    // importing: a file, or pasted JSON (on an iPad that's usually easier)
    const go = async text => {
      $("#markErr").textContent = "";
      try { busy(true, "Putting the marks on…"); const warn = await importText(text); busy(false); $("#markDlg").close(); $("#markPaste").value = ""; $("#marksPop").hidden = false; renderPanel(); toast(warn.length ? `Marking imported, with ${warn.length} note${warn.length > 1 ? "s" : ""} (see Marks).` : "Marking imported.", 4000); }
      catch (e) { busy(false); $("#markErr").textContent = e.message; }
    };
    $("#markFile").onchange = async e => { const f = e.target.files[0]; e.target.value = ""; if (f) go(await f.text()); };
    $("#markGo").onclick = () => go($("#markPaste").value);
    $("#markPasteBtn").onclick = async () => { try { const t = await navigator.clipboard.readText(); if (t) { $("#markPaste").value = t; go(t); } } catch (e) { $("#markErr").textContent = "Couldn't read the clipboard: paste into the box instead."; } };
    $("#markClose").onclick = () => $("#markDlg").close();
  }

  // ---------------- a #mark= link: gzip + base64url of the marking, opens its paper and imports it ----------------
  async function fromLink(hash) {
    const m = String(hash || "").match(/[#&]mark=([A-Za-z0-9_-]+)/); if (!m) return false;
    history.replaceState(null, "", location.pathname + location.search);
    let text;
    try {
      const bin = Uint8Array.from(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
      text = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    } catch (e) { toast("That marking link is damaged: " + e.message, 6000); return true; }
    let id = null; try { id = JSON.parse(text).paperId; } catch (e) {}
    if (id && (!doc || doc.id !== id)) {
      const entry = ((window.Home && Home.entries) || []).find(e => e.id === id);
      try { if (entry || id) await openStored(id, entry); } catch (e) { console.warn(e); }
    }
    if (!doc) { toast("Open the paper this marking is for, then use Marks → Import marking.", 6000); return true; }
    try { const warn = await importText(text); $("#marksPop").hidden = false; renderPanel(); toast(warn.length ? `Marking imported, with ${warn.length} note${warn.length > 1 ? "s" : ""}.` : "Marking imported.", 4000); }
    catch (e) { toast("Couldn't import that marking: " + e.message, 6000); }
    return true;
  }
  async function linkFor(json) {
    const bytes = await new Response(new Blob([typeof json === "string" ? json : JSON.stringify(json)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    let s = ""; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return location.origin + "/#mark=" + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // ---------------- into the marked PDF ----------------
  let handBytes = null;
  async function toPdf(out, page, p, tx, ty) {
    if (!doc.marking || !isOn()) return;
    if (!lay) layout();
    const shapes = lay.pages[p]; if (!shapes || !shapes.length) return;
    const { rgb, LineCapStyle, StandardFonts } = PDFLib;
    out._tpHand ||= await out.embedFont(handBytes ||= await (await fetch("fonts/PatrickHand-Regular.ttf")).arrayBuffer(), { subset: true });
    out._tpSans ||= await out.embedFont(StandardFonts.Helvetica); out._tpSansB ||= await out.embedFont(StandardFonts.HelveticaBold);
    const col = c => { const n = parseInt(c.slice(1), 16); return rgb((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255); };
    const ed = doc.marking.edits || {};
    for (const sh of shapes) {
      const o = ed[sh.g] || {}, dx = o.dx || 0, dy = o.dy || 0, X = x => tx(x + dx), Y = y => ty(y + dy);
      if (sh.k === "path") page.drawSvgPath(shiftPath(sh.d, dx, dy), { x: tx(0), y: ty(0), borderColor: col(sh.stroke), borderWidth: sh.w, borderLineCap: LineCapStyle.Round });
      else if (sh.k === "line") page.drawLine({ start: { x: X(sh.x1), y: Y(sh.y1) }, end: { x: X(sh.x2), y: Y(sh.y2) }, thickness: sh.w, color: col(sh.stroke) });
      else if (sh.k === "ell") page.drawEllipse({ x: X(sh.cx), y: Y(sh.cy), xScale: sh.rx, yScale: sh.ry, ...(sh.fill ? { color: col(sh.fill), opacity: sh.op ?? 1 } : {}), borderColor: col(sh.stroke), borderWidth: sh.w });
      else if (sh.k === "rect") page.drawRectangle({ x: X(sh.x), y: Y(sh.y + sh.h), width: sh.w, height: sh.h, ...(sh.fill ? { color: col(sh.fill), opacity: sh.op ?? 1 } : {}), ...(sh.stroke ? { borderColor: col(sh.stroke), borderWidth: sh.sw || 1, ...(sh.dash ? { borderDashArray: [3, 2] } : {}) } : {}) });
      else if (sh.k === "text") {
        const font = sh.font === "sans" ? (sh.bold ? out._tpSansB : out._tpSans) : out._tpHand;
        const ok = new Set(font.getCharacterSet ? font.getCharacterSet() : []), s = sh.font === "sans" ? sh.s.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?") : [...sh.s].map(ch => !ok.size || ok.has(ch.codePointAt(0)) ? ch : "?").join("");
        page.drawText(s, { x: X(sh.x), y: Y(sh.y), size: sh.size, font, color: col(sh.fill) });
      }
    }
  }
  const shiftPath = (d, dx, dy) => !dx && !dy ? d : d.replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)/g, (_, a, b) => `${+a + dx} ${+b + dy}`);

  // a #mark= link: once we know who's signed in (so the paper can be found in the library)
  function watchLink() {
    if (!/[#&]mark=/.test(location.hash)) return;
    let n = 0; const t = setInterval(() => { if ((window.Sync && Sync.info && window.Home && Home.entries && Home.entries.length) || ++n > 40) { clearInterval(t); fromLink(location.hash); } }, 250);
  }
  window.addEventListener("hashchange", watchLink);
  setTimeout(watchLink, 0);
  document.fonts && document.fonts.load('12px "TP-hand"').then(() => { lay = null; draw(); }).catch(() => {});
  setTimeout(wire, 0);
  return { wire, refresh, pageChanged, draw, toPdf, importText, parse, fromLink, linkFor, layout: () => layout(), totals: () => doc && doc.marking && totals(doc.marking), get lay() { return lay; } };
})();
