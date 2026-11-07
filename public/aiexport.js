// aiexport.js — the export for AI marking: typed answers as JSON, and only the handwritten work as a small PDF.
//
// Everything is worked out from a model of the paper:
//   parts     every printed question number / part (the question markers), with its own question text
//   answers   every answer space, labelled with its part: AQA's hidden "Answer space for question 01.2" label when
//             the paper has one, else the nearest part printed above it. Gap-fills are labelled one by one;
//             a multiple-choice question is one answer with its options.
//   workings  clusters of handwriting, given to the part they belong to: the answer space they're in, the part that
//             asks you to draw on the figure they're on ("draw an arrow on Figure 7"), else the nearest part number.
// Text keeps its maths: ^{…} superscripts, _{…} subscripts and \frac{…}{…} stacked fractions.
"use strict";

// ---- the text of each page, read once per export: font sizes (for super/subscripts) and AQA's answer labels ----
let aiCache = null;   // { id, pages: [{ items, tags, cover }] }
async function aiPrep() {
  if (!doc || !pdf) return;
  if (aiCache && aiCache.id === doc.id && aiCache.pages.length === doc.pages.length) return;
  const pages = [];
  for (let p = 0; p < doc.pages.length; p++) {
    const P = doc.pages[p]; let items = [], tags = [];
    if (P && P.hasText) {
      try {
        const page = await pdf.getPage(p + 1), vp = page.getViewport({ scale: 1 });
        for (const it of Detect.textItems(await page.getTextContent(), vp)) {
          const m = it.str.match(/answer space for (?:question|part)\s*([0-9]{1,2}(?:\s*\.\s*[0-9]{1,2})?(?:\s*\([a-z]{1,4}\))*)/i);
          if (m) { tags.push({ label: tagLabel(m[1]), x: it.x, y: it.base }); continue; }      // invisible: a label, not printed text
          items.push({ s: it.str, x: it.x, x1: it.x1, y: it.base, h: it.fh });
        }
      } catch (e) { items = (P.items || []).map(it => ({ ...it, h: it.h || 11 })); }
    } else if (P) items = (P.items || []).map(it => ({ ...it, h: it.h || 11 }));
    const all = items.map(it => it.s).join(" ");
    // the front cover with the candidate's details: not part of any answer
    const cover = [/surname/i, /forename/i, /candidate (number|signature)/i, /centre number/i].filter(re => re.test(all)).length >= 2;
    pages.push({ items, tags, cover });
  }
  aiCache = { id: doc.id, pages };
}
const tagLabel = s => { const m = String(s).replace(/\s+/g, "").match(/^0*(\d+)(?:\.0*(\d+))?(.*)$/); return m ? m[1] + (m[2] ? "." + m[2] : "") + (m[3] || "") : s; };
const aiPage = p => (aiCache && aiCache.id === doc.id && aiCache.pages[p]) || { items: ((doc.pages[p] && doc.pages[p].items) || []).map(it => ({ ...it, h: it.h || 11 })), tags: [], cover: false };

