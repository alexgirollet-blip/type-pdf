// find.js — Find (⌘/Ctrl+F): search the printed words of every page and your typed answers, across the whole paper.
// A phrase is matched across line breaks and spacing; when a phrase isn't found word for word, lines near each other
// that have all its words are found instead. Matches are highlighted on the pages; Enter / ↓ goes to the next one.
"use strict";
const Find = window.Find = (() => {
  let hits = [], at = -1, q = "", fuzzy = false, went = false, cacheFor = null, cache = [];
  const MAX = 500;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const html = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // a page's printed text as lines, each with where every character sits (so a match can be highlighted exactly)
  function lines(p) {
    if (cacheFor !== doc) { cacheFor = doc; cache = []; }
    const P = doc.pages[p]; if (!P) return [];
    if (cache[p] && cache[p].items === P.items) return cache[p].lines;
    const its = (P.items || []).filter(it => it.s && it.s.trim()).slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const out = [];
    for (const it of its) {
      const h = it.h || 10, L = out[out.length - 1];
      if (L && Math.abs(L.y - it.y) < Math.max(2, h * 0.35)) L.its.push(it); else out.push({ y: it.y, h, its: [it] });
    }
    for (const L of out) {
      L.its.sort((a, b) => a.x - b.x);
      let s = ""; const map = [];
      L.its.forEach((it, i) => {
        if (i && it.x - L.its[i - 1].x1 > 1 && !/\s$/.test(s)) { s += " "; map.push(null); }
        const t = it.s, n = t.length;
        for (let k = 0; k < n; k++) { s += t[k]; map.push({ it, k, n }); }
      });
      L.s = s; L.map = map;
    }
    cache[p] = { items: P.items, lines: out };
    return out;
  }
  // the rectangle (page points, printed coordinates) of characters a..b of a line
  function span(L, a, b) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = a; i < b; i++) {
      const m = L.map[i]; if (!m) continue;
      const w = (m.it.x1 - m.it.x) / Math.max(1, m.n), h = m.it.h || L.h;
      x0 = Math.min(x0, m.it.x + w * m.k); x1 = Math.max(x1, m.it.x + w * (m.k + 1));
      y0 = Math.min(y0, m.it.y - h * 0.85); y1 = Math.max(y1, m.it.y + h * 0.22);
    }
    return x1 > x0 ? { x0, x1, y0, y1 } : null;
  }
  function snippet(s, a, b) { const pre = s.slice(Math.max(0, a - 40), a), post = s.slice(b, b + 50); return (a > 40 ? "…" : "") + html(pre) + "<b>" + html(s.slice(a, b)) + "</b>" + html(post) + (b + 50 < s.length ? "…" : ""); }

  function search(query) {
    const words = query.trim().split(/\s+/).filter(Boolean); if (!words.length) return [];
    const re = new RegExp(words.map(esc).join("[\\s\\-–]*"), "gi"), out = [];
    // printed text: each page's lines joined, so a phrase can run on to the next line
    for (let p = 0; p < doc.pages.length && out.length < MAX; p++) {
      const Ls = lines(p); if (!Ls.length) continue;
      let all = ""; const at = [];
      Ls.forEach((L, li) => { if (li) { all += " "; at.push(null); } for (let k = 0; k < L.s.length; k++) { all += L.s[k]; at.push([li, k]); } });
      re.lastIndex = 0; let m;
      while ((m = re.exec(all)) && out.length < MAX) {
        if (!m[0].length) { re.lastIndex++; continue; }
        const rects = [], a = m.index, b = a + m[0].length;
        let cur = null;
        for (let i = a; i < b; i++) { const w = at[i]; if (!w) continue; if (!cur || cur.li !== w[0]) { cur = { li: w[0], a: w[1], b: w[1] + 1 }; rects.push(cur); } else cur.b = w[1] + 1; }
        const R = rects.map(c => span(Ls[c.li], c.a, c.b)).filter(Boolean); if (!R.length) continue;
        const L0 = Ls[rects[0].li];
        out.push({ p, rects: R, y: R[0].y0, html: snippet(L0.s, rects[0].a, rects[0].li === rects[rects.length - 1].li ? rects[0].b : L0.s.length) });
      }
    }
    // your typed answers
    doc.pages.forEach((P, p) => (P.regions || []).forEach(r => {
      const t = doc.text[r.id]; if (!t || r.kind === "choice") return;
      re.lastIndex = 0; let m;
      while ((m = re.exec(t)) && out.length < MAX) { if (!m[0].length) { re.lastIndex++; continue; } out.push({ p, r, a: m.index, b: m.index + m[0].length, y: r.y0, typed: true, html: snippet(t, m.index, m.index + m[0].length) }); }
    }));
    return out;
  }
  // nothing word for word: lines close together (a sentence wrapping over up to 3 lines) that have every word
  function searchLoose(query) {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1); if (words.length < 2) return [];
    const res = words.map(w => new RegExp("\\b" + esc(w), "i")), out = [];
    for (let p = 0; p < doc.pages.length && out.length < MAX; p++) {
      const Ls = lines(p);
      for (let i = 0; i < Ls.length && out.length < MAX; i++) {
        for (let n = 1; n <= 3 && i + n <= Ls.length; n++) {
          const win = Ls.slice(i, i + n), txt = win.map(L => L.s).join(" ");
          if (!res.every(r => r.test(txt))) continue;
          if (n > 1 && res.every(r => r.test(win.slice(1).map(L => L.s).join(" ")))) break;      // found from a later line instead
          const R = win.map(L => span(L, 0, L.s.length)).filter(Boolean);
          let h = html(txt); for (const w of words) h = h.replace(new RegExp("\\b(" + esc(w) + ")", "ig"), "<b>$1</b>");
          out.push({ p, rects: R, y: R[0].y0, html: h.length > 400 ? h.slice(0, 400) + "…" : h }); i += n - 1; break;
        }
      }
    }
    return out;
  }

  // ---- highlights on the pages ----
  function draw(p) {
    const v = views[p]; if (!v) return;
    v.el.querySelectorAll(".findhit").forEach(e => e.remove());
    if (!q || $("#findPop").hidden) return;
    hits.forEach((h, i) => {
      if (h.p !== p) return;
      const R = h.typed ? [regionRect(p, h.r)] : h.rects.map(r => ({ x0: r.x0, x1: r.x1, y0: disp(p, r.y0), y1: disp(p, r.y1) }));
      for (const r of R) {
        const d = document.createElement("div"); d.className = "findhit" + (i === at ? " cur" : "") + (h.typed ? " typed" : "");
        Object.assign(d.style, { left: (r.x0 - 1) * zoom + "px", top: (r.y0 - 1) * zoom + "px", width: (r.x1 - r.x0 + 2) * zoom + "px", height: (r.y1 - r.y0 + 2) * zoom + "px" });
        v.el.appendChild(d);
      }
    });
  }
  function drawAll() { const pages = new Set([...hits.map(h => h.p), ...views.map((v, p) => v.el.querySelector(".findhit") ? p : -1)]); pages.forEach(p => { if (p >= 0) draw(p); }); }

  function where(h) { const lab = labelAt(labelIndex(), h.p, h.y + 6); return `p. ${h.p + 1}` + (lab !== "?" ? ` · ${qName(lab)}` : "") + (h.typed ? " · your answer" : ""); }
  function list() {
    const L = $("#findList"); L.innerHTML = "";
    if (!q) { $("#findCount").textContent = ""; return; }
    $("#findCount").textContent = hits.length ? `${at + 1} of ${hits.length}${hits.length >= MAX ? "+" : ""}` : "None";
    if (fuzzy && hits.length) { const n = document.createElement("p"); n.className = "note"; n.textContent = "Not found word for word. These have all the words close together:"; L.appendChild(n); }
    if (!hits.length) { const n = document.createElement("p"); n.className = "note"; n.textContent = doc.pages.some(P => P.hasText) ? "Not found in the printed text or your answers." : "This paper is images only, so its printed words can't be searched (your typed answers can)."; L.appendChild(n); return; }
    hits.slice(0, 200).forEach((h, i) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "fhit" + (i === at ? " on" : "");
      b.innerHTML = `<small>${html(where(h))}</small><span>${h.html}</span>`;
      b.onclick = () => go(i);
      L.appendChild(b);
    });
  }
  function go(i, focus) {
    if (!hits.length) return;
    at = (i + hits.length) % hits.length;
    const h = hits[at];
    scrollToPoint(h.p, h.y, 0.3);
    if (h.typed && focus !== false && !matchMedia("(pointer: coarse)").matches) {
      const ta = elFor(h.r); if (ta) { ta.focus({ preventScroll: true }); try { ta.setSelectionRange(h.a, h.b); } catch (e) {} }
    }
    drawAll(); list();
    const on = $("#findList .fhit.on"); if (on) on.scrollIntoView({ block: "nearest" });
  }
  let t = 0;
  function run(now) {
    clearTimeout(t);
    if (!now) { t = setTimeout(() => run(true), 180); return; }
    q = $("#findIn").value.trim();
    hits = q ? search(q) : []; fuzzy = false;
    if (q && !hits.length) { hits = searchLoose(q); fuzzy = hits.length > 0; }
    hits.sort((a, b) => a.p - b.p || a.y - b.y);
    // start from the first match at or after where you are
    const cur = currentPage(); at = hits.length ? Math.max(0, hits.findIndex(h => h.p >= cur)) : -1; went = false;
    drawAll(); list();
  }
  function open(text) {
    if (!doc) return;
    hideJump && hideJump();
    const pop = $("#findPop"); pop.hidden = false;
    const r = $("#findBtn").getBoundingClientRect(), W = Math.min(380, window.innerWidth - 16);
    pop.style.width = W + "px"; pop.style.left = clamp(r.right - W, 8, window.innerWidth - W - 8) + "px"; pop.style.top = r.bottom + 6 + "px";
    const inp = $("#findIn"); if (text) inp.value = text;
    inp.focus(); inp.select();
    if (inp.value.trim()) run(true);
  }
  function close() { $("#findPop").hidden = true; drawAll(); }
  function wire() {
    $("#findBtn").onclick = () => $("#findPop").hidden ? open() : close();
    $("#findIn").addEventListener("input", () => run());
    $("#findIn").addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault(); if ($("#findIn").value.trim() !== q) run(true);
        go(went ? at + (e.shiftKey ? -1 : 1) : at, false); went = true;           // the first Enter shows the match nearest you
      }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    });
    $("#findNext").onclick = () => { go(went ? at + 1 : at); went = true; };
    $("#findPrev").onclick = () => { go(at - 1); went = true; };
    $("#findClose").onclick = close;
    document.addEventListener("keydown", e => {
      if (!doc || $("#editor").hidden) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") { e.preventDefault(); const s = String(window.getSelection() || "").trim(); open(s.length < 80 ? s : ""); }
      else if (e.key === "F3" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g" && e.shiftKey === false && !$("#findPop").hidden)) { if (!$("#findPop").hidden && hits.length) { e.preventDefault(); e.stopImmediatePropagation(); go(at + 1); } }
    }, true);
  }
  wire();
  return { open, close, run, draw, search: q2 => { const h = search(q2); return h.length ? h : searchLoose(q2); }, lines, get hits() { return hits; }, get at() { return at; } };
})();
