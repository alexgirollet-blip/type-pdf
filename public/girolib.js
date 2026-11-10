// girolib.js — TypePDF and Girolibrary (library.girolletserver.com) working together.
//
//  • A link  /#open=<PDF address>&name=<title>  opens that PDF as a paper (Girolibrary's "Answer in TypePDF"
//    button sends these; any site can). Signed in, it's added to your papers like any other.
//  • A link  /#paper=<id>  opens one of your papers (Claude's add_paper hands these back).
//  • "From your Girolibrary" on the home page: the library's PDFs you can see, one tap to answer one.
//    Read straight from the library in your browser with your library sign-in (both sites are on the same domain).
"use strict";
(() => {
  const el = id => document.getElementById(id);
  const escH = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let libraryUrl = null;

  // ---------- #open=<url>&name=<title> ----------
  function openFromHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    const u = h.get("open");
    if (!u) return;
    const name = h.get("name") || "";
    history.replaceState(null, "", location.pathname + location.search);
    let target; try { target = new URL(u); } catch (e) { toast("That link to a PDF isn't valid."); return; }
    if (!/^https?:$/.test(target.protocol)) return;
    // signed in: wait (briefly) until the account is ready, so the paper is saved to it
    let n = 0;
    const go = () => {
      const signing = (() => { try { return !!localStorage.getItem("token"); } catch (e) { return false; } })();
      if (signing && !(window.Sync && Sync.info) && ++n < 40) return setTimeout(go, 150);
      if (typeof openLink === "function") openLink(target.toString(), name);
    };
    go();
  }

  // ---------- From your Girolibrary ----------
  async function config() {
    if (libraryUrl !== null) return libraryUrl;
    try { libraryUrl = (await (await fetch("/api/config")).json()).library || ""; } catch (e) { libraryUrl = ""; }
    return libraryUrl;
  }

  let data = null;
  async function shelf() {
    const sec = el("girolib"); if (!sec) return;
    const lib = await config();
    if (!lib) { sec.hidden = true; return; }
    el("glOpen").href = lib;
    try {
      const r = await fetch(lib + "/api/embed/pdfs", { credentials: "include" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      data = await r.json();
    } catch (e) { sec.hidden = true; return; }      // library not reachable from here: say nothing
    sec.hidden = false;
    render();
  }
  function render() {
    const j = data; if (!j) return;
    const body = el("glBody"), note = el("glNote");
    if (!j.signedIn) {
      note.innerHTML = `<a href="${escH(j.signIn + "?next=/")}" target="_blank" rel="noopener">Sign in to Girolibrary</a> to see its PDFs here, then come back and refresh.`;
      body.innerHTML = "";
      el("glCount").textContent = "";
      return;
    }
    el("glCount").textContent = j.pdfs.length ? `${j.pdfs.length} PDF${j.pdfs.length === 1 ? "" : "s"}` : "";
    note.textContent = j.pdfs.length ? "" : "No PDFs in the library for you yet.";
    const q = (el("glQ").value || "").toLowerCase();
    const list = j.pdfs.filter(p => !q || [p.title, p.subject, ...(p.tags || [])].join(" ").toLowerCase().includes(q));
    body.innerHTML = list.map((p, i) => `<li>
      <div class="pfinfo"><b>${escH(p.icon || "📄")} ${escH(p.title)}</b>${p.subject ? `<span class="pfkind">${escH(p.subject)}</span>` : ""}${p.isNew ? `<span class="pfkind k-new">New</span>` : ""}${p.desc ? `<small>${escH(p.desc)}</small>` : ""}</div>
      <a class="pfsrc" href="${escH(p.page)}" target="_blank" rel="noopener" title="Open in Girolibrary">Library ↗</a>
      <button type="button" class="pfopen" data-i="${i}">Answer</button></li>`).join("");
    body.querySelectorAll("button[data-i]").forEach(b => b.onclick = () => { const p = list[+b.dataset.i]; if (typeof openLink === "function") openLink(p.src, p.title); });
  }

  // ---------- #paper=<id> ----------
  function paperFromHash() {
    const id = new URLSearchParams(location.hash.slice(1)).get("paper");
    if (!id || !/^[a-f0-9]{8,64}$/.test(id)) return;
    history.replaceState(null, "", location.pathname + location.search);
    let n = 0, reloaded = false;
    const go = async () => {
      const find = () => window.Home && (Home.entries || []).find(x => x.id === id);
      if (find()) return openStored(id, find());
      const signedIn = window.Sync && Sync.user;
      // just added (e.g. by Claude) after this page loaded: read the list again
      if (signedIn && !reloaded && typeof loadEntries === "function") { reloaded = true; try { await loadEntries(); } catch (e) {} if (find()) return openStored(id, find()); }
      if (++n < 60) return setTimeout(go, 200);          // still signing in / loading
      toast(signedIn ? "That paper isn't in your TypePDF papers." : "Sign in to open that paper.");
    };
    go();
  }

  function init() {
    openFromHash();
    paperFromHash();
    window.addEventListener("hashchange", () => { openFromHash(); paperFromHash(); });
    const sec = el("girolib"); if (!sec) return;
    sec.addEventListener("toggle", () => { if (sec.open) shelf(); });
    el("glQ").addEventListener("input", render);
    el("glRefresh").addEventListener("click", () => shelf());
    shelf();                                      // shows the section only when the library answers
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