// ---- text with its maths kept: lines from baselines, small raised/lowered text as ^{…}/_{…}, stacked pairs as fractions ----
function richText(its) {
  its = its.filter(it => it.s && it.s.trim());
  if (!its.length) return "";
  const hs = its.map(it => it.h).sort((a, b) => a - b), main = hs[Math.floor(hs.length * 0.7)] || 11;
  const big = its.filter(it => it.h >= main * 0.8), small = its.filter(it => it.h < main * 0.8);
  const lines = [];
  for (const it of big.sort((a, b) => a.y - b.y || a.x - b.x)) {
    let L = lines.find(l => Math.abs(l.y - it.y) < main * 0.3);
    if (!L) { L = { y: it.y, toks: [] }; lines.push(L); }
    L.toks.push({ ...it, t: "" });
  }
  for (const it of small) {
    let L = null, d = Infinity;
    for (const l of lines) { const dd = Math.abs(l.y - it.y); if (dd < d && dd < main * 0.9) { d = dd; L = l; } }
    if (!L) { L = { y: it.y, toks: [] }; lines.push(L); }
    L.toks.push({ ...it, t: it.y < L.y - main * 0.12 ? "sup" : it.y > L.y + main * 0.08 ? "sub" : "" });
  }
  lines.sort((a, b) => a.y - b.y);
  // a stacked fraction: one short line just above and one just below a line, overlapping each other side to side
  for (const L of lines) {
    const up = lines.filter(u => u !== L && L.y - u.y > main * 0.3 && L.y - u.y < main * 1.0), dn = lines.filter(u => u !== L && u.y - L.y > main * 0.3 && u.y - L.y < main * 1.0);
    for (const U of up) for (const a of [...U.toks]) for (const D of dn) for (const b of [...D.toks]) {
      const ov = Math.min(a.x1, b.x1) - Math.max(a.x, b.x);
      if (ov > 0.3 * Math.min(a.x1 - a.x, b.x1 - b.x, 999) && U.toks.includes(a) && D.toks.includes(b)) {
        L.toks.push({ s: `\\frac{${a.s.trim()}}{${b.s.trim()}}`, x: Math.min(a.x, b.x), x1: Math.max(a.x1, b.x1), y: L.y, h: main, t: "" });
        U.toks.splice(U.toks.indexOf(a), 1); D.toks.splice(D.toks.indexOf(b), 1);
      }
    }
  }
  const out = [];
  for (const L of lines) {
    if (!L.toks.length) continue;
    L.toks.sort((a, b) => a.x - b.x);
    let s = "", prevEnd = -1e9, prevT = "";
    for (const k of L.toks) {
      const txt = k.s.replace(/\s+/g, " ");
      const gap = k.x - prevEnd > main * 0.15;
      if (k.t) {
        if (prevT === k.t && !gap) s = s.replace(/\}$/, "") + txt.trim() + "}";
        else s += (gap && s && !k.t ? " " : "") + (k.t === "sup" ? "^{" : "_{") + txt.trim() + "}";
      } else s += (gap && s ? " " : "") + txt;
      prevEnd = Math.max(prevEnd, k.x1); prevT = k.t;
    }
    out.push(s.trim());
  }
  return out.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

// page furniture that's never part of a question
const FURNITURE = /^(do not write( outside the)?( box)?|outside the box|box|turn over\s*[►▶>]?|question \d+ continues on the next page|answer all questions( in the spaces provided)?\.?|blank page|end of questions|there are no questions printed on this page|copyright.*|©.*|pmt|ib\/[a-z]\/.*|\*\d+\*)$/i;
function isFurniture(it, P) {
  const s = it.s.trim();
  if (FURNITURE.test(s) || /^\.{3,}$/.test(s) || /^_{3,}$/.test(s)) return true;
  if (/^\d{1,3}$/.test(s) && (it.y < 70 || it.y > P.h - 45)) return true;   // page numbers, barcode digits
  if (it.x > P.w * 0.86 && (it.h || 11) < 9.5) return true;                  // "Do not write outside the box" in the margin
  return false;
}

