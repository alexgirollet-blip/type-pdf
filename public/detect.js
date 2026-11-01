// detect.js — finds answer spaces on a rendered PDF page.
// Works on pixels (so it handles scans) and uses the text layer when there is one
// for labels, question numbering and the "is this a code answer" hint.
// All output coordinates are PDF points, origin top-left of the page view.
"use strict";
const Detect = (() => {
  const S = 2;              // analysis scale: px per pt
  const DARK = 165;         // grey level below which a pixel counts as ink
  const RULE = 212;         // lighter limit used only when looking for ruled lines (they're often pale grey)

  function grey(imgData) {
    const { data, width, height } = imgData;
    const g = new Uint8Array(width * height);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      // treat transparent as white
      const a = data[j + 3] / 255;
      g[i] = Math.round((0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]) * a + 255 * (1 - a));
    }
    return { g, w: width, h: height };
  }

  // thin rules (0.5pt = 1 px here) that fall between two pixel rows render as two faint rows, neither dark
  // enough on its own. Adding each pixel's darkness to its neighbour's (below, or to the right) makes such a
  // line read as solid wherever it lands. Lines found this way sit half a pixel lower/right (corrected later).
  function pairUp(G, vertical) {
    const { g, w, h } = G, o = new Uint8Array(w * h), step = vertical ? 1 : w;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, last = vertical ? x === w - 1 : y === h - 1;
      const d = (255 - g[i]) + (last ? 0 : 255 - g[i + step]);
      o[i] = d >= 255 ? 0 : 255 - d;
    }
    return { g: o, w, h };
  }

  // integral image of ink so any rectangle's ink count is O(1)
  function integral(G, dark = DARK) {
    const { g, w, h } = G;
    const I = new Uint32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += g[y * w + x] < dark ? 1 : 0;
        I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
      }
    }
    return I;
  }
  function inkIn(I, w, x0, y0, x1, y1) { // px, inclusive-exclusive, clamped
    const W = w + 1, H = I.length / W - 1;
    x0 = Math.max(0, Math.min(w, x0 | 0)); x1 = Math.max(0, Math.min(w, x1 | 0));
    y0 = Math.max(0, Math.min(H, y0 | 0)); y1 = Math.max(0, Math.min(H, y1 | 0));
    if (x1 <= x0 || y1 <= y0) return 0;
    return I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
  }

  // ---- horizontal rules (solid, dotted, dashed, underscores) ----
  function hRules(G, I, D = DARK) {
    const { g, w, h } = G;
    const T = 4;           // thinness probe distance (px)
    const GAP = 9;         // max gap inside a dotted line (px)
    const MINLEN = 7 * S;  // shortest rule kept (pt->px); short ones are only used for gaps in equations
    const segs = [];
    for (let y = T; y < h - T; y++) {
      const row = y * w;
      let x = 0, runs = [];
      while (x < w) {
        if (g[row + x] < D) {
          let a = x; while (x < w && g[row + x] < D) x++;
          const b = x;
          // thin: little ink T px above and below this run
          const above = inkIn(I, w, a - 1, y - T, b + 1, y - T + 1);
          const below = inkIn(I, w, a - 1, y + T, b + 1, y + T + 1);
          if (above + below <= Math.max(1, (b - a) * 0.3)) runs.push([a, b]);
        } else x++;
      }
      // merge thin runs separated by small gaps
      let cur = null;
      for (const r of runs) {
        if (cur && r[0] - cur.b <= GAP) { cur.b = r[1]; cur.ink += r[1] - r[0]; cur.n++; }
        else { if (cur) segs.push(cur); cur = { y, a: r[0], b: r[1], ink: r[1] - r[0], n: 1 }; }
      }
      if (cur) segs.push(cur);
    }
    const long = segs.filter(s => s.b - s.a >= MINLEN && (s.n >= 6 || s.ink / (s.b - s.a) > 0.85));
    // merge the 1–4 px rows that make up one physical line
    long.sort((p, q) => p.y - q.y || p.a - q.a);
    const lines = [];
    for (const s of long) {
      const m = lines.find(l => s.y - l.yb <= 2 && Math.min(l.b, s.b) - Math.max(l.a, s.a) > 0.6 * Math.min(l.b - l.a, s.b - s.a));
      if (m) { m.yb = s.y; m.a = Math.min(m.a, s.a); m.b = Math.max(m.b, s.b); m.ink = Math.max(m.ink, s.ink); m.n = Math.max(m.n, s.n); }
      else lines.push({ ya: s.y, yb: s.y, a: s.a, b: s.b, ink: s.ink, n: s.n });
    }
    return lines.map(l => ({
      x0: l.a / S, x1: l.b / S, y: (l.ya + l.yb) / 2 / S, th: (l.yb - l.ya + 1) / S,
      solid: l.ink / (l.b - l.a) > 0.85
    }));
  }

  // ---- vertical solid rules (table/box sides) ----
  function vRules(G) {
    const { g, w, h } = G;
    const MIN = 8 * S, T = 4, out = [];
    for (let x = T; x < w - T; x++) {
      let y = 0;
      while (y < h) {
        if (g[y * w + x] < DARK && g[y * w + x - T] >= DARK && g[y * w + x + T] >= DARK) {
          let a = y, miss = 0, b = y;
          while (y < h && miss <= 1) {
            const on = g[y * w + x] < DARK && g[y * w + x - T] >= DARK && g[y * w + x + T] >= DARK;
            if (on) { b = y; miss = 0; } else miss++;
            y++;
          }
          if (b - a >= MIN) out.push({ x, a, b });
        } else y++;
      }
    }
    // merge adjacent columns
    out.sort((p, q) => p.x - q.x || p.a - q.a);
    const res = [];
    for (const s of out) {
      const m = res.find(r => s.x - r.xb <= 2 && Math.min(r.b, s.b) - Math.max(r.a, s.a) > 0.6 * Math.min(r.b - r.a, s.b - s.a));
      if (m) { m.xb = s.x; m.a = Math.min(m.a, s.a); m.b = Math.max(m.b, s.b); }
      else res.push({ xa: s.x, xb: s.x, a: s.a, b: s.b });
    }
    return res.map(r => ({ x: (r.xa + r.xb) / 2 / S, y0: r.a / S, y1: r.b / S }));
  }

  // ---- enclosed empty areas: table cells and answer boxes ----
  function enclosed(G, I, H, V, IF) {
    const { w, h } = G;
    if (!V.length) return [];
    const solidH = H.filter(l => l.solid);
    if (!solidH.length) return [];
    // mask of rule pixels, dilated so small gaps at corners close
    const M = new Uint8Array(w * h);
    const D = 2;
    for (const l of solidH) {
      const y0 = Math.round(l.y * S) - D, y1 = Math.round(l.y * S) + D;
      for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++)
        for (let x = Math.max(0, Math.round(l.x0 * S) - D); x <= Math.min(w - 1, Math.round(l.x1 * S) + D); x++) M[y * w + x] = 1;
    }
    for (const v of V) {
      const x0 = Math.round(v.x * S) - D, x1 = Math.round(v.x * S) + D;
      for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++)
        for (let y = Math.max(0, Math.round(v.y0 * S) - D); y <= Math.min(h - 1, Math.round(v.y1 * S) + D); y++) M[y * w + x] = 1;
    }
    // flood fill every non-rule area; keep ones not touching the page edge
    const seen = new Uint8Array(w * h), stack = new Int32Array(w * h), out = [];
    for (let s = 0; s < w * h; s++) {
      if (M[s] || seen[s]) continue;
      let sp = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0, edge = false;
      stack[sp++] = s; seen[s] = 1;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0; n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
        if (x > 0 && !M[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (x < w - 1 && !M[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (y > 0 && !M[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
        if (y < h - 1 && !M[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
      }
      if (edge) continue;
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (bw < 10 * S || bh < 8 * S) continue;
      if (n < 0.8 * bw * bh) continue;                 // not rectangular
      if (bw * bh > 0.6 * w * h) continue;             // whole-page frame
      const pad = 3;
      const ink = inkIn(I, w, x0 + pad, y0 + pad, x1 - pad + 1, y1 - pad + 1);
      const area = Math.max(1, (bw - 2 * pad) * (bh - 2 * pad));
      // graph paper: the squares are crossed by faint minor gridlines, which a real answer cell never is
      const faint = inkIn(IF, w, x0 + pad, y0 + pad, x1 - pad + 1, y1 - pad + 1);
      const grid = faint / area > 0.03;
      out.push({ x0: x0 / S, y0: y0 / S, x1: (x1 + 1) / S, y1: (y1 + 1) / S, empty: !grid && ink / area < 0.002 && ink < 12, grid });
    }
    return out;
  }

  // ---- text layer helpers ----
  function textItems(tc, viewport) {
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const [a, b, c, d, e, f] = pdfjsLib.Util.transform(viewport.transform, it.transform);
      const fh = Math.hypot(c, d) || Math.hypot(a, b);
      const x = e, base = f;
      items.push({ str: it.str, x, y0: base - fh * 0.85, y1: base + fh * 0.2, x1: x + (it.width || 0) * viewport.scale, base, fh });
    }
    return items;
  }

  // ---- multiple choice: tick boxes, ovals and pills to fill in ----
  // small closed outlines (a square, or a round/pill shape) with nothing inside, not part of the printed text,
  // that come in a group of the same size lined up in a row or a column
  const BOX_CHAR = /^[\u25A1\u25A2\u2610\u274F\u2751\u2B1C\u25CB\u25EF\u26AA]$|^[\uE000-\uF8FF]$/;
  function choices(G, items, dbg) {
    const { g, w, h } = G, lab = new Int32Array(w * h), stack = new Int32Array(w * h);
    const found = [];
    let id = 0;
    for (let start = 0; start < g.length; start++) {
      if (g[start] >= DARK || lab[start]) continue;
      id++; let sp = 0, n = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
      stack[sp++] = start; lab[start] = id;
      while (sp) {
        const i = stack[--sp], x = i % w, y = (i - x) / w; n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx; if (!lab[j] && g[j] < DARK) { lab[j] = id; stack[sp++] = j; }
        }
      }
      const bw = (x1 - x0 + 1) / S, bh = (y1 - y0 + 1) / S;
      // small capsules (AQA prints a 3–4 pt one inside each answer box) must be clearly wider than tall
      const why = m => { if (dbg && bw > 4 && bw < 40 && bh > 2 && bh < 30) dbg.push([m, +(x0 / S).toFixed(1), +(y0 / S).toFixed(1), +bw.toFixed(1), +bh.toFixed(1)]); };
      if (bh < 2.5 || bh > 28 || bw < 5 || bw > 64 || bw / bh < (bh < 7 ? 1.6 : 0.7) || bw / bh > 4.2) { why("size"); continue; }
      const per = 2 * (x1 - x0 + y1 - y0 + 2), thick = n / per;
      if (thick < 0.5 || thick > 5) { why("thick " + thick.toFixed(2)); continue; }
      // a closed outline: ink on all four sides, on the middle row and column
      const my = (y0 + y1) >> 1, mx = (x0 + x1) >> 1, bx = Math.max(2, Math.round((x1 - x0) * 0.3)), by = Math.max(2, Math.round((y1 - y0) * 0.3));
      const has = (ax, ay, bx2, by2) => { for (let y = ay; y <= by2; y++) for (let x = ax; x <= bx2; x++) if (lab[y * w + x] === id) return true; return false; };
      if (!has(x0, my - 1, x0 + bx, my + 1) || !has(x1 - bx, my - 1, x1, my + 1) || !has(mx - 1, y0, mx + 1, y0 + by) || !has(mx - 1, y1 - by, mx + 1, y1)) { why("ring"); continue; }
      const cx = Math.max(1, Math.round((x1 - x0) * 0.12)), cy = Math.max(1, Math.round((y1 - y0) * 0.12));
      const square = has(x0, y0, x0 + cx, y0 + cy) && has(x1 - cx, y1 - cy, x1, y1);
      // nothing inside (a letter printed in the middle of an oval is allowed: it names the option)
      const ix0 = x0 + Math.max(bx * 0.8, 2 * S) | 0, ix1 = x1 - Math.max(bx * 0.8, 2 * S) | 0, iy0 = y0 + Math.max(by * 0.8, 2 * S) | 0, iy1 = y1 - Math.max(by * 0.8, 2 * S) | 0;
      let inside = 0, area = 0;
      for (let y = iy0; y <= iy1; y++) for (let x = ix0; x <= ix1; x++) { area++; if (g[y * w + x] < DARK) inside++; }
      const box = { x0: x0 / S, y0: y0 / S, x1: (x1 + 1) / S, y1: (y1 + 1) / S, shape: square ? "box" : "oval" };
      // not printed text (a letter O, a 0, a boxed question number): any text over it rules it out, except a box
      // character, or one capital letter sitting inside it
      const over = items.filter(it => it.x < box.x1 - 1 && it.x1 > box.x0 + 1 && it.y0 < box.y1 - 1 && it.y1 > box.y0 + 1);
      let letter = "";
      if (over.length) {
        if (over.every(it => BOX_CHAR.test(it.str.trim()))) { /* a tick box drawn with a font */ }
        else if (over.length === 1 && /^[A-F]$/.test(over[0].str.trim()) && over[0].x >= box.x0 && over[0].x1 <= box.x1 + 1 &&
          box.y1 - box.y0 > over[0].fh * 1.15 && box.x1 - box.x0 > (over[0].x1 - over[0].x) * 1.8) letter = over[0].str.trim();   // bigger than the letter itself
        else { why("text"); continue; }
      }
      if (!letter && area && inside > area * 0.03) { why("inside"); continue; }
      if (letter) box.opt = letter;
      // inside a printed answer box (AQA): the whole box is what you click, the capsule is what gets filled in
      if (bh < 7) {
        const cxp = (x0 + x1) >> 1, cyp = (y0 + y1) >> 1, lim = 16 * S, dk = (x, y) => x >= 0 && y >= 0 && x < w && y < h && g[y * w + x] < DARK && lab[y * w + x] !== id;
        let L = x0 - 1, R = x1 + 1, T = y0 - 1, B = y1 + 1;
        while (L > x0 - lim && !dk(L, cyp)) L--; while (R < x1 + lim && !dk(R, cyp)) R++;
        while (T > y0 - lim && !dk(cxp, T)) T--; while (B < y1 + lim && !dk(cxp, B)) B++;
        if (L > x0 - lim && R < x1 + lim && T > y0 - lim && B < y1 + lim) {
          const o = { x0: (L + 1) / S, y0: (T + 1) / S, x1: R / S, y1: B / S }, W2 = o.x1 - o.x0, H2 = o.y1 - o.y0;
          box.mark = [(box.x0 - o.x0) / W2, (box.y0 - o.y0) / H2, (box.x1 - o.x0) / W2, (box.y1 - o.y0) / H2].map(v => +v.toFixed(3));   // where the capsule sits in the box (fractions)
          Object.assign(box, o, { shape: "oval" });
        }
      }
      if (bh < 7 && !box.mark) { why("tiny alone"); continue; }                               // a tiny capsule on its own could be anything
      found.push(box);
    }
    // keep shapes with a partner of the same size, lined up in a row or a column
    const same = (a, b) => Math.abs((a.x1 - a.x0) - (b.x1 - b.x0)) < 0.2 * (a.x1 - a.x0) + 1 && Math.abs((a.y1 - a.y0) - (b.y1 - b.y0)) < 0.2 * (a.y1 - a.y0) + 1;
    const lined = (a, b) => (Math.abs(a.x0 - b.x0) < 4 && Math.abs(a.y0 - b.y0) < 260) || (Math.abs((a.y0 + a.y1) - (b.y0 + b.y1)) < 8 && Math.abs(a.x0 - b.x0) < 400);
    const out = found.filter(a => found.some(b => b !== a && same(a, b) && lined(a, b)));
    // what each option says: a letter beside it (A–F), or the words on the same line
    for (const c of out) {
      if (c.opt) continue;
      const cyy = (c.y0 + c.y1) / 2, row = items.filter(it => it.base > cyy - (c.y1 - c.y0) && it.base < cyy + (c.y1 - c.y0) * 1.2 && it.str.trim());
      const near = row.filter(it => /^[A-F]$/.test(it.str.trim()) && (Math.abs(it.x1 - c.x0) < 30 || Math.abs(it.x - c.x1) < 30));
      if (near.length) { c.opt = near.sort((a, b) => Math.min(Math.abs(a.x1 - c.x0), Math.abs(a.x - c.x1)) - Math.min(Math.abs(b.x1 - c.x0), Math.abs(b.x - c.x1)))[0].str.trim(); continue; }
      const right = row.filter(it => it.x >= c.x1 - 1 && it.x < c.x1 + 160).sort((a, b) => a.x - b.x).map(it => it.str).join(" ").trim();
      const left = row.filter(it => it.x1 <= c.x0 + 1).sort((a, b) => a.x - b.x).map(it => it.str).join(" ").trim();
      c.opt = (right ? right.slice(0, 60) : left.slice(-60)).replace(/\s+/g, " ").trim();
    }
    // a lone circle in a diagram has nothing written beside it; an answer always does
    return out.filter(c => c.mark || c.opt);
  }

  const CODE_RE = /\b(write|complete|rewrite|amend|modify|give)\b[^.]{0,80}\b(pseudo-?code|code|function|procedure|sub-?routine|algorithm|program|sql|statement|query|method|class|css|html|javascript|python)\b/i;

  // ---- main ----
  // canvas: page rendered at scale S. viewport: pdf.js viewport at scale 1.
  function page(canvas, viewport, tc) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const G = grey(ctx.getImageData(0, 0, canvas.width, canvas.height));
    const I = integral(G);
    const PW = viewport.width, PH = viewport.height;
    // rules are found on the row/column-paired image (so faint, off-pixel lines aren't missed); everything else uses the page as drawn
    // a pale line counts, but pale shading next to a line doesn't stop it looking thin
    const Gh = pairUp(G, false), Hall = hRules(Gh, integral(Gh, DARK), RULE).map(l => ({ ...l, y: l.y + 0.5 / S, th: Math.max(0.5, l.th - 1 / S) }));
    const H = Hall.filter(l => l.x1 - l.x0 >= 24);
    const V = vRules(pairUp(G, true)).map(v => ({ ...v, x: v.x + 0.5 / S }));
    const items = tc ? textItems(tc, viewport) : [];
    const inkPt = (x0, y0, x1, y1) => inkIn(I, G.w, x0 * S, y0 * S, x1 * S, y1 * S);

    // rules touched by two or more vertical lines are table/box borders
    const touching = l => V.filter(v => v.x >= l.x0 - 3 && v.x <= l.x1 + 3 && v.y0 <= l.y + 3 && v.y1 >= l.y - 3).length;
    const IF = integral(G, 238);   // any visible ink, however faint
    const boxes = enclosed(G, I, H.filter(l => l.x1 - l.x0 >= 34), V, IF);
    const gridAt = (x, y) => boxes.some(b => b.grid && x >= b.x0 - 2 && x <= b.x1 + 2 && y >= b.y0 - 2 && y <= b.y1 + 2);
    // the page frame: a rule whose two ends both meet long vertical rules
    const longV = V.filter(v => v.y1 - v.y0 > 0.45 * PH);
    const frameEdge = l => longV.some(v => Math.abs(v.x - l.x0) < 4) && longV.some(v => Math.abs(v.x - l.x1) < 4);
    const insideBox = (l) => boxes.some(b => l.x0 >= b.x0 - 2 && l.x1 <= b.x1 + 2 && l.y > b.y0 + 4 && l.y < b.y1 - 4);

    // answer lines: thin, long, blank band above, not a table border
    let lines = H.filter(l => {
      if (l.th > 3.5) return false;
      if (l.y < 25 || l.y > PH - 20) return false;                 // header/footer rules
      if (l.x1 - l.x0 > 0.92 * PW) return false;                     // full-width separators
      if (touching(l) >= 2 && !insideBox(l)) return false;
      if (frameEdge(l)) return false;
      if (gridAt((l.x0 + l.x1) / 2, l.y)) return false;                // a line of a graph's grid
      // short lines (24–60pt) only count as a gap in a sentence or equation: printed text on the same baseline right next to it
      if (l.x1 - l.x0 < 60 && !items.some(it => Math.abs(it.base - l.y) < 6 && it.str.trim() && (Math.abs(it.x1 - l.x0) < 30 || Math.abs(it.x - l.x1) < 30))) return false;
      if (l.x1 - l.x0 < 60 && items.some(it => it.str.trim() && it.base > l.y - 12 && it.base < l.y + 8 && Math.min(it.x1, l.x1) - Math.max(it.x, l.x0) > 2)) return false;   // printed text on or over it: not a gap
      // a box edge: ink runs straight up or down from both ends
      const vert = (x) => { const dn = inkPt(x - 1.2, l.y + 1.5, x + 1.2, l.y + 9), up = inkPt(x - 1.2, l.y - 9, x + 1.2, l.y - 1.5); return Math.max(dn, up) > 9 * S * 1.2; };
      if (vert(l.x0 + 0.5) && vert(l.x1 - 0.5) && !insideBox(l)) return false;                            // too short for an answer line
      // sits on a line of printed text (underline, text baseline) rather than being a rule
      const onText = items.some(it => Math.abs(it.base - l.y) < 2.6 && !/\.{4,}|_{4,}|…{2,}/.test(it.str) &&
        Math.min(it.x1, l.x1) - Math.max(it.x, l.x0) > 0.3 * (l.x1 - l.x0));
      if (onText) return false;
      const band = inkPt(l.x0 + 2, l.y - 11, l.x1 - 2, l.y - 2.5);
      const area = (l.x1 - l.x0 - 4) * 8.5 * S * S;
      return band / area < 0.012;
    });

    // label to the left of a line ("Name ......", "Advantage ......")
    const labelLeft = (l) => {
      const t = items.filter(it => it.base > l.y - 12 && it.base < l.y + 3 && it.x1 <= l.x0 + 6 && it.x1 > l.x0 - 160);
      if (t.length) return t.map(it => it.str).join(" ").trim();
      return inkPt(Math.max(0, l.x0 - 120), l.y - 10, l.x0 - 4, l.y + 1) > 30 * S ? "label" : "";
    };
    lines.sort((p, q) => p.y - q.y || p.x0 - q.x0);
    lines.forEach(l => l.label = labelLeft(l));

    // group lines into regions
    const groups = [];
    for (const l of lines) {
      const g = groups[groups.length - 1];
      if (g && !l.label) {
        const last = g.lines[g.lines.length - 1];
        const dy = l.y - last.y;
        const minx = Math.min(...g.lines.map(q => q.x0));
        const okSpacing = dy >= 11 && dy <= 50 && (g.lines.length < 2 || Math.abs(dy - g.sp) <= 3.5);
        const okX = l.x0 <= minx + 6 && l.x1 > minx + 40 && Math.min(l.x1, Math.max(...g.lines.map(q => q.x1))) - Math.max(l.x0, minx) > 60;
        // nothing printed between the two rules apart from the rules themselves
        const between = items.some(it => it.base > last.y + 3 && it.base < l.y - 1 && it.x < Math.max(l.x1, last.x1) && it.x1 > Math.min(l.x0, last.x0) && !/^\.*$/.test(it.str.replace(/\s/g, "")));
        if (okSpacing && okX && !between) { g.lines.push(l); if (g.lines.length === 2) g.sp = dy; continue; }
      }
      groups.push({ lines: [l], sp: 0 });
    }
    // default spacing for single lines: page median, else 24
    const sps = groups.filter(g => g.sp).map(g => g.sp).sort((a, b) => a - b);
    const pageSp = sps.length ? sps[sps.length >> 1] : 24;

    // a lone solid rule with printed text straight under it is a separator, not an answer line
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i]; if (g.lines.length > 1) continue; const l = g.lines[0];
      if (!l.solid || l.label) continue;
      if (items.some(it => it.base > l.y + 2 && it.base < l.y + (l.x1 - l.x0 > 0.75 * PW ? 28 : 13) && it.x < l.x1 && it.x1 > l.x0)) groups.splice(i, 1);
    }
    const regions = [];
    for (const g of groups) {
      const xs0 = Math.min(...g.lines.map(l => l.x0)), xmax = Math.max(...g.lines.map(l => l.x1)), xmin = Math.min(...g.lines.map(l => l.x1));
      const xs1 = xmax - xmin < 45 ? xmin : xmax;   // keep clear of a "[2]" at the end of the last line
      let sp = g.sp || pageSp;
      // a single line: don't let it overlap whatever is printed above it
      if (g.lines.length === 1) {
        const l = g.lines[0];
        const above = items.filter(it => it.y1 < l.y - 2 && it.x < xs1 && it.x1 > xs0 - 160).map(it => it.y1);
        const lim = above.length ? l.y - Math.max(...above) : 40;
        sp = Math.max(12, Math.min(sp, lim + 2, 30));
      }
      regions.push({
        kind: "lines", x0: xs0, x1: xs1, ys: g.lines.map(l => l.y), sp,
        indent: Math.max(0, g.lines[0].x0 - xs0), label: g.lines[0].label || ""
      });
    }

    // empty enclosed areas → cells or boxes (skip ones already holding answer lines)
    for (const b of boxes) {
      if (!b.empty) continue;
      if (regions.some(r => r.kind === "lines" && r.x0 >= b.x0 - 2 && r.x1 <= b.x1 + 2 && r.ys[0] > b.y0 && r.ys[r.ys.length - 1] < b.y1)) continue;
      const hgt = b.y1 - b.y0;
      regions.push({ kind: hgt <= 36 ? "cell" : "box", x0: b.x0 + 1.5, x1: b.x1 - 1.5, y0: b.y0 + 1.5, y1: b.y1 - 1.5 });
    }

    // gaps for the mass and atomic numbers in a nuclear equation: two short stacked blanks just left of an element symbol
    const shortH = Hall.filter(l => l.x1 - l.x0 >= 6 && l.x1 - l.x0 <= 24 && l.th <= 1.5 && l.solid);
    const usedShort = new Set();
    for (const a of shortH) for (const b of shortH) {
      if (a === b || usedShort.has(a) || usedShort.has(b)) continue;
      const dy = b.y - a.y; if (dy < 7 || dy > 26) continue;
      if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) < 0.7 * Math.min(a.x1 - a.x0, b.x1 - b.x0)) continue;
      const x0 = Math.min(a.x0, b.x0), x1 = Math.max(a.x1, b.x1);
      const sym = items.find(it => /^[A-Z][a-z]?$/.test(it.str.trim()) && it.x >= x1 - 2 && it.x <= x1 + 14 && it.base > a.y - 2 && it.base < b.y + 8);
      if (!sym) continue;
      if (inkPt(x0 + 1, a.y + 1.2, x1 - 1, b.y - 1.2) > 4 * S) continue;          // something already written between them
      if (inkPt(x0 + 1, a.y - 9, x1 - 1, a.y - 1.2) > 4 * S) continue;            // and above the top one
      usedShort.add(a); usedShort.add(b);
      for (const l of [a, b]) regions.push({ kind: "cell", x0: l.x0 - 1, x1: l.x1 + 1, y0: l.y - Math.min(9, dy - 1), y1: l.y + 0.5 });
    }

    // multiple-choice boxes and ovals: clicked to choose. A tiny "cell" found on the same spot is the same thing.
    const ch = choices(G, items);
    for (const c of ch) {
      for (let i = regions.length - 1; i >= 0; i--) { const r = regions[i]; if (r.kind !== "lines" && r.x0 < c.x1 && r.x1 > c.x0 && r.y0 < c.y1 && r.y1 > c.y0 && (r.x1 - r.x0) < 40 && (r.y1 - r.y0) < 36) regions.splice(i, 1); }
      regions.push({ kind: "choice", x0: +c.x0.toFixed(1), y0: +c.y0.toFixed(1), x1: +c.x1.toFixed(1), y1: +c.y1.toFixed(1), shape: c.shape, opt: c.opt || "", ...(c.mark ? { mark: c.mark } : {}) });
    }

    // geometry common to all kinds: top/bottom in pt
    for (const r of regions) {
      if (r.kind === "lines") { r.y0 = r.ys[0] - r.sp; r.y1 = r.ys[r.ys.length - 1] + 2; }
    }
    // where the page can be split to add space under a region without cutting through print
    for (const r of regions) {
      r.cut = r.y1 + 3;
      for (let y = r.y1; y < r.y1 + 18; y += 0.5) if (inkPt(r.x0 - 40, y, r.x1 + 40, y + 0.5) === 0) { r.cut = y + 0.25; break; }
    }
    // code hint from the nearest instruction above
    for (const r of regions) {
      if (r.kind === "cell" || r.kind === "choice") continue;
      const above = items.filter(it => it.base < r.y0 + 4 && it.base > r.y0 - 260).sort((a, b) => a.base - b.base || a.x - b.x);
      const txt = above.map(it => it.str).join(" ");
      const lastSentence = txt.split(/(?<=[.?!])\s+/).slice(-3).join(" ");
      const nLines = r.kind === "lines" ? r.ys.length : (r.y1 - r.y0) / 20;
      r.code = nLines >= 3 && CODE_RE.test(lastSentence);
    }
    regions.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    return { regions, items: items.map(it => ({ s: it.str, x: +it.x.toFixed(1), y: +it.base.toFixed(1), x1: +it.x1.toFixed(1), h: +it.fh.toFixed(1) })), hasText: items.length > 0 };
  }

  return { page, S, textItems, choices, grey, _debug: { grey, integral, hRules, vRules, pairUp } };
})();
