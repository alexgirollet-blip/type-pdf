// aimark.js — marking without leaving TypePDF.
//   Mark with AI      one button; the server tries free AIs best first (src/ai.js) and the marks go on the paper
//   Mark with Claude  Claude opens beside TypePDF with the request typed in; through the TypePDF connector it
//                     fetches the paper, marks it and sends the marks, which appear here straight away
//   Ask about it      a chat on the marked paper, answered by the same free AIs
//   AI settings       (admin) paste free API keys; how to get each one
// A marking that arrives (connector, drop link, another device) comes in through the synced inbox (one "inbox:<id>" key per marking).
"use strict";
const AIMark = window.AIMark = (() => {
  const $ = s => document.querySelector(s);
  const signedIn = () => !!(window.Sync && Sync.user);
  const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const r = await Sync.api(path, body === undefined ? { method } : { method, body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.tried) throw Object.assign(new Error(j.error || `Something went wrong (${r.status})`), { status: r.status });
    return j;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const jpeg = (c, q = 0.62) => c.toDataURL("image/jpeg", q).split(",")[1];

  // ---- what an AI needs: the answers, the instructions, the handwriting (one image per part) ----
  async function workingsImages(max = 30) {
    const items = workingsItems().slice(0, max), out = [], scale = 1.5, rasters = new Map();
    const raster = async p => { if (!rasters.has(p)) { if (rasters.size > 2) { const [k, v] = rasters.entries().next().value; v.width = 0; rasters.delete(k); } rasters.set(p, await pageRaster(p, scale, true)); } return rasters.get(p); };
    for (const it of items) {
      const W = Math.max(...it.segs.map(sg => doc.pages[sg.p].w)), GAP = 6, H = it.segs.reduce((t, sg) => t + (sg.y1 - sg.y0), 0) + GAP * (it.segs.length - 1);
      const c = document.createElement("canvas"); c.width = Math.round(W * scale); c.height = Math.round(H * scale);
      const cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, c.width, c.height); cx.filter = "grayscale(1)";
      let y = 0; for (const sg of it.segs) { const ras = await raster(sg.p), h = sg.y1 - sg.y0; cx.drawImage(ras, 0, sg.y0 * scale, ras.width, h * scale, 0, y * scale, ras.width, h * scale); y += h + GAP; }
      const pages = [...new Set(it.segs.map(sg => sg.p + 1))];
      out.push({ label: `Question ${it.q} · page${pages.length > 1 ? "s " + pages.join("–") : " " + pages[0]}${it.fig ? " · drawn on Figure " + it.fig : ""}`, data: jpeg(c), mime: "image/jpeg" });
      c.width = 0;
    }
    for (const v of rasters.values()) v.width = 0;
    return out;
  }
  async function exportFor() { await aiPrep(); return rememberExport(aiJSON(true)); }
  const fileList = (o, extra = []) => [{ name: "answers.json", what: "my typed and chosen answers, one entry per part, each with an id" }, ...((o.handwritten || []).length ? [{ name: "the handwriting images", what: "only what I wrote or drew by hand, one image per question part, captioned" }] : []), ...extra];

  // ---- Mark with AI: one press ----
  async function markWithAI() {
    if (!doc) return;
    if (!signedIn()) { toast("Sign in to use Mark with AI.", 4000); return; }
    try {
      busy(true, "Getting your answers ready…", 0.1);
      const o = await exportFor(), images = await workingsImages(24);
      busy(true, "Marking with AI… this can take a minute or two", null);
      const r = await api("/api/ai/mark", { prompt: markingPrompt(o, fileList(o), { inline: true }), answers: JSON.stringify(o), images, paperId: o.paperId, exported: o.exported, paperTitle: doc.name });
      busy(false);
      if (!r.marking) { failed(r); return; }
      r.marking.marker = r.marking.marker && !/^(claude|ai|marker)$/i.test(r.marking.marker) ? r.marking.marker : `AI (${r.provider})`;
      const warn = await Marking.importText(JSON.stringify(r.marking));
      $("#marksPop").hidden = false; Marking.refresh();
      toast(`Marked by ${r.provider}${warn.length ? ` · ${warn.length} note${warn.length > 1 ? "s" : ""} (see Marks)` : ""}.`, 5000);
    } catch (e) { busy(false); toast(e.status === 429 ? e.message : "Couldn't mark it: " + e.message, 7000); }
  }
  function failed(r) {
    const d = $("#aiFailDlg");
    $("#aiFailMsg").textContent = r.error || "No AI could mark it just now.";
    $("#aiFailList").innerHTML = (r.tried || []).map(t => `<li><b>${esc(t.k)}</b>: ${esc(t.why)}</li>`).join("") || "<li>No AI is set up yet.</li>";
    d.showModal();
  }

  // ---- Mark with Claude: Claude opens beside TypePDF and marks through the connector ----
  async function connectorUrl(reset) { const j = await api("/api/connector", reset ? { reset: true } : {}); return j.url; }
  // what the connector hands Claude: instructions, answers, handwriting and a picture of every page
  async function uploadPack() {
    const o = await exportFor();
    busy(true, "Preparing your paper for Claude… pictures of the pages", 0.2);
    const pages = [];
    for (let p = 0; p < doc.pages.length; p++) { busy(true, `Preparing your paper for Claude… page ${p + 1} of ${doc.pages.length}`, 0.2 + 0.5 * p / doc.pages.length); const c = await pageRaster(p, 1.25, true); pages.push(jpeg(c, 0.58)); c.width = 0; }
    busy(true, "Preparing your handwriting…", 0.75);
    const work = await workingsImages(40);
    const notes = labelIndex().filter(e => e.m && e.m.lvl === 0).reduce((a, e) => { (a[e.p + 1] ||= []).push(e.label); return a; }, {});
    const pageNotes = Object.entries(notes).map(([p, qs]) => `p${p}: Q${qs.join(", ")}`).join("; ");
    busy(true, "Sending it to your TypePDF account…", 0.9);
    const r = await api("/api/pack?doc=" + doc.id, { name: doc.name, exported: o.exported, prompt: markingPrompt(o, fileList(o, [{ name: "the page pictures", what: "get_page shows any page with my handwriting on it" }]), { connector: true }), answers: JSON.stringify(o), pages, work, pageNotes });
    busy(false);
    return { o, drop: r.drop };
  }
  const claudeAsk = () => `Use the TypePDF connector to mark my paper "${doc.name}" (paperId ${doc.id}). Call get_paper_for_marking, follow its instructions exactly, look at pages with get_page where the question or a diagram matters, then send the marking with submit_marking. After that, tell me my score and the 3 most important things to fix.`;
  async function markWithClaude() {
    if (!doc) return;
    if (!signedIn()) { toast("Sign in first: Claude reaches your paper through your TypePDF account.", 5000); return; }
    let ok = false; try { ok = localStorage.getItem("claudeConnected") === "1"; } catch (e) {}
    if (!ok) { openConnect(true); return; }
    // open the window now (a popup opened later, after awaiting, is blocked), then fill it in once the paper is ready
    const half = !matchMedia("(pointer: coarse)").matches && screen.availWidth > 1100;
    const win = window.open("about:blank", "typepdf-claude", half ? `width=${Math.round(screen.availWidth / 2)},height=${screen.availHeight},left=${Math.round(screen.availWidth / 2)},top=0` : undefined);
    try { if (win) win.document.body.innerHTML = '<p style="font:16px system-ui;padding:24px;color:#333">Getting your paper ready for Claude…</p>'; } catch (e) {}
    try {
      await uploadPack();
      const ask = claudeAsk(), link = "https://claude.ai/new?q=" + encodeURIComponent(ask);
      try { await navigator.clipboard.writeText(ask); } catch (e) {}
      if (win && !win.closed) win.location.href = link; else window.open(link, "_blank");
      waiting(true);
    } catch (e) { busy(false); if (win && !win.closed) win.close(); toast("Couldn't get the paper ready for Claude: " + e.message, 7000); }
  }
  // a quiet banner while Claude works; it goes when the marks arrive
  function waiting(on) {
    let b = $("#claudeWait");
    if (!on) { if (b) b.hidden = true; return; }
    if (!b) { b = document.createElement("div"); b.id = "claudeWait"; b.className = "claudewait"; document.body.appendChild(b); }
    b.innerHTML = `<b>Claude is marking</b> in the other window. The marks appear here as soon as it sends them.<small>If Claude's message box is empty, paste (the request is copied). On an iPad, put Claude and TypePDF side by side with Split View.</small><button type="button">Hide</button>`;
    b.querySelector("button").onclick = () => b.hidden = true;
    b.hidden = false;
  }
  async function openConnect(thenMark) {
    const d = $("#claudeDlg");
    $("#claudeUrl").value = "Getting your link…"; d.showModal(); d.dataset.then = thenMark ? "1" : "";
    try { $("#claudeUrl").value = await connectorUrl(); } catch (e) { $("#claudeUrl").value = ""; toast(e.message, 5000); }
  }

  // ---- marks arriving through the inbox (the connector, a drop link, another device) ----
  // every marking that has arrived: the newest goes on the paper, then they're all cleared (each by its own key)
  let inboxBusy = false;
  async function fromInbox() {
    if (!doc || !doc.inbox || !window.Marking || inboxBusy) return;
    const all = Object.values(doc.inbox).filter(v => v && v.json).sort((a, b) => (a.at || 0) - (b.at || 0)), v = all[all.length - 1];
    if (!v) return;
    inboxBusy = true;
    if (doc.marking && doc.marking.inboxId === v.id) { clearInbox(all); inboxBusy = false; return; }
    try {
      const warn = await Marking.importText(v.json);
      if (doc.marking) { doc.marking.inboxId = v.id; emit("marking"); scheduleSave(); }
      waiting(false); $("#marksPop").hidden = false; Marking.refresh();
      toast(`Marks from ${v.via || "the marker"} are on the paper${warn.length ? ` · ${warn.length} note${warn.length > 1 ? "s" : ""}` : ""}.`, 6000);
    } catch (e) { toast("A marking arrived but couldn't be read: " + e.message, 7000); }
    clearInbox(all); inboxBusy = false;
    if (Object.keys(doc.inbox || {}).length) setTimeout(fromInbox, 50);       // another arrived meanwhile
  }
  function clearInbox(list) { for (const v of list) { if (!doc.inbox || !doc.inbox[v.id]) continue; delete doc.inbox[v.id]; emit("inbox:" + v.id); } scheduleSave(); }

  // ---- the chat on the marked paper ----
  const chats = new Map();      // paper id → [{ role, text, by }]
  function chatContext() {
    let ans = ""; try { ans = JSON.stringify(aiJSON(true)); } catch (e) {}
    const m = doc.marking ? { ...doc.marking } : null; if (m) { delete m.map; delete m.edits; delete m.warn; delete m.extra; }
    return `Paper: ${doc.name}\n\nAnswers (JSON):\n${ans.slice(0, 60000)}\n\nMarking (JSON):\n${m ? JSON.stringify(m).slice(0, 50000) : "not marked yet"}`;
  }
  function renderChat() {
    const box = $("#mkChatLog"); if (!box || !doc) return;
    const list = chats.get(doc.id) || [];
    box.innerHTML = list.length ? list.map(m => `<div class="mkmsg ${m.role}">${esc(m.text).replace(/\n/g, "<br>")}${m.by ? `<small>${esc(m.by)}</small>` : ""}</div>`).join("") : `<p class="note">Ask anything about your marks: "why did I lose a mark on 7(b)?", "show me a full-mark answer for 3(a)", "what should I revise?"</p>`;
    box.scrollTop = box.scrollHeight;
  }
  async function sendChat(text) {
    if (!text.trim() || !doc) return;
    if (!signedIn()) { toast("Sign in to chat about your marks.", 4000); return; }
    const list = chats.get(doc.id) || []; list.push({ role: "user", text }); chats.set(doc.id, list); renderChat();
    const pending = { role: "assistant", text: "…" }; list.push(pending); renderChat();
    try {
      const r = await api("/api/ai/chat", { context: chatContext(), messages: list.filter(m => m !== pending).map(m => ({ role: m.role, text: m.text })) });
      pending.text = r.text || r.error || "No answer just now."; pending.by = r.provider || "";
    } catch (e) { pending.text = e.message; }
    renderChat();
  }

  // ---- AI settings (admin): free keys, best first; how to get each one ----
  const HOW = {
    claude: { url: "https://console.anthropic.com/settings/keys", how: "Not free: buy a small amount of prepaid credit and leave auto-reload off, so it simply stops when the credit's used. Best marking. Create a key and paste it." },
    gemini: { url: "https://aistudio.google.com/apikey", how: "Free: sign in with a Google account → Create API key. Don't turn on billing for that project, so it just stops at the free limit." },
    github: { url: "https://github.com/settings/personal-access-tokens/new", how: "Free with a GitHub account: create a fine-grained token, Permissions → Models: Read-only. Small daily limits." },
    openrouter: { url: "https://openrouter.ai/keys", how: "Free: create a key. Only models that cost nothing are used (picked from OpenRouter's current list; about 50 requests a day without credit). Don't add credit." },
    groq: { url: "https://console.groq.com/keys", how: "Free: sign up → Create API key. No card needed." },
    custom: { url: "https://github.com/cheahjs/free-llm-api-resources", how: "Any other service with an OpenAI-style API (e.g. Cerebras, NVIDIA NIM, SambaNova, Together's free models): put its chat/completions address, key and model name." },
    cloudflare: { url: "https://dash.cloudflare.com/?to=/:account/workers/plans", how: "No key: it's built into the TypePDF Worker. Only switch it on if your Workers plan is Free (then it stops at the daily allowance); on the paid plan extra use is billed." },
  };
  async function openSettings() {
    const d = $("#aiSetDlg"), box = $("#aiSetList"); d.showModal(); box.innerHTML = "<p class='note'>Loading…</p>";
    try { const j = await api("/api/ai/providers"); drawSettings(j.providers || []); } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }
  function drawSettings(ps) {
    const box = $("#aiSetList"); box.innerHTML = "";
    ps.forEach((p, i) => {
      const h = HOW[p.id] || {}, row = document.createElement("div"); row.className = "aiprov" + (p.set && p.on ? " live" : "");
      row.innerHTML = `<div class="aiph"><b>${i + 1}. ${esc(p.name)}</b>${p.paid ? '<span class="paid">paid (capped)</span>' : '<span class="free">free</span>'}<span class="st">${p.set ? (p.on ? (p.fromEnv ? "✓ set (Worker secret)" : "✓ set") : "set, switched off") : "not set"}</span></div>
        <p class="note">${esc(h.how || "")} <a href="${esc(h.url || "#")}" target="_blank" rel="noopener">Get a key ↗</a></p>
        <div class="row wrap">${p.optIn ? "" : `<input type="password" placeholder="${p.set ? "Paste a new key to replace it" : "Paste the key"}" autocomplete="off" data-k="key">`}
        ${p.id === "custom" ? `<input type="text" placeholder="https://…/v1/chat/completions" value="${esc(p.url || "")}" data-k="url">` : ""}
        <input type="text" placeholder="${p.id === "custom" ? "Model name (required)" : "Models (optional): " + esc(p.defaults)}" value="${esc(p.models)}" data-k="models">
        <label class="chk"><input type="checkbox" data-k="on" ${p.on ? "checked" : ""}> Use</label>
        <button type="button" data-a="save">Save</button><button type="button" data-a="test" ${p.set || p.optIn ? "" : "disabled"}>Test</button>${p.set && !p.fromEnv && !p.optIn ? '<button type="button" data-a="clear">Remove key</button>' : ""}</div>
        ${p.auto ? `<small class="aiauto">Using now: ${esc(p.auto.join(", "))}</small>` : ""}<small class="aires"></small>`;
      row.onclick = async e => {
        const a = e.target.dataset.a; if (!a) return;
        const res = row.querySelector(".aires"), v = k => row.querySelector(`[data-k="${k}"]`);
        try {
          if (a === "save" || a === "clear") {
            const body = { id: p.id, models: v("models").value, on: v("on").checked, ...(v("url") ? { url: v("url").value } : {}) };
            if (a === "clear") body.key = ""; else if (v("key") && v("key").value.trim()) body.key = v("key").value.trim();
            const j = await api("/api/ai/providers", body); drawSettings(j.providers);
          } else if (a === "test") {
            res.textContent = "Testing…";
            const j = await api("/api/ai/test", { id: p.id });
            const fails = (j.tried || []).map(t => `${t.k.split("/").slice(1).join("/")}: ${t.why}`);
            if (j.providers) { const np = j.providers.find(x => x.id === p.id); const au = row.querySelector(".aiauto"); if (np && np.auto) { if (au) au.textContent = "Using now: " + np.auto.join(", "); else res.insertAdjacentHTML("beforebegin", `<small class="aiauto">Using now: ${esc(np.auto.join(", "))}</small>`); } }
            res.innerHTML = j.ok ? `✓ Works: <b>${esc(j.model)}</b> answered${fails.length ? ` (after: ${fails.map(esc).join("; ")})` : ""}.` : `✗ Not working yet.<ul>${fails.map(f => `<li>${esc(f)}</li>`).join("") || `<li>${esc(j.error)}</li>`}</ul>`;
          }
        } catch (er) { res.textContent = er.message; }
      };
      box.appendChild(row);
    });
  }

  function wire() {
    document.addEventListener("click", e => {
      const a = e.target.closest("[data-ai]"); if (!a) return;
      const what = a.dataset.ai;
      if (what === "mark") { $("#aiDlg").open && $("#aiDlg").close(); markWithAI(); }
      if (what === "claude") { $("#aiDlg").open && $("#aiDlg").close(); markWithClaude(); }
      if (what === "connect") openConnect(false);
      if (what === "settings") openSettings();
      if (what === "askclaude" && doc) window.open("https://claude.ai/new?q=" + encodeURIComponent(`Using the TypePDF connector, call get_marking for my paper "${doc.name}" (paperId ${doc.id}) and help me understand where I lost marks and how to get them next time.`), "typepdf-claude");
    });
    $("#aiBtn").addEventListener("click", () => { const b = document.querySelector('[data-ai="settings"]'); if (b) b.hidden = !(window.Sync && Sync.info && Sync.info.admin); });
    $("#claudeCopy").onclick = async () => { try { await navigator.clipboard.writeText($("#claudeUrl").value); toast("Connector link copied."); } catch (e) { $("#claudeUrl").select(); document.execCommand("copy"); toast("Copied."); } };
    $("#claudeReset").onclick = async () => { if (!confirm("Reset your connector link? The old link stops working, so you'll need to add the new one in Claude.")) return; try { $("#claudeUrl").value = await connectorUrl(true); try { localStorage.removeItem("claudeConnected"); } catch (e) {} toast("New link made: add it in Claude in place of the old one.", 5000); } catch (e) { toast(e.message); } };
    $("#claudeDone").onclick = () => { try { localStorage.setItem("claudeConnected", "1"); } catch (e) {} const then = $("#claudeDlg").dataset.then; $("#claudeDlg").close(); if (then) markWithClaude(); };
    $("#claudeClose").onclick = () => $("#claudeDlg").close();
    $("#aiSetClose").onclick = () => $("#aiSetDlg").close();
    $("#aiFailClose").onclick = () => $("#aiFailDlg").close();
    $("#aiFailClaude").onclick = () => { $("#aiFailDlg").close(); markWithClaude(); };
    document.addEventListener("submit", e => { if (e.target.id !== "mkChatForm") return; e.preventDefault(); const i = $("#mkChatIn"); const t = i.value; i.value = ""; sendChat(t); });
  }
  setTimeout(wire, 0);
  return { markWithAI, markWithClaude, fromInbox, renderChat, openSettings, openConnect, uploadPack, workingsImages };
})();