// ---- the model ----
function aiModel() {
  const idx = labelIndex().filter(e => !aiPage(e.p).cover);
  const cover = p => aiPage(p).cover;
  // which part an answer space belongs to: AQA's hidden label in it, else the nearest part printed above it
  const labelFor = (p, r) => {
    const R = regionRect(p, r);
    const tag = aiPage(p).tags.find(t => t.x >= r.x0 - 25 && t.x <= r.x1 && disp(p, t.y) >= R.y0 - 40 && disp(p, t.y) <= R.y1 + 4);
    if (tag) return tag.label;
    let lab = "?"; for (const e of idx) { if (e.p < p || (e.p === p && e.y <= r.y0 + (r.kind === "choice" ? 2 : 6))) lab = e.label; else break; }
    return lab;
  };
  const inked = inkedRegions();
  const parts = new Map();     // label → { label, p, y, m, regions: [[p, r]] }
  for (const e of idx) if (!parts.has(e.label)) parts.set(e.label, { label: e.label, p: e.p, y: e.y, m: e.m, regions: [] });
  doc.pages.forEach((P, p) => {
    if (!P || cover(p)) return;
    for (const r of [...P.regions].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
      if (figureOf(p, r)) continue;                                   // a figure's frame
      const lab = labelFor(p, r);
      if (!parts.has(lab)) parts.set(lab, { label: lab, p, y: r.y0 - 20, m: null, regions: [] });
      parts.get(lab).regions.push([p, r]);
    }
  });
  // each part's own wording: from its number to its first answer space or the next part's number, whichever comes first
  const order = [...parts.values()].sort((a, b) => a.p - b.p || a.y - b.y);
  const markBoxes = p => (doc.pages[p].qs || []);
  for (let i = 0; i < order.length; i++) {
    const pt = order[i], P = doc.pages[pt.p], nx = order.slice(i + 1).find(o => o.m);
    let end = P.h;
    if (nx && nx.p === pt.p) end = Math.min(end, nx.y - 1);
    const first = pt.regions.find(([q]) => q === pt.p);
    if (first) end = Math.min(end, first[1].y0 + (first[1].kind === "choice" ? -2 : 4));
    const y0 = pt.m ? pt.y - 2 : end - 160;
    const its = aiPage(pt.p).items.filter(it => it.y > y0 && it.y < end + 1 && !isFurniture(it, P) &&
      !markBoxes(pt.p).some(m => it.y >= m.y0 - 2 && it.y <= m.y1 + 4 && it.x1 <= m.x1 + 4 && it.s.trim().length <= 10 && /^[\s\d.·()ivxa-hQ]+$/i.test(it.s)) &&   // the printed number itself (0 1 . 1)
      !(P.regions.some(r => r.kind === "choice" && it.y > r.y0 - 4 && it.y < r.y1 + 6)));                           // the options
    pt.text = richText(its).slice(0, 1200);
  }
  return { idx, parts, order, inked, labelFor };
}

// a box with a "Figure N" caption just above it or inside it is the figure's frame, not somewhere to write
function figureOf(p, r) {
  if (r.kind !== "box") return null;
  const cap = aiPage(p).items.find(it => /^fig(ure)?\.?\s*\d+/i.test(it.s.trim()) && it.y > r.y0 - 40 && it.y < r.y1 && it.x < r.x1 + 40 && it.x1 > r.x0 - 40);
  return cap ? cap.s.trim().match(/\d+/)[0] : null;
}
// what a gap-fill blank is: the mass / proton number in a nuclear equation, else the words either side of it
function gapLabel(p, r, k, cells) {
  const its = aiPage(p).items, cy = (r.y0 + r.y1) / 2;
  const sym = its.find(it => /^[A-Z][a-z]?$/.test(it.s.trim()) && it.x >= r.x1 - 2 && it.x <= r.x1 + 16 && it.y > r.y0 - 12 && it.y < r.y1 + 18);
  const pair = cells.find(c => c !== r && Math.min(c.x1, r.x1) - Math.max(c.x0, r.x0) > 2 && Math.abs((c.y0 + c.y1) / 2 - cy) < 26 && Math.abs((c.y0 + c.y1) / 2 - cy) > 4);
  if (sym && pair) return `${pair.y0 > r.y0 ? "mass (nucleon) number" : "proton (atomic) number"} of ${sym.s.trim()}`;
  if (sym) return `before ${sym.s.trim()}`;
  const row = its.filter(it => Math.abs(it.y - (r.y1 - 1)) < 7 || (it.y > r.y0 && it.y < r.y1 + 3));
  const left = richText(row.filter(it => it.x1 <= r.x0 + 2 && it.x1 > r.x0 - 120)).split(" ").slice(-4).join(" ");
  const right = richText(row.filter(it => it.x >= r.x1 - 2 && it.x < r.x1 + 120)).split(" ").slice(0, 4).join(" ");
  return `gap ${k}` + (left || right ? `: ${left ? "…" + left + " " : ""}___${right ? " " + right + "…" : ""}` : "");
}

