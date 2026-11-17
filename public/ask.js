// ask.js — ✨ Ask: questions while you work, answered by the same free AIs as Mark with AI (src/ai.js, mode "help").
// Each question goes with: where you are (the question you're on: its printed text, what you've written, and a
// picture of it), an index of the whole paper (each question's page and opening words), and the lines of the paper
// that have the words you asked about, so "which page is the electric fields question on?" can be answered.
// Page numbers in replies are links that take you there.
"use strict";
const Ask = window.Ask = (() => {
  const chats = new Map();      // paper id → [{ role, text, by }]
  const html = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const STOP = new Set("a an the and or of to in on at for is are was were be by it its this that which what where when who how why with from as into do does did i me my you your can could would should will page pages question questions part about find show tell".split(" "));

  const lineText = p => (window.Find ? Find.lines(p) : []).map(L => ({ y: L.y, s: L.s }));
  // where you are: the answer you're in, or a third of the way down the screen
  function here() {
    const a = document.activeElement;
    if (a && a.classList && a.classList.contains("ans") && a.dataset.rid) { const r = findRegion(a.dataset.rid), p = r ? pageOfRegion(r) : -1; if (p >= 0) return { p, y: r.y0 + 2 }; }
    const host = $("#pages"), p = currentPage(), v = views[p];
    const d = (host.scrollTop + host.clientHeight / 3 - pageTop(p)) / zoom;
    return { p, y: clamp(src(p, d), 0, doc.pages[p].h), v };
  }
  // the question at a spot: from its number to the next question's (it may run over pages)
  function questionAt(p, y) {
    const idx = labelIndex();
    const before = (e) => e.p < p || (e.p === p && e.y <= y + 4);
    let i = -1; idx.forEach((e, k) => { if (before(e)) i = k; });
    if (i < 0) return { label: "", p0: p, y0: 0, p1: p, y1: doc.pages[p].h };
    // from the whole question's number (not just this part), to the next whole question
    const q = idx[i].q; let s = i; while (s > 0 && idx[s - 1].q === q) s--;
    let e = i + 1; while (e < idx.length && idx[e].q === q) e++;
    const end = idx[e];
    // a question runs to the next one, but never more than 3 pages from where you are
    const p0 = Math.max(idx[s].p, p - 2), p1 = Math.min(end ? end.p : doc.pages.length - 1, p + 2);
    return { label: idx[i].label, q, p0, y0: p0 === idx[s].p ? idx[s].y - 4 : 0, p1, y1: end && p1 === end.p ? end.y - 2 : Infinity };
  }
  function printedBetween(Q, max = 5000) {
    let out = "";
    for (let p = Q.p0; p <= Q.p1 && p < doc.pages.length && out.length < max; p++) {
      for (const L of lineText(p)) { if ((p === Q.p0 && L.y < Q.y0) || (p === Q.p1 && L.y > Q.y1)) continue; out += L.s + "\n"; }
      if (p < Q.p1) out += `[page ${p + 2}]\n`;
    }
    return out.slice(0, max);
  }
  function answersBetween(Q) {
    const out = [], idx = labelIndex();
    for (let p = Q.p0; p <= Q.p1 && p < doc.pages.length; p++) for (const r of doc.pages[p].regions || []) {
      const yy = r.y0; if ((p === Q.p0 && yy < Q.y0) || (p === Q.p1 && yy > Q.y1)) continue;
      const lab = labelAt(idx, p, yy + 6), t = doc.text[r.id];
      if (r.kind === "choice") { if (t) out.push(`${qName(lab)}: chose ${r.opt || r.L || "a box"}`); }
      else if (t && t.trim()) out.push(`${qName(lab)}: ${t.trim()}`);
    }
    const drawn = []; for (let p = Q.p0; p <= Q.p1 && p < doc.pages.length; p++) if ((doc.strokes[p] || []).length) drawn.push(p + 1);
    return out.join("\n").slice(0, 6000) + (drawn.length ? `\n(They have also written or drawn by hand on page ${drawn.join(", ")}: see the picture.)` : "");
  }
  // the whole paper in brief: each question's page and its opening words
  function paperIndex(limit = 26000) {
    const idx = labelIndex(), rows = [];
    if (idx.length) {
      const tops = idx.filter((e, i) => i === 0 || idx[i - 1].q !== e.q);
      for (let k = 0; k < tops.length; k++) {
        const e = tops[k], L = lineText(e.p).filter(l => l.y >= e.y - 4);
        rows.push({ head: `${qName(e.q)} (page ${e.p + 1})`, words: L.map(l => l.s).join(" ").replace(/\s+/g, " ") });
      }
    } else {
      doc.pages.forEach((P, p) => rows.push({ head: `Page ${p + 1}`, words: lineText(p).map(l => l.s).join(" ").replace(/\s+/g, " ") }));
    }
    let n = 160; const build = () => rows.map(r => `${r.head}: ${r.words.slice(0, n)}`).join("\n");
    let s = build(); while (s.length > limit && n > 30) { n = Math.floor(n * 0.7); s = build(); }
    return s.slice(0, limit);
  }
  // the lines of the paper that have the words they asked about, best pages first
  function searchFor(text) {
    if (!window.Find) return "";
    const words = (text.toLowerCase().match(/[a-z0-9][a-z0-9'’-]{2,}/g) || []).filter(w => !STOP.has(w));
    if (!words.length) return "";
    const phrases = [...words.slice(0, -1).map((w, i) => w + " " + words[i + 1]), ...words];
    const byPage = new Map();
    for (const ph of phrases.slice(0, 12)) for (const h of Find.search(ph).filter(h => !h.typed).slice(0, 80)) {
      const e = byPage.get(h.p) || { score: 0, hits: new Set(), lines: new Set() }; byPage.set(h.p, e);
      if (!e.hits.has(ph)) { e.hits.add(ph); e.score += ph.includes(" ") ? 3 : 1; }
      const plain = h.html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
      if (e.lines.size < 3) e.lines.add(`${qName(labelAt(labelIndex(), h.p, h.y + 6))}: ${plain}`);
    }
    const best = [...byPage.entries()].sort((a, b) => b[1].score - a[1].score || a[0] - b[0]).slice(0, 10);
    return best.map(([p, e]) => `page ${p + 1}: ${[...e.lines].join(" | ")}`).join("\n").slice(0, 6000);
  }
  // a picture of the question you're on (as printed, with your handwriting), at most two pages of it
  async function picture(Q) {
    const parts = [], scale = 1.4;
    for (let p = Q.p0; p <= Math.min(Q.p1, Q.p0 + 1) && p < doc.pages.length; p++) {
      const P = doc.pages[p], a = p === Q.p0 ? Math.max(0, Q.y0 - 6) : 0, b = p === Q.p1 ? Math.min(P.h, Q.y1 + 4) : P.h;
      if (b - a < 20) continue;
      const ras = await pageRaster(p, scale, true);
      parts.push({ ras, a, b, w: P.w });
    }
    if (!parts.length) return null;
    const W = Math.max(...parts.map(x => x.w)), H = parts.reduce((s, x) => s + x.b - x.a, 0), k = Math.min(1, 2400 / (H * scale));
    const c = document.createElement("canvas"); c.width = Math.round(W * scale * k); c.height = Math.round(H * scale * k);
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    let y = 0; for (const x of parts) { g.drawImage(x.ras, 0, x.a * scale, x.ras.width, (x.b - x.a) * scale, 0, y * scale * k, x.ras.width * k, (x.b - x.a) * scale * k); y += x.b - x.a; x.ras.width = 0; }
    const data = c.toDataURL("image/jpeg", 0.6).split(",")[1]; c.width = 0;
    return data;
  }
  function context(text) {
    const H = here(), Q = questionAt(H.p, H.y);
    return [
      `Paper: ${doc.name} (${doc.pages.length} pages)`,
      `WHERE THE STUDENT IS NOW: page ${H.p + 1}${Q.label ? ", " + qName(Q.label) : ""}.`,
      Q.label ? `The question they're on (as printed):\n${printedBetween(Q)}` : `What's printed around there:\n${printedBetween({ p0: H.p, y0: H.y - 150, p1: H.p, y1: H.y + 300 })}`,
      `What they've written for it so far:\n${answersBetween(Q.label ? Q : { p0: H.p, y0: 0, p1: H.p, y1: Infinity }) || "(nothing yet)"}`,
      `THE WHOLE PAPER (each question, its page, and its opening words):\n${paperIndex()}`,
      (() => { const s = searchFor(text); return s ? `WHERE THE WORDS OF THEIR MESSAGE APPEAR IN THE PAPER (best matches first):\n${s}` : ""; })(),
    ].filter(Boolean).join("\n\n");
  }

  // ---- the panel ----
  function render() {
    const box = $("#askLog"); if (!box || !doc) return;
    const list = chats.get(doc.id) || [];
    box.innerHTML = list.length ? list.map(m => `<div class="mkmsg ${m.role}">${link(html(m.text)).replace(/\n/g, "<br>")}${m.by ? `<small>${html(m.by)}</small>` : ""}</div>`).join("")
      : `<p class="note">Ask while you work: "give me a hint for this one", "is my answer right so far?", "what does 'specific heat capacity' mean?", "which page is the electric fields question on?". The question you're on (and a picture of it) goes with what you ask.</p>`;
    box.scrollTop = box.scrollHeight;
  }
  // "page 12" / "pages 12 and 13" → links to those pages
  const link = s => s.replace(/\b(pages?|p\.)\s*(\d{1,4})((?:\s*(?:,|and|&amp;|–|-|to)\s*\d{1,4})*)/gi, (all, w, n, rest) => {
    const go = x => (+x >= 1 && +x <= doc.pages.length) ? `<button type="button" class="pglink" data-p="${+x}">${x}</button>` : x;
    return `${w} ${go(n)}${rest.replace(/\d{1,4}/g, go)}`;
  });
  async function send(text) {
    text = text.trim(); if (!text || !doc) return;
    if (!(window.Sync && Sync.user)) { toast("Sign in to ask the AI.", 4000); return; }
    const list = chats.get(doc.id) || []; chats.set(doc.id, list);
    let ctx, image = null;
    try {
      ctx = context(text);
      if ($("#askPic").checked) { const H = here(), Q = questionAt(H.p, H.y); image = await picture(Q.label ? Q : { p0: H.p, y0: Math.max(0, H.y - 150), p1: H.p, y1: H.y + 350 }).catch(() => null); }
    } catch (e) { console.warn(e); ctx = ctx || `Paper: ${doc.name}`; }
    list.push({ role: "user", text }); const pending = { role: "assistant", text: "…" }; list.push(pending); render();
    try {
      const r = await Sync.api("/api/ai/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "help", context: ctx, image, messages: list.filter(m => m !== pending).map(m => ({ role: m.role, text: m.text })) }) });
      const j = await r.json().catch(() => ({}));
      pending.text = j.text || j.error || (r.status === 429 ? "That's today's limit. Try again tomorrow." : "No answer just now."); pending.by = j.provider || "";
    } catch (e) { pending.text = e.message || "No answer just now."; }
    render();
  }
  function open() {
    if (!doc) return;
    const pop = $("#askPop"); pop.hidden = false;
    const r = $("#askBtn").getBoundingClientRect(), W = Math.min(400, window.innerWidth - 16);
    pop.style.width = W + "px"; pop.style.left = clamp(r.right - W, 8, window.innerWidth - W - 8) + "px"; pop.style.top = r.bottom + 6 + "px";
    render();
    if (!matchMedia("(pointer: coarse)").matches) $("#askIn").focus();
  }
  function close() { $("#askPop").hidden = true; }
  $("#askBtn").onclick = () => $("#askPop").hidden ? open() : close();
  $("#askClose").onclick = close;
  $("#askForm").addEventListener("submit", e => { e.preventDefault(); const t = $("#askIn").value; $("#askIn").value = ""; send(t); });
  $("#askIn").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#askForm").requestSubmit(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  });
  $("#askLog").addEventListener("click", e => { const b = e.target.closest(".pglink"); if (b) goToPage(+b.dataset.p); });
  return { open, close, send, context, here, questionAt };
})();
