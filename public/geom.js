// geom.js — drawing aids: the protractor with a ruler base, the compass, line of best fit, and the little
// length / angle labels shown while drawing. Sizes are true to the paper: the PDF says how big a page is
// (A4 = 21 × 29.7 cm), so 1 cm on the protractor is 1 cm on the printed paper, at any zoom.
"use strict";
const Geo = (() => {
  const CM = 72 / 2.54;                       // PDF points in a centimetre
  const STRIP = 0.8 * CM;                     // depth of the ruler strip under the protractor's base line
  const fmt = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);
  const cm = pt => fmt(pt / CM, 1);
  // angle of a line on the page, counted the usual way (anticlockwise from the right, 0–360)
  const angleOf = (a, b) => { let d = Math.atan2(a[1] - b[1], b[0] - a[0]) * 180 / Math.PI; if (d < 0) d += 360; return d; };

  // ---- a small label beside the pen ----
  let tagEl = null;
  function tag(p, q, text) {
    if (p === undefined || !text) { if (tagEl) tagEl.hidden = true; return; }
    const v = views[p]; if (!v) return;
    if (!tagEl) { tagEl = document.createElement("div"); tagEl.className = "geotag"; }
    if (tagEl.parentElement !== v.el) v.el.appendChild(tagEl);
    tagEl.hidden = false; tagEl.textContent = text;
    tagEl.style.left = q[0] * zoom + 14 + "px"; tagEl.style.top = q[1] * zoom - 30 + "px";
  }
  function shapeLabel(s) {
    const D = Shapes.dist;
    if (s.kind === "line" || s.kind === "arrow") return `${Shapes.name(s)} ${cm(D(s.a, s.b))} cm · ${fmt(angleOf(s.a, s.b), 0)}°`;
    if (s.kind === "ellipse") return s.rx === s.ry ? `Circle r = ${cm(s.rx)} cm` : `Ellipse ${cm(2 * s.rx)} × ${cm(2 * s.ry)} cm`;
    if (s.rect) return `${Shapes.name(s)} ${cm(D(s.pts[0], s.pts[1]))} × ${cm(D(s.pts[1], s.pts[2]))} cm`;
    return Shapes.name(s);
  }

  // ---- the protractor: a semicircle (0–180° both ways) on a ruler base marked in cm and mm ----
  // stored per paper on this device: page, centre (the middle of the base line, in page points), turn, radius
  let P = null, el = null;
  const key = () => "prot:" + (doc && doc.id);
  function save() { try { localStorage.setItem(key(), JSON.stringify(P)); } catch (e) {} }
  function load() { try { return JSON.parse(localStorage.getItem(key()) || "null"); } catch (e) { return null; } }
  function restore() { P = load(); if (P && P.on) place(); else remove(); $("#protBtn").classList.toggle("on", !!(P && P.on)); }
  function remove() { if (el) { el.remove(); el = null; } }
  function toggle() {
    if (!doc) return;
    if (P && P.on) { P.on = false; save(); remove(); $("#protBtn").classList.remove("on"); return; }
    // in the middle of what's on screen, 15 cm across
    const p = currentPage(), host = $("#pages"), v = views[p], r = v.el.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const cx = clamp(((hr.left + hr.right) / 2 - r.left) / zoom, 3 * CM, doc.pages[p].w - 3 * CM), cy = clamp(((hr.top + hr.bottom) / 2 - r.top) / zoom + 3.4 * CM, 8 * CM, doc.pages[p].h - CM);   // the whole thing on screen
    P = { on: true, p, cx, cy, ang: 0, R: 7.5 * CM, needle: 60 };
    save(); place(); $("#protBtn").classList.add("on");
    toast("Protractor: drag to move, twist with two fingers or the ⟳ handle to turn, drag ↔ to make it longer. Draw along any edge for a straight line or an arc.", 6000);
  }
  // local coordinates: origin at the centre, x along the base, y down (the semicircle is at y < 0)
  const toLocal = q => { const dx = q[0] - P.cx, dy = q[1] - P.cy, c = Math.cos(-P.ang), s = Math.sin(-P.ang); return [dx * c - dy * s, dx * s + dy * c]; };
  const toPage = l => { const c = Math.cos(P.ang), s = Math.sin(P.ang); return [P.cx + l[0] * c - l[1] * s, P.cy + l[0] * s + l[1] * c]; };
  function svgFor() {
    const R = P.R, n = Math.floor(2 * R / CM * 10 + 1e-6), parts = [];
    // body: semicircle and ruler strip
    parts.push(`<path class="pbody" d="M${-R} 0 A${R} ${R} 0 0 1 ${R} 0 L${R} ${STRIP} L${-R} ${STRIP} Z"/>`);
    parts.push(`<line class="pline" x1="${-R}" y1="0" x2="${R}" y2="0"/>`);
    // degree scale along the arc: 1° ticks, longer every 5° and 10°, two rows of numbers (0 at either end)
    const big = R > 3.2 * CM;
    for (let d = 0; d <= 180; d++) {
      const t = d * Math.PI / 180, L = d % 10 === 0 ? 0.45 * CM : d % 5 === 0 ? 0.3 * CM : 0.16 * CM;
      if (!big && d % 5) continue;
      const c = Math.cos(t), s = -Math.sin(t);
      parts.push(`<line class="ptick" x1="${R * c}" y1="${R * s}" x2="${(R - L) * c}" y2="${(R - L) * s}"/>`);
      if (d % 10 === 0 && (big || d % 30 === 0)) {
        const r1 = R - 0.75 * CM, r2 = R - 1.25 * CM, rot = 90 - d;
        parts.push(`<text class="pnum" x="${r1 * c}" y="${r1 * s}" transform="rotate(${rot} ${r1 * c} ${r1 * s})">${d}</text>`);
        if (big) parts.push(`<text class="pnum in" x="${r2 * c}" y="${r2 * s}" transform="rotate(${rot} ${r2 * c} ${r2 * s})">${180 - d}</text>`);
      }
    }
    // ruler along the bottom edge: mm ticks, numbered every cm from the left end
    for (let i = 0; i <= n; i++) {
      const x = -R + i * CM / 10, L = i % 10 === 0 ? 0.42 * CM : i % 5 === 0 ? 0.3 * CM : 0.18 * CM;
      parts.push(`<line class="ptick" x1="${x}" y1="${STRIP}" x2="${x}" y2="${STRIP - L}"/>`);
      if (i % 10 === 0) parts.push(`<text class="pcm" x="${x}" y="${STRIP - 0.5 * CM}">${i / 10}</text>`);
    }
    // centre mark, the angle needle and its reading
    const nt = P.needle * Math.PI / 180, nx = Math.cos(nt) * R, ny = -Math.sin(nt) * R;
    parts.push(`<path class="pcentre" d="M-6 0 L6 0 M0 -6 L0 6"/>`);
    parts.push(`<line class="pneedle" x1="0" y1="0" x2="${nx}" y2="${ny}"/>`);
    parts.push(`<circle class="ph pneedleh" data-h="needle" cx="${nx}" cy="${ny}" r="7"/>`);
    parts.push(`<text class="pread" x="0" y="${-0.3 * CM}">${Math.round(P.needle)}° · ${Math.round(180 - P.needle)}°</text>`);
    parts.push(`<text class="pread small" x="0" y="${-0.65 * CM}">${fmt(2 * R / CM, 1)} cm · turned ${Math.round(((-P.ang * 180 / Math.PI) % 360 + 360) % 360)}°</text>`);
    // handles: move (middle), turn (left end), length (right end)
    parts.push(`<g class="ph" data-h="move"><circle cx="0" cy="${-0.45 * R}" r="11"/><path d="M-6 ${-0.45 * R} L6 ${-0.45 * R} M0 ${-0.45 * R - 6} L0 ${-0.45 * R + 6}"/></g>`);
    parts.push(`<g class="ph" data-h="turn"><circle cx="${-R - 14}" cy="${STRIP / 2}" r="11"/><text x="${-R - 14}" y="${STRIP / 2 + 4}">⟳</text></g>`);
    parts.push(`<g class="ph" data-h="size"><circle cx="${R + 14}" cy="${STRIP / 2}" r="11"/><text x="${R + 14}" y="${STRIP / 2 + 4}">↔</text></g>`);
    return parts.join("");
  }
  function place() {
    if (!P || !P.on || !views[P.p]) { remove(); return; }
    const v = views[P.p], pad = 30;
    if (!el) { el = document.createElementNS("http://www.w3.org/2000/svg", "svg"); el.setAttribute("class", "protractor"); bindProt(el); }
    if (el.parentElement !== v.el) v.el.appendChild(el);
    const W = 2 * P.R + 2 * pad, H = P.R + STRIP + 2 * pad;
    el.setAttribute("viewBox", `${-P.R - pad} ${-P.R - pad} ${W} ${H}`);
    Object.assign(el.style, { left: (P.cx - P.R - pad) * zoom + "px", top: (P.cy - P.R - pad) * zoom + "px", width: W * zoom + "px", height: H * zoom + "px", transformOrigin: `${(P.R + pad) * zoom}px ${(P.R + pad) * zoom}px`, transform: `rotate(${P.ang}rad)` });
    const k = [P.R, P.needle, P.ang].join("|");
    if (el._k !== k) { el.innerHTML = svgFor(); el._k = k; }           // the markings only change with size, needle or turn
  }
  // moving, turning and resizing; the pen (and a mouse with a drawing tool) draws straight through it
  function bindProt(svg) {
    const touches = new Map(); let op = null, fwd = null;
    const drawing = e => e.pointerType === "pen" || (e.pointerType === "mouse" && ["pen", "hl", "compass", "eraser", "smart"].includes(tool));
    const pagePt = e => { const r = views[P.p].ink.getBoundingClientRect(); return [(e.clientX - r.left) / zoom, (e.clientY - r.top) / zoom]; };
    const clone = (type, e) => new PointerEvent(type, { pointerId: e.pointerId, pointerType: e.pointerType, clientX: e.clientX, clientY: e.clientY, pressure: e.pressure, buttons: e.buttons, button: e.button, shiftKey: e.shiftKey, isPrimary: e.isPrimary, tiltX: e.tiltX, tiltY: e.tiltY, bubbles: true, cancelable: true });
    svg.addEventListener("pointerdown", e => {
      const h = e.target.closest("[data-h]"), hk = h && h.dataset.h;
      try { svg.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault(); e.stopPropagation();
      if (!hk && drawing(e)) { fwd = e.pointerId; views[P.p].ink.dispatchEvent(clone("pointerdown", e)); return; }
      if (e.pointerType === "touch") touches.set(e.pointerId, [e.clientX, e.clientY]);
      const q = pagePt(e);
      if (touches.size === 2) { const [a, b] = [...touches.values()]; op = { kind: "twist", a0: Math.atan2(b[1] - a[1], b[0] - a[0]), ang0: P.ang, mid0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], c0: [P.cx, P.cy] }; return; }
      op = { kind: hk || "move", q0: q, c0: [P.cx, P.cy], ang0: P.ang, R0: P.R, id: e.pointerId };
    });
    svg.addEventListener("pointermove", e => {
      if (fwd === e.pointerId) { views[P.p].ink.dispatchEvent(clone("pointermove", e)); return; }
      if (touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (!op) return;
      const q = pagePt(e);
      if (op.kind === "twist" && touches.size === 2) {
        const [a, b] = [...touches.values()], an = Math.atan2(b[1] - a[1], b[0] - a[0]), mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        P.ang = op.ang0 + an - op.a0; P.cx = op.c0[0] + (mid[0] - op.mid0[0]) / zoom; P.cy = op.c0[1] + (mid[1] - op.mid0[1]) / zoom;
      } else if (op.id !== e.pointerId) return;
      else if (op.kind === "move") { P.cx = op.c0[0] + q[0] - op.q0[0]; P.cy = op.c0[1] + q[1] - op.q0[1]; }
      else if (op.kind === "turn") { const a0 = Math.atan2(op.q0[1] - P.cy, op.q0[0] - P.cx), a1 = Math.atan2(q[1] - P.cy, q[0] - P.cx); P.ang = op.ang0 + a1 - a0; if (!e.shiftKey) { const deg = P.ang * 180 / Math.PI, near = Math.round(deg / 15) * 15; if (Math.abs(deg - near) < 2) P.ang = near * Math.PI / 180; } }
      else if (op.kind === "size") { const l = toLocal(q); P.R = clamp(Math.round((Math.abs(l[0]) - 14) / (CM / 2)) * (CM / 2), 2 * CM, 25 * CM); }   // the handle sits 14 pt past the end; whole and half centimetres
      else if (op.kind === "needle") { const l = toLocal(q); let d = Math.atan2(-l[1], l[0]) * 180 / Math.PI; if (d < 0) d = l[0] > 0 ? 0 : 180; P.needle = e.shiftKey ? d : Math.round(d); }
      place();
    });
    const up = e => {
      if (fwd === e.pointerId) { views[P.p].ink.dispatchEvent(clone("pointerup", e)); fwd = null; return; }
      touches.delete(e.pointerId);
      if (op && (op.id === e.pointerId || op.kind === "twist")) { op = touches.size === 1 ? { kind: "move", q0: pagePt({ clientX: [...touches.values()][0][0], clientY: [...touches.values()][0][1] }), c0: [P.cx, P.cy], id: [...touches.keys()][0] } : null; save(); }
    };
    svg.addEventListener("pointerup", up); svg.addEventListener("pointercancel", up);
  }
  // ---- drawing along an edge: the ruler's bottom edge, the base line, or the curved edge ----
  function edgeAt(p, q) {
    if (!P || !P.on || P.p !== p || !(tool === "pen" || tool === "hl")) return null;
    const l = toLocal(q), thr = Math.max(5, 12 / zoom);
    if (Math.abs(l[1] - STRIP) < thr && Math.abs(l[0]) <= P.R + thr) return { kind: "line", y: STRIP };
    if (Math.abs(l[1]) < thr && Math.abs(l[0]) <= P.R + thr) return { kind: "line", y: 0 };
    if (l[1] < thr && Math.abs(Math.hypot(l[0], l[1]) - P.R) < thr) return { kind: "arc", r: P.R };
    return null;
  }
  function edgePoints(ed, a, b) {
    const la = toLocal(a), lb = toLocal(b);
    if (ed.kind === "line") { const x0 = clamp(la[0], -P.R, P.R), x1 = clamp(lb[0], -P.R, P.R); return [toPage([x0, ed.y]), toPage([x1, ed.y])]; }
    const t0 = Math.atan2(-la[1], la[0]), t1 = Math.atan2(-lb[1], lb[0]), n = Math.max(2, Math.ceil(Math.abs(t1 - t0) * 180 / Math.PI / 2)), out = [];
    for (let i = 0; i <= n; i++) { const t = t0 + (t1 - t0) * i / n; out.push(toPage([Math.cos(t) * ed.r, -Math.sin(t) * ed.r])); }
    return out;
  }
  function edgeLabel(ed, pts) {
    if (ed.kind === "line") return `${cm(Shapes.dist(pts[0], pts[pts.length - 1]))} cm`;
    const a = toLocal(pts[0]), b = toLocal(pts[pts.length - 1]);
    return `${Math.round(Math.abs(Math.atan2(-b[1], b[0]) - Math.atan2(-a[1], a[0])) * 180 / Math.PI)}° of arc`;
  }

  // ---- compass: press where the point goes, drag out the radius (whole millimetres), let go to draw the circle ----
  function compassDown(p, e) {
    if (e.pointerType === "touch") return false;                         // fingers still scroll
    const v = views[p], at = ev => { const r = v.ink.getBoundingClientRect(); return [(ev.clientX - r.left) / zoom, (ev.clientY - r.top) / zoom]; };
    const c = at(e); e.preventDefault(); try { v.ink.setPointerCapture(e.pointerId); } catch (err) {}
    const s = { id: rid8(), t: "pen", c: colour, w: width, pts: [], sh: 1, _live: [c] };
    (doc.strokes[p] ||= []).push(s);
    const mv = ev => {
      if (ev.pointerId !== e.pointerId) return;
      let r = Shapes.dist(c, at(ev)); if (!ev.shiftKey) r = Math.round(r / (CM / 10)) * (CM / 10);
      s._live = r > 0.5 ? Shapes.points({ kind: "ellipse", cx: c[0], cy: c[1], rx: r, ry: r }) : [c];
      s._r = r; tag(p, at(ev), `r = ${fmt(r / CM * 10, 0)} mm (${cm(r)} cm)`); drawInk(p);
    };
    const end = ev => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); tag();
      const arr = doc.strokes[p];
      if (!s._r || s._r < 2) { arr.splice(arr.indexOf(s), 1); drawInk(p); return; }
      s.pts = s._live.map(q => toAnchor(p, q[0], q[1])); delete s._live; delete s._r;
      pushUndo({ t: "add", p, s }); emit(`s:${p}:${s.id}`); scheduleSave(); drawInk(p);
    };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
    return true;
  }

  // ---- line of best fit through plotted points (crosses, dots) in the selection ----
  function bestFit(kind) {
    if (!inkSel) return;
    const p = inkSel.p, list = selStrokes();
    // each plotted point is a group of strokes that touch (the two lines of a cross)
    const boxes = list.map(s => { const q = dispPts(p, s), xs = q.map(v => v[0]), ys = q.map(v => v[1]); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; });
    const marks = [];
    for (const b of boxes) {
      const into = marks.filter(m => b.x0 < m.x1 + 1.5 && b.x1 > m.x0 - 1.5 && b.y0 < m.y1 + 1.5 && b.y1 > m.y0 - 1.5);
      const m = into.reduce((a, c) => ({ x0: Math.min(a.x0, c.x0), x1: Math.max(a.x1, c.x1), y0: Math.min(a.y0, c.y0), y1: Math.max(a.y1, c.y1) }), b);
      for (const c of into) marks.splice(marks.indexOf(c), 1); marks.push(m);
    }
    const pts = marks.filter(m => m.x1 - m.x0 < 40 && m.y1 - m.y0 < 40).map(m => [(m.x0 + m.x1) / 2, (m.y0 + m.y1) / 2]);
    if (pts.length < (kind === "curve" ? 4 : 3)) { toast(`Select at least ${kind === "curve" ? 4 : 3} plotted points (crosses or dots) first.`, 3500); return; }
    const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]), n = pts.length;
    const sx = Math.max(...xs) - Math.min(...xs), sy = Math.max(...ys) - Math.min(...ys);
    let line;
    if (kind === "line") {
      // least squares; a nearly upright set is fitted the other way round
      const flip = sx < sy * 0.15, X = flip ? ys : xs, Y = flip ? xs : ys;
      const mx = X.reduce((a, b) => a + b) / n, my = Y.reduce((a, b) => a + b) / n;
      let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (X[i] - mx) * (Y[i] - my); sxx += (X[i] - mx) ** 2; }
      const m = sxx ? sxy / sxx : 0, c0 = my - m * mx, lo = Math.min(...X) - 0.06 * (Math.max(...X) - Math.min(...X)), hi = Math.max(...X) + 0.06 * (Math.max(...X) - Math.min(...X));
      line = flip ? [[m * lo + c0, lo], [m * hi + c0, hi]] : [[lo, m * lo + c0], [hi, m * hi + c0]];
    } else {
      // quadratic through the points (normal equations)
      const S = k => xs.reduce((a, x) => a + x ** k, 0), T = k => xs.reduce((a, x, i) => a + x ** k * ys[i], 0);
      const A = [[n, S(1), S(2)], [S(1), S(2), S(3)], [S(2), S(3), S(4)]], B = [T(0), T(1), T(2)];
      const det = M => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
      const D = det(A); if (!D) return;
      const co = [0, 1, 2].map(j => det(A.map((row, i) => row.map((v, k) => k === j ? B[i] : v))) / D);
      const lo = Math.min(...xs) - 0.04 * sx, hi = Math.max(...xs) + 0.04 * sx; line = [];
      for (let i = 0; i <= 48; i++) { const x = lo + (hi - lo) * i / 48; line.push([x, co[0] + co[1] * x + co[2] * x * x]); }
    }
    const s = { id: rid8(), t: "pen", c: colour, w: width, sh: 1, pts: line.map(q => toAnchor(p, q[0], q[1])) };
    (doc.strokes[p] ||= []).push(s); pushUndo({ t: "add", p, s }); emit(`s:${p}:${s.id}`); scheduleSave(); drawInk(p);
    toast(kind === "line" ? `Best-fit line through ${pts.length} points.` : `Best-fit curve through ${pts.length} points.`, 2500);
  }

  return { tag, shapeLabel, toggle, restore, place: () => { if (P && P.on) place(); }, edgeAt, edgePoints, edgeLabel, compassDown, bestFit, CM };
})();
$("#protBtn").onclick = () => Geo.toggle();