// ---- the answers ----
// each answer entry remembers which answer spaces it came from (not part of the JSON: used to place marks later)
const withRegions = (e, regs) => Object.defineProperty(e, "_r", { value: regs.map(([p, r]) => ({ p, id: r.id })), enumerable: false });
// a stable id from a part label: "3(a)(iii)" → "3a-iii", "06.2" → "6.2", "E1(a)" → "e1a", "4-2 M3(b)" → "4-2m3b"
const idOfLabel = q => String(q).toLowerCase().replace(/^0+(?=\d)/, "").replace(/\)\s*\(/g, "-").replace(/[()\s]/g, "") || "q";
function aiJSON(withQuestion) {
  const M = aiModel(), list = [];
  const done = id => !!(doc.text[id] || "").trim();
  for (const pt of M.order) {
    if (!pt.regions.length) continue;
    const pages = [...new Set(pt.regions.map(([p]) => p + 1))];
    const base = { q: pt.label, page: pages.length === 1 ? pages[0] : pages };
    if (withQuestion && pt.text) base.question = pt.text;
    // multiple choice: one answer, every option prefixed with its letter
    const ch = pt.regions.filter(([, r]) => r.kind === "choice");
    if (ch.length) {
      const opts = ch.map(([p, r], k) => {
        // the option's own line: up to halfway to the next option above or below
        const cy = (r.y0 + r.y1) / 2, near = ch.filter(([q, o]) => q === p && o !== r && Math.min(o.x1, r.x1) - Math.max(o.x0, r.x0) > 0).map(([, o]) => Math.abs((o.y0 + o.y1) / 2 - cy)).filter(d => d > 2);
        const band = Math.max(6, Math.min(near.length ? Math.min(...near) / 2 : 16, 22));
        const its = aiPage(p).items.filter(it => it.y > cy - band && it.y <= cy + band && !isFurniture(it, doc.pages[p]) && !(it.x >= r.x0 && it.x1 <= r.x1));
        let t = r.shape === "ring" && r.opt ? r.opt : richText(its) || r.opt || "";     // a lettered option knows its own words
        const L = "ABCDEFGH"[k];
        if (!/^[A-H]\b/.test(t)) t = (L + " " + t).trim();
        return { t: t.slice(0, 300), letter: t[0], chosen: done(r.id), inked: M.inked.has(r.id) };
      });
      const e = withRegions({ ...base, type: "multiple choice", options: opts.map(o => o.t), answer: opts.filter(o => o.chosen).map(o => o.letter) }, ch);
      if (opts.some(o => o.inked)) e.handwritten = "marked by hand on the paper: see the workings PDF";
      list.push(e);
    }
    // gap-fills and tables
    const cells = pt.regions.filter(([, r]) => r.kind === "cell");
    if (cells.length) {
      const rows = new Set(cells.map(([, r]) => Math.round(r.y0 / 6))), cols = new Set(cells.map(([, r]) => Math.round(r.x0 / 6)));
      if (rows.size >= 2 && cols.size >= 2 && cells.length >= 4) {
        const e = withRegions({ ...base, type: "table", note: "cells left to right, top to bottom", cells: cells.map(([, r]) => (doc.text[r.id] || "").trim()) }, cells);
        if (cells.some(([, r]) => M.inked.has(r.id))) e.handwritten = "some cells written by hand: see the workings PDF";
        list.push(e);
      } else cells.forEach(([p, r], k) => {
        const e = withRegions({ ...base, part: gapLabel(p, r, k + 1, cells.map(c => c[1])), type: "gap", answer: (doc.text[r.id] || "").trim() }, [[p, r]]);
        Object.defineProperty(e, "_gap", { value: k + 1, enumerable: false });
        if (k) delete e.question;
        if (M.inked.has(r.id)) e.handwritten = "written by hand: see the workings PDF";
        list.push(e);
      });
    }
    // written answers (lines and boxes): one per part, joined if a part has several spaces
    const typed = pt.regions.filter(([, r]) => r.kind === "lines" || r.kind === "box");
    if (typed.length) {
      // an answer that carries on over the page is one piece of text (its spaces were split between words)
      let ans = "";
      typed.forEach(([, r], k) => { const t = doc.text[r.id] || ""; if (!t.trim()) return; const joined = r.prev && k && typed[k - 1][1].id === r.prev; ans = joined ? ans + t : (ans.trim() ? ans.trim() + "\n" : "") + t; });
      const e = withRegions({ ...base, type: "written", answer: ans.trim() }, typed);
      const lab = typed.map(([, r]) => r.label).find(l => l && l !== "label"); if (lab) e.part = lab.replace(/[.\s]+$/, "").slice(0, 40);
      if (typed.some(([, r]) => M.inked.has(r.id))) e.handwritten = "written by hand: see the workings PDF";
      list.push(e);
    }
  }
  // drawings that belong to a part with no answer space (draw on Figure 7 …)
  const work = workingsItems(M);
  for (const w of work) {
    if (list.some(e => e.q === w.q && e.handwritten)) continue;
    const pt = M.parts.get(w.q);
    const e = { q: w.q, page: w.segs[0].p + 1, type: "drawn", handwritten: w.fig ? `drawn on Figure ${w.fig}: see the workings PDF` : "drawn or written by hand: see the workings PDF" };
    if (withQuestion && pt && pt.text) e.question = pt.text;
    const at = list.findIndex(x => M.order.findIndex(o => o.label === x.q) > M.order.findIndex(o => o.label === w.q));
    if (at < 0) list.push(e); else list.splice(at, 0, e);
  }
  // ids: unique and stable (the same paper exported again gives the same ids), so a marking can point at each answer
  const seen = new Set();
  for (const e of list) {
    let id = idOfLabel(e.q) + (e.type === "gap" ? "-gap" + (e._gap || 1) : e.type === "drawn" ? "-drawn" : e.type === "table" ? "-table" : "");
    if (seen.has(id)) { const sfx = e.type === "multiple choice" ? "-mc" : e.type === "written" ? "-written" : ""; if (sfx && !seen.has(id + sfx)) id += sfx; else { let n = 2; while (seen.has(id + "-" + n)) n++; id += "-" + n; } }
    seen.add(id);
    const ordered = { id }; for (const k of Object.keys(e)) ordered[k] = e[k];
    Object.defineProperty(ordered, "_r", { value: e._r || [], enumerable: false });
    list[list.indexOf(e)] = ordered;
  }
  // where each part's handwriting is in the workings PDF: which image, and the strip of the page each piece of it shows
  // (page coordinates in points from the top of the printed page; x runs the full page width)
  work.forEach((w, k) => {
    const W = Math.max(...w.segs.map(sg => doc.pages[sg.p].w)), GAP = 6; let y = 0;
    const crops = w.segs.map(sg => { const h = sg.y1 - sg.y0, c = { page: sg.p + 1, x0: 0, y0: +src(sg.p, sg.y0).toFixed(1), x1: +doc.pages[sg.p].w.toFixed(1), y1: +src(sg.p, sg.y1).toFixed(1), imageY0: +(y).toFixed(1), imageY1: +(y + h).toFixed(1) }; y += h + GAP; return c; });
    const H = y - GAP;
    for (const e of list) if (e.q === w.q && e.handwritten) e.workings = { image: k + 1, width: +W.toFixed(1), height: +H.toFixed(1), crops };
  });
  const answered = e => (e.answer && (Array.isArray(e.answer) ? e.answer.length : e.answer)) || (e.cells && e.cells.some(Boolean)) || e.handwritten;
  const o = { paper: doc.name, paperId: doc.id, exported: new Date().toISOString(), format: "typepdf-answers", version: 2 };
  if (doc.timer) o.time_used = fmtT(timerUsed(doc.timer)) + (doc.timer.up ? "" : " of " + fmtT(doc.timer.total));
  o.note = "Each answer has a unique id (use it to refer to that answer, e.g. in a marking file). Answers are listed by question part in paper order. Maths is written with ^{…} for superscripts, _{…} for subscripts and \\frac{a}{b} for fractions. Multiple-choice answers give the letters chosen. Anything marked 'handwritten' is in the separate workings PDF, one image per part, captioned with the part and page.";
  // so a marker knows what to send back (see docs/marking-schema.json)
  o.marking = { file: `${doc.name} - marking.json`, format: "typepdf-marking", version: 1, how: "To mark, return JSON {format, version:1, paperId, exported (both copied from here), marker, markedAt, summary:{score,outOf,grade,gradeNote,comment,perQuestion:[{q,awarded,max}]}, parts:[{id (from here), q, awarded, max, verdict: correct|partial|wrong|blank|excluded, comment, correction, annotations:[{type: tick|cross|underline|circle|caret|note|bracket, anchor: {kind:'text', match:'words from the answer', occurrence} | {kind:'workings', x,y,w,h (0-1 of that part's workings image)} | {kind:'part'} | {kind:'page', page, x, y}, text}]}]}." };
  o.answers = list.filter(answered);
  Object.defineProperty(o, "_all", { value: list, enumerable: false });
  const blank = list.filter(e => !answered(e)).map(e => e.q + (e.part ? ` [${e.part}]` : ""));
  const blankIds = list.filter(e => !answered(e)).map(e => e.id); if (blankIds.length) o.blankIds = blankIds;
  if (blank.length) o.blank = [...new Set(blank)];
  if (work.length) o.handwritten = work.map(w => ({ q: w.q, pages: [...new Set(w.segs.map(s => s.p + 1))], ...(w.fig ? { on: "Figure " + w.fig } : {}) }));
  const fl = [];
  doc.pages.forEach((P, p) => P.regions.forEach(r => { if (doc.flags && doc.flags[r.id]) fl.push(M.labelFor(p, r)); }));
  if (fl.length) o.flagged = [...new Set(fl)];
  return o;
}

