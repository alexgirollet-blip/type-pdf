// Question markers: where each question number and part (1, 2, (a), (b), (i), (ii), AQA's 0 6 . 1 …) is printed.
// Each marker is a small box over the printed number; the full label (e.g. "4(b)(ii)") comes from walking the
// markers in reading order. They are stored per page as P.qs and can be edited in the Boxes tool.
//
//   marker: { id, lvl: 0 number | 1 part (letter, or AQA's .1) | 2 sub-part (roman), tok: "4" | "b" | "1" | "ii", x0, y0, x1, y1 }
"use strict";
const Questions = (() => {
  const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"];
  const LETTERS = "abcdefghijklmnopqrstuvwxyz";

  // text items ({s, x, y = baseline, x1, h?}) → lines, each a list of characters with their x positions
  function lines(items, W, H) {
    const its = items.filter(it => it.s && it.s.trim() && it.y > H * 0.045 && it.y < H * 0.93).sort((a, b) => a.y - b.y || a.x - b.x);
    const out = [];
    for (const it of its) {
      const h = it.h || 11;
      let L = out.find(l => Math.abs(l.y - it.y) < Math.max(2, Math.min(h, l.h) * 0.3));
      if (!L) { L = { y: it.y, h, items: [] }; out.push(L); }
      L.items.push(it); L.h = Math.max(L.h, h);
    }
    for (const L of out) {
      L.items.sort((a, b) => a.x - b.x);
      const chars = [];
      let prevEnd = null;
      for (const it of L.items) {
        const s = it.s, n = s.length, w = Math.max(0, it.x1 - it.x) / Math.max(1, n);
        if (prevEnd !== null && it.x - prevEnd > L.h * 0.22 && chars.length && chars[chars.length - 1].c !== " ") chars.push({ c: " ", x0: prevEnd, x1: it.x });
        for (let k = 0; k < n; k++) chars.push({ c: s[k], x0: it.x + w * k, x1: it.x + w * (k + 1) });
        prevEnd = Math.max(prevEnd ?? -1e9, it.x1);
      }
      // drop leading spaces
      while (chars.length && chars[0].c.trim() === "") chars.shift();
      L.chars = chars; L.text = chars.map(c => c.c).join("");
      L.x = chars.length ? chars[0].x0 : 0;
    }
    return out.filter(L => L.chars.length).sort((a, b) => a.y - b.y);
  }

  const romanIdx = t => ROMAN.indexOf(t);
  const letterIdx = t => LETTERS.indexOf(t);

  // read the numbers at the start of a line. Returns tokens [{lvl, tok, a, b}] (a, b = character range)
  function leading(text) {
    const toks = []; let i = 0;
    const skip = () => { while (i < text.length && /\s/.test(text[i])) i++; };
    // a question number: "4", "Q4", "Question 4", "4.", AQA's boxed "0 4" (and its part ". 1")
    const pre = text.match(/^(?:Q(?:uestion)?\.?\s*)?/i)[0].length, D = c => c >= "0" && c <= "9";
    if (D(text[pre] || "")) {
      let j = pre + 1, two = false;
      if (D(text[j] || "")) { j++; two = true; }
      else if (text[j] === " " && D(text[j + 1] || "") && !D(text[j + 2] || "") && (text[pre] === "0" || text[pre] === "1")) { j += 2; two = true; }   // AQA's boxed digits
      if (!D(text[j] || "") && (j >= text.length || /[\s.)]/.test(text[j])) && !(text[j] === "." && D(text[j + 1] || "") && !two) && !/^\s*(hours?|minutes?|mins?|marks?|seconds?|cm|mm|km|kg|g|m|s|%|°)\b/i.test(text.slice(j).replace(/^\./, ""))) {
        const num = String(+text.slice(pre, j).replace(/\s/g, ""));
        if (+num > 0) {
          toks.push({ lvl: 0, tok: num, a: pre, b: j }); i = j;
          const pm = two && text.slice(j).match(/^\s*\.\s*(\d{1,2})(?!\d)/);         // AQA's part: 04.2
          if (pm) { const b2 = j + pm[0].length; toks.push({ lvl: 1, tok: String(+pm[1]), a: b2 - pm[1].length, b: b2, num: true }); i = b2; }
          else if (text[i] === ".") i++;
        }
      }
    }
    // then letters and romans in brackets: "(a)", "(ii)", "a)", "(b)(i)"
    for (let guard = 0; guard < 3; guard++) {
      skip();
      const rest = text.slice(i);
      const p = rest.match(/^\(\s?([a-z]{1,4})\s?\)/) || rest.match(/^([a-z]{1,4})\)(?=\s|$)/);
      if (!p) break;
      const t = p[1];
      if (!(t.length === 1 || /^[ivx]+$/.test(t))) break;
      toks.push({ lvl: -1, tok: t, a: i, b: i + p[0].length });
      i += p[0].length;
    }
    return toks;
  }

  // every marker on every page. pages: [{w, h, items}]
  function detect(pages) {
    // 1. the numbers at the start of every line
    const rows = [];
    pages.forEach((P, p) => {
      if (!P || !P.items) return;
      const W = P.w || 595, H = P.h || 842;
      for (const L of lines(P.items, W, H)) {
        if (L.x > W * 0.42) continue;
        const toks = leading(L.text);
        if (toks.length) rows.push({ p, L, W, toks });
      }
    });
    // 2. which of the line-start numbers are question numbers: the best run that counts up (1, 2, 3 …, allowing the
    // odd one missed), preferring numbers in the same column as the others. Page numbers, table data, "1 hour" and
    // barcodes drop out because they don't fit the run.
    const cand = rows.filter(r => r.toks[0].lvl === 0 && r.L.chars[r.toks[0].a].x0 <= r.W * 0.2);
    const xs = cand.map(r => Math.round(r.L.chars[r.toks[0].a].x0 / 4)), freq = {};
    for (const x of xs) freq[x] = (freq[x] || 0) + 1;
    const modeX = cand.length ? +Object.entries(freq).sort((m, n) => n[1] - m[1])[0][0] * 4 : 0;
    const off = r => Math.abs(r.L.chars[r.toks[0].a].x0 - modeX) > 8 ? 0.5 : 0;
    const best = [], prev = [];
    cand.forEach((r, k) => {
      const n = +r.toks[0].tok;
      best[k] = (n === 1 ? 1 : n <= 3 ? 0.6 : 0.3) - off(r); prev[k] = -1;
      for (let j = 0; j < k; j++) {
        const d = n - +cand[j].toks[0].tok; if (d < 1 || d > 3) continue;
        const v = best[j] + (d === 1 ? 1 : 0.4) - off(r);
        if (v > best[k]) { best[k] = v; prev[k] = j; }
      }
    });
    const chosen = new Set();
    let k = best.length ? best.indexOf(Math.max(...best)) : -1;
    while (k >= 0) { chosen.add(cand[k]); k = prev[k]; }
    // 3. walk the lines in order, keeping track of the question, part and sub-part
    const all = pages.map(() => []);
    let q = 0, a = "", aNum = false, r = "";
    for (const row of rows) {
      const { p, L, W, toks } = row;
      let start = 0;
      if (toks[0].lvl === 0) {
        if (chosen.has(row)) { q = +toks[0].tok; a = ""; aNum = false; r = ""; }
        else if (+toks[0].tok === q && toks.length > 1) start = 1;     // the number repeated before a later part
        else continue;
      }
      if (!q) continue;
      for (let i = start; i < toks.length; i++) {
        const t = toks[i]; let lvl = t.lvl, ok = false;
        const x0 = L.chars[t.a].x0;
        if (lvl === 0) ok = i === 0;
        else if (lvl === 1 && t.num) { ok = true; a = t.tok; aNum = true; r = ""; }
        else {
          // a bracketed letter or roman: work out which from what came before
          const tok = t.tok, li = letterIdx(tok), ri = romanIdx(tok);
          const nextRoman = ri >= 0 && (r ? ri === romanIdx(r) + 1 : ri === 0);
          const nextLetter = tok.length === 1 && li >= 0 && (a && !aNum ? li > letterIdx(a) && li <= letterIdx(a) + 2 : li <= 1);
          if (x0 > W * 0.42) break;
          if (nextRoman && a && !(tok === "i" && a === "h" && !r)) { lvl = 2; ok = true; r = tok; }
          else if (nextLetter) { lvl = 1; ok = true; a = tok; aNum = false; r = ""; }
          else if (ri >= 0 && r && ri > romanIdx(r) && ri <= romanIdx(r) + 2) { lvl = 2; ok = true; r = tok; }
        }
        if (!ok) break;
        const c0 = L.chars[t.a], c1 = L.chars[Math.max(t.a, t.b - 1)];
        all[p].push({ id: "q" + p + "_" + all[p].length + "_" + Math.random().toString(36).slice(2, 6), lvl, tok: lvl === 0 ? String(q) : t.tok, x0: +(c0.x0 - 1.5).toFixed(1), y0: +(L.y - L.h * 0.85).toFixed(1), x1: +(c1.x1 + 1.5).toFixed(1), y1: +(L.y + L.h * 0.25).toFixed(1), ...(t.num ? { num: true } : {}) });
      }
    }
    return all;
  }

  // labels for every marker in reading order: [{p, y, x, label, q, m}]
  function index(pages) {
    const out = []; let q = "", a = "", aNum = false, r = "";
    pages.forEach((P, p) => {
      const qs = ((P && P.qs) || []).slice().sort((m, n) => m.y0 - n.y0 || m.x0 - n.x0);
      for (const m of qs) {
        if (m.lvl === 0) { q = m.tok; a = ""; aNum = false; r = ""; }
        else if (m.lvl === 1) { a = m.tok; aNum = !!m.num || /^\d+$/.test(m.tok); r = ""; }
        else r = m.tok;
        if (!q) continue;
        const label = q + (a ? (aNum ? "." + a : `(${a})`) : "") + (r ? `(${r})` : "");
        out.push({ p, y: m.y0, x: m.x0, label, q, m });
      }
    });
    return out;
  }

  // a typed label → {lvl, tok, num}: "3", "06", "b", "(b)", "ii", "4(b)(ii)" (the last part counts), "6.2"
  function parseTok(s) {
    s = String(s || "").trim().toLowerCase().replace(/^q(uestion)?\s*/, "");
    let m;
    if ((m = s.match(/^(?:\d+)?\s*\.\s*(\d+)$/))) return { lvl: 1, tok: String(+m[1]), num: true };
    if ((m = s.match(/^(\d+)$/))) return +m[1] > 0 ? { lvl: 0, tok: String(+m[1]) } : null;
    const parts = s.match(/[a-z]+/g); if (!parts) return null;
    const t = parts[parts.length - 1];
    if (/^[ivx]+$/.test(t) && romanIdx(t) >= 0 && (t.length > 1 || parts.length > 1 || t !== "i" || /^\(?i\)?$/.test(s))) return { lvl: 2, tok: t };
    if (t.length === 1) return { lvl: 1, tok: t };
    return null;
  }

  return { detect, index, parseTok, lines, leading };
})();
if (typeof module !== "undefined") module.exports = Questions;
