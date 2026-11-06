// shapes.js — hold-to-snap: what shape a hand-drawn stroke was meant to be, and the perfect version of it.
// Shapes.recognise(points) → a shape or null:
//   { kind: "line", a, b } · { kind: "arrow", a, b } · { kind: "ellipse", cx, cy, rx, ry, rot } (rx === ry: a circle)
//   { kind: "poly", pts: [...corners] } (closed: triangle, square, rectangle, polygon)
// Shapes.points(shape) → the outline as points to draw (straight segments). Shapes.scale(shape, origin, k) → resized.
"use strict";
const Shapes = (() => {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const segDist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
  const pathLen = pts => { let L = 0; for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]); return L; };
  // Ramer–Douglas–Peucker: the corners of a polyline
  function rdp(pts, eps) {
    if (pts.length < 3) return pts.slice();
    let idx = 0, dm = 0;
    for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i], pts[0], pts[pts.length - 1]); if (d > dm) { dm = d; idx = i; } }
    if (dm <= eps) return [pts[0], pts[pts.length - 1]];
    const a = rdp(pts.slice(0, idx + 1), eps), b = rdp(pts.slice(idx), eps);
    return a.slice(0, -1).concat(b);
  }
  const angleAt = (a, b, c) => { const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]]; const d = Math.hypot(...v1) * Math.hypot(...v2); return d ? Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / d))) * 180 / Math.PI : 180; };
  // a line or near-horizontal / vertical edge is squared up when it's within a few degrees
  const snapAngle = (a, b, tol = 4) => {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI, L = dist(a, b);
    for (const t of [-180, -90, 0, 90, 180]) if (Math.abs(ang - t) < tol) { const r = t * Math.PI / 180; return [a[0] + Math.cos(r) * L, a[1] + Math.sin(r) * L]; }
    return b;
  };

  function recognise(raw) {
    const pts = raw.filter((p, i) => i === 0 || dist(p, raw[i - 1]) > 0.3);
    if (pts.length < 3) return null;
    const L = pathLen(pts); if (L < 6) return null;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), diag = Math.hypot(x1 - x0, y1 - y0);
    const first = pts[0], last = pts[pts.length - 1];
    const closed = dist(first, last) < Math.max(10, 0.22 * diag) && L > 1.8 * diag;

    if (!closed) {
      // a straight line: every point close to the line from start to end
      const dev = Math.max(...pts.map(p => segDist(p, first, last)));
      if (dev < Math.max(3, 0.07 * dist(first, last))) return { kind: "line", a: first, b: snapAngle(first, last) };
      // an arrow: a straight shaft to the tip, then a short head drawn back from the tip
      let ti = 0, td = 0; pts.forEach((p, i) => { const d = dist(p, first); if (d > td) { td = d; ti = i; } });
      const shaft = pts.slice(0, ti + 1), head = pts.slice(ti), tip = pts[ti];
      const sdev = Math.max(...shaft.map(p => segDist(p, first, tip)));
      const hl = pathLen(head);
      if (ti > 2 && sdev < Math.max(3.5, 0.08 * td) && hl > 0.08 * td && hl < 0.9 * td) {
        const back = head.some(p => dist(p, tip) > 3 && angleAt(first, tip, p) < 70);
        if (back) return { kind: "arrow", a: first, b: snapAngle(first, tip) };
      }
      return null;
    }

    // closed: corners (polygon) or smooth (ellipse)?
    const loop = pts.concat([first]);
    let corners = rdp(loop, Math.max(2.5, 0.045 * L)).slice(0, -1);
    // drop "corners" that are really straight on
    for (let k = 0; k < 3 && corners.length > 2; k++) corners = corners.filter((c, i) => angleAt(corners[(i - 1 + corners.length) % corners.length], c, corners[(i + 1) % corners.length]) < 160);
    // ellipse fit: points at the right normalised distance from the centre
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
    const eErr = rx > 1 && ry > 1 ? pts.reduce((s, p) => s + Math.abs(Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry) - 1), 0) / pts.length : 9;
    // polygon fit: how far points are from the corners' outline
    const ring = corners.concat([corners[0]]);
    const pErr = corners.length >= 3 ? pts.reduce((s, p) => { let m = Infinity; for (let i = 0; i < ring.length - 1; i++) m = Math.min(m, segDist(p, ring[i], ring[i + 1])); return s + m; }, 0) / pts.length / (diag || 1) : 9;
    const sharp = corners.length >= 3 && corners.length <= 8 && corners.filter((c, i) => angleAt(corners[(i - 1 + corners.length) % corners.length], c, corners[(i + 1) % corners.length]) < 135).length >= Math.min(3, corners.length);
    if (sharp && pErr < 0.035 && (eErr > 0.06 || corners.length <= 4)) return polygon(corners);
    if (eErr < 0.16) {
      if (Math.abs(rx - ry) < 0.12 * Math.max(rx, ry)) { const r = (rx + ry) / 2; return { kind: "ellipse", cx, cy, rx: r, ry: r, rot: 0 }; }
      return { kind: "ellipse", cx, cy, rx, ry, rot: 0 };
    }
    if (corners.length >= 3 && corners.length <= 8 && pErr < 0.06) return polygon(corners);
    return null;
  }

  // a polygon: four corners with right angles become a rectangle (a square when its sides match), squared to the page
  function polygon(c) {
    if (c.length === 4) {
      const angs = c.map((p, i) => angleAt(c[(i + 3) % 4], p, c[(i + 1) % 4]));
      if (angs.every(a => Math.abs(a - 90) < 18)) {
        // orientation from the longest side; level when nearly level
        let best = 0, bi = 0; for (let i = 0; i < 4; i++) { const d = dist(c[i], c[(i + 1) % 4]); if (d > best) { best = d; bi = i; } }
        let th = Math.atan2(c[(bi + 1) % 4][1] - c[bi][1], c[(bi + 1) % 4][0] - c[bi][0]);
        const deg = ((th * 180 / Math.PI) % 90 + 90) % 90; if (deg < 6) th -= deg * Math.PI / 180; else if (deg > 84) th += (90 - deg) * Math.PI / 180;
        const u = [Math.cos(th), Math.sin(th)], v = [-u[1], u[0]], mx = c.reduce((s, p) => s + p[0], 0) / 4, my = c.reduce((s, p) => s + p[1], 0) / 4;
        const pu = c.map(p => (p[0] - mx) * u[0] + (p[1] - my) * u[1]), pv = c.map(p => (p[0] - mx) * v[0] + (p[1] - my) * v[1]);
        let hw = (Math.max(...pu) - Math.min(...pu)) / 2, hh = (Math.max(...pv) - Math.min(...pv)) / 2;
        if (Math.abs(hw - hh) < 0.1 * Math.max(hw, hh)) hw = hh = (hw + hh) / 2;     // a square
        const P = (a, b) => [mx + u[0] * a + v[0] * b, my + u[1] * a + v[1] * b];
        return { kind: "poly", pts: [P(-hw, -hh), P(hw, -hh), P(hw, hh), P(-hw, hh)], rect: true };
      }
    }
    // straighten near-level / near-upright sides of triangles and other polygons
    const out = c.map(p => p.slice());
    for (let i = 0; i < out.length; i++) { const a = out[i], b = out[(i + 1) % out.length]; if (Math.abs(a[1] - b[1]) < 0.07 * Math.abs(a[0] - b[0])) { const y = (a[1] + b[1]) / 2; a[1] = b[1] = y; } else if (Math.abs(a[0] - b[0]) < 0.07 * Math.abs(a[1] - b[1])) { const x = (a[0] + b[0]) / 2; a[0] = b[0] = x; } }
    return { kind: "poly", pts: out };
  }

  // the outline to draw: straight segments (an arrow's head is part of the same line)
  function points(s, w = 1.3) {
    if (s.kind === "line") return [s.a, s.b];
    if (s.kind === "arrow") {
      const L = dist(s.a, s.b), hl = Math.min(Math.max(6, w * 5), L * 0.35), ang = Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]), sp = 0.45;
      const h1 = [s.b[0] - hl * Math.cos(ang - sp), s.b[1] - hl * Math.sin(ang - sp)], h2 = [s.b[0] - hl * Math.cos(ang + sp), s.b[1] - hl * Math.sin(ang + sp)];
      return [s.a, s.b, h1, s.b, h2];
    }
    if (s.kind === "ellipse") {
      const n = Math.max(36, Math.min(160, Math.round((s.rx + s.ry) * 1.2))), out = [];
      for (let i = 0; i <= n; i++) { const t = i / n * Math.PI * 2; out.push([s.cx + s.rx * Math.cos(t), s.cy + s.ry * Math.sin(t)]); }
      return out;
    }
    return s.pts.concat([s.pts[0]]);
  }
  // resized evenly about a point (a line or arrow keeps its start and its end follows instead: see app.js)
  function scale(s, o, k) {
    const f = p => [o[0] + (p[0] - o[0]) * k, o[1] + (p[1] - o[1]) * k];
    if (s.kind === "line" || s.kind === "arrow") return { ...s, a: f(s.a), b: f(s.b) };
    if (s.kind === "ellipse") { const c = f([s.cx, s.cy]); return { ...s, cx: c[0], cy: c[1], rx: s.rx * k, ry: s.ry * k }; }
    return { ...s, pts: s.pts.map(f) };
  }
  const centre = s => s.kind === "ellipse" ? [s.cx, s.cy] : s.kind === "poly" ? [s.pts.reduce((t, p) => t + p[0], 0) / s.pts.length, s.pts.reduce((t, p) => t + p[1], 0) / s.pts.length] : s.a;
  const name = s => s.kind === "line" ? "Line" : s.kind === "arrow" ? "Arrow" : s.kind === "ellipse" ? (s.rx === s.ry ? "Circle" : "Ellipse") : s.rect ? (Math.abs(dist(s.pts[0], s.pts[1]) - dist(s.pts[1], s.pts[2])) < 0.5 ? "Square" : "Rectangle") : s.pts.length === 3 ? "Triangle" : s.pts.length + "-sided shape";
  return { recognise, points, scale, centre, name, dist };
})();
if (typeof module !== "undefined") module.exports = Shapes;