// ---- the handwriting: clusters of ink, each given to its part, merged into one image per part ----
function workingsItems(M) {
  M ||= aiModel();
  const out = [];
  const DRAW = /\b(draw|sketch|add|mark|label|complete|show|plot|indicate|shade|circle|join)\b/i;
  doc.pages.forEach((P, p) => {
    if (!P || aiPage(p).cover) return;
    const strokes = (doc.strokes[p] || []).filter(s => s.t === "pen" && s.pts && s.pts.length);
    // clusters: strokes whose boxes come within 24 pt of each other
    const boxes = strokes.map(s => { const q = dispPts(p, s); const xs = q.map(v => v[0]), ys = q.map(v => v[1]); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), pts: q }; });
    const cl = [];
    for (const b of boxes) {
      let into = cl.filter(c => b.x0 < c.x1 + 24 && b.x1 > c.x0 - 24 && b.y0 < c.y1 + 24 && b.y1 > c.y0 - 24);
      const c = into.reduce((a, c2) => { a.x0 = Math.min(a.x0, c2.x0); a.x1 = Math.max(a.x1, c2.x1); a.y0 = Math.min(a.y0, c2.y0); a.y1 = Math.max(a.y1, c2.y1); a.pts.push(...c2.pts); return a; }, { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, pts: [...b.pts] });
      for (const c2 of into) cl.splice(cl.indexOf(c2), 1);
      cl.push(c);
    }
    for (const c of cl) {
      // 1. inside an answer space (or a multiple-choice box)
      let best = null, bn = 0;
      for (const r of P.regions) { if (figureOf(p, r)) continue; const R = regionRect(p, r); const n = c.pts.filter(v => v[0] >= R.x0 - 4 && v[0] <= R.x1 + 4 && v[1] >= R.y0 - 6 && v[1] <= R.y1 + 6).length; if (n > bn) { bn = n; best = r; } }
      let q = null, fig = null, y0 = c.y0, y1 = c.y1;
      if (best && bn >= c.pts.length * 0.5) { q = M.labelFor(p, best); const R = regionRect(p, best); y0 = Math.min(y0, R.y0); y1 = Math.max(y1, R.y1); }
      // 2. on a figure: the part that asks you to draw on that figure
      if (!q) {
        const cy = src(p, (c.y0 + c.y1) / 2);
        const caps = aiPage(p).items.filter(it => /^fig(ure)?\.?\s*\d+/i.test(it.s.trim())).map(it => ({ n: it.s.trim().match(/\d+/)[0], d: Math.abs(it.y - cy) })).filter(x => x.d < 330).sort((a, b) => a.d - b.d);
        if (caps.length) {
          fig = caps[0].n;
          const re = new RegExp(`\\bfig(ure)?\\.?\\s*${fig}\\b`, "i");
          const asks = M.order.filter(o => o.text && re.test(o.text));
          const pick = asks.find(o => DRAW.test(o.text)) || asks[0];
          if (pick) q = pick.label; else fig = null;
        }
      }
      // 3. the nearest part number: the one above it on this page, or the first one below if it's above them all
      if (!q) {
        const onPage = M.idx.filter(e => e.p === p), cy = src(p, c.y0);
        const above = onPage.filter(e => e.y <= cy + 4);
        const e = above.length ? above[above.length - 1] : onPage[0];
        q = e ? e.label : labelAt(M.idx, p, cy);
      }
      out.push({ q, fig, p, y0: Math.max(0, y0 - 18), y1: Math.min(P.h + totalGap(p), y1 + 14) });
    }
  });
  // one item per part, in paper order; pieces on the same page that touch are joined (no repeated lines)
  const items = [];
  for (const a of out.sort((m, n) => m.p - n.p || m.y0 - n.y0)) {
    let it = items.find(i => i.q === a.q);
    if (!it) { it = { q: a.q, fig: a.fig, segs: [] }; items.push(it); }
    if (a.fig && !it.fig) it.fig = a.fig;
    const last = it.segs.find(sg => sg.p === a.p && a.y0 <= sg.y1 + 30 && a.y1 >= sg.y0 - 30);
    if (last) { last.y0 = Math.min(last.y0, a.y0); last.y1 = Math.max(last.y1, a.y1); }
    else it.segs.push({ p: a.p, y0: a.y0, y1: a.y1 });
  }
  for (const it of items) {          // joined pieces may now overlap others on the same page
    it.segs.sort((a, b) => a.p - b.p || a.y0 - b.y0);
    for (let i = it.segs.length - 1; i > 0; i--) { const a = it.segs[i - 1], b = it.segs[i]; if (a.p === b.p && b.y0 <= a.y1 + 30) { a.y1 = Math.max(a.y1, b.y1); it.segs.splice(i, 1); } }
  }
  const at = q => { const i = M.order.findIndex(o => o.label === q); return i < 0 ? 1e9 : i; };
  return items.filter(it => it.segs.some(sg => sg.y1 - sg.y0 > 2)).sort((a, b) => at(a.q) - at(b.q));   // paper order
}
async function workingsPDF() {
  const items = workingsItems(); if (!items.length) return null;
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const out = await PDFDocument.create(), font = await out.embedFont(StandardFonts.Helvetica);
  const scale = 1.6, rasters = new Map();
  const raster = async p => { if (!rasters.has(p)) { if (rasters.size > 2) { const [k, v] = rasters.entries().next().value; v.width = 0; rasters.delete(k); } rasters.set(p, await pageRaster(p, scale, true)); } return rasters.get(p); };
  for (let i = 0; i < items.length; i++) {
    const it = items[i]; busy(true, `Preparing workings… ${i + 1} of ${items.length}`, i / items.length);
    // all of a part's pieces in one image, one under the other
    const W = Math.max(...it.segs.map(sg => doc.pages[sg.p].w)), GAP = 6;
    const H = it.segs.reduce((t, sg) => t + (sg.y1 - sg.y0), 0) + GAP * (it.segs.length - 1);
    const c = document.createElement("canvas"); c.width = Math.round(W * scale); c.height = Math.round(H * scale);
    const cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height); cx.filter = "grayscale(1)";
    let y = 0;
    for (const sg of it.segs) {
      const ras = await raster(sg.p), h = sg.y1 - sg.y0;
      cx.drawImage(ras, 0, sg.y0 * scale, ras.width, h * scale, 0, y * scale, ras.width, h * scale);
      y += h + GAP;
      if (y < H) { cx.filter = "none"; cx.fillStyle = "#bbb"; cx.fillRect(0, (y - GAP / 2) * scale, c.width, 1); cx.filter = "grayscale(1)"; }
    }
    const img = await out.embedJpg(await (await fetch(c.toDataURL("image/jpeg", 0.72))).arrayBuffer()); c.width = 0;
    const page = out.addPage([W, H + 18]);
    page.drawImage(img, { x: 0, y: 0, width: W, height: H });
    const pages = [...new Set(it.segs.map(sg => sg.p + 1))];
    page.drawText(`Question ${it.q} · page${pages.length > 1 ? "s " + pages.join("–") : " " + pages[0]}${it.fig ? ` · drawn on Figure ${it.fig}` : ""}`, { x: 10, y: H + 5, size: 9, font, color: rgb(0.2, 0.2, 0.2) });
  }
  for (const v of rasters.values()) v.width = 0;
  out.setTitle(doc.name + " – handwritten workings"); out.setCreator("TypePDF");
  return out.save();
}

// ---- the dialog ----
$("#aiBtn").onclick = async () => { await ensureOcr(); busy(true, "Reading the paper…"); await aiPrep().catch(e => console.warn(e)); busy(false); $("#aiDlg").showModal(); updateAiInfo(); };
$("#aiQ").onchange = updateAiInfo;
function updateAiInfo() {
  const o = aiJSON($("#aiQ").checked), txt = JSON.stringify(o), wk = o.handwritten || [];
  const typed = o.answers.filter(e => !e.handwritten || e.answer && (Array.isArray(e.answer) ? e.answer.length : e.answer)).length;
  $("#aiInfo").textContent = `${o.answers.length} answered (${typed} typed or chosen), ${(o.blank || []).length} blank. ${wk.length ? wk.length + " part" + (wk.length > 1 ? "s" : "") + " with handwriting go in the workings PDF." : "No handwriting, so no workings PDF is needed."} About ${Math.round(txt.length / 4).toLocaleString()} tokens of text.`;
  $("#aiWork").disabled = !wk.length;
}
// what was exported last, and which answer spaces each id is: kept with the paper (and synced) for marking
function rememberExport(o) {
  const ids = {};
  for (const e of o._all || o.answers) ids[e.id] = { q: e.q, type: e.type, r: (e._r || []).map(x => x.id), page: e.page, ...(e.workings ? { w: e.workings } : {}) };
  doc.aiExport = { exported: o.exported, ids };
  scheduleSave(); emit("aiexport");
  return o;
}
$("#aiCopy").onclick = async () => { const t = JSON.stringify(rememberExport(aiJSON($("#aiQ").checked)), null, 1); try { await navigator.clipboard.writeText(t); toast("Answers copied as JSON."); } catch (e) { fallbackCopy(t); } };
$("#aiJson").onclick = () => download(new Blob([JSON.stringify(rememberExport(aiJSON($("#aiQ").checked)), null, 1)], { type: "application/json" }), doc.name + " - answers.json");
$("#aiWork").onclick = async () => { try { const b = await workingsPDF(); busy(false); if (b) download(new Blob([b], { type: "application/pdf" }), doc.name + " - workings.pdf"); } catch (e) { busy(false); toast("Couldn't build the workings PDF: " + e.message); } };
$("#aiBoth").onclick = async () => { $("#aiJson").click(); if (!$("#aiWork").disabled) setTimeout(() => $("#aiWork").click(), 600); };
$("#aiClose").onclick = () => $("#aiDlg").close();
