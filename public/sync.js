// sync.js — sign-in (through the hub), live sync, and shared papers for TypePDF.
// Each change is a key → value pair (an answer, a stroke, a page's answer spaces, the timer).
// Keys are sent over a WebSocket to the account's store, which numbers every change and passes it
// on to the other open devices straight away. Offline changes stay marked "dirty" and are sent
// when the connection comes back.
"use strict";
window.Sync = (() => {
  const S = { info: null, user: null, token: null, ws: null, doc: null, live: false, ready: null, retry: 1000, received: null, presence: 1, people: [], sid: null, pingT: 0, flushT: 0, ver: 0, state: "local", hub: null };
  let device = ""; try { device = localStorage.getItem("device") || ""; if (!device) { device = Math.random().toString(36).slice(2, 12); localStorage.setItem("device", device); } } catch (e) {}

  // ---------- HTTP ----------
  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (S.token) headers.authorization = "Bearer " + S.token;
    if (opts.body && typeof opts.body === "string") headers["content-type"] = "application/json";
    const res = await fetch(path, { ...opts, headers });
    if (res.status === 401 && S.token && !path.startsWith("/api/share/")) { const j = await res.clone().json().catch(() => ({})); signedOut(); toast(j.error || "You've been signed out. Sign in again to keep syncing.", 5000); }
    return res;
  }
  async function jsonOrThrow(res) { const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(j.error || `Something went wrong (${res.status})`); return j; }

  // ---------- accounts ----------
  async function init() {
    // back from the hub: #signin=<session> (or #signinerror=<why>)
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("signin")) { try { localStorage.setItem("token", h.get("signin")); localStorage.removeItem("user"); } catch (e) {} history.replaceState(null, "", location.pathname + location.search); S.justSignedIn = true; }
    if (h.get("signinerror")) { history.replaceState(null, "", location.pathname + location.search); setTimeout(() => toast(h.get("signinerror"), 6000), 300); }
    fetch("/api/config").then(r => r.json()).then(c => { S.hub = !!c.hub; renderAccount(); }).catch(() => {});
    try { S.token = localStorage.getItem("token"); S.user = localStorage.getItem("user"); } catch (e) {}
    renderAccount();
    if (S.token) {
      try { const j = await jsonOrThrow(await api("/api/auth/me")); S.user = j.user; S.info = j; localStorage.setItem("user", j.user); if (S.justSignedIn) toast(`Signed in as ${j.name || j.email}.`); }
      catch (e) { if (!navigator.onLine) {/* keep the cached user while offline */} else signedOut(); }
    }
    renderAccount(); if (typeof renderHomeList === "function" && !$("#home").hidden) renderHomeList();
  }
  function signIn() { if (S.hub === false) { toast("Sign-in isn't set up on this site yet."); return; } location.href = "/api/auth/hub-login"; }
  function signedIn(j) { S.user = j.user; S.token = j.token; S.info = j; try { localStorage.setItem("token", j.token); localStorage.setItem("user", j.user); } catch (e) {} renderAccount(); renderHomeList(); if (doc) attach(doc).then(() => live()); }
  function signedOut() { if (!(S.doc && S.doc.shared)) detach(); S.user = null; S.token = null; S.info = null; try { localStorage.removeItem("token"); localStorage.removeItem("user"); } catch (e) {} renderAccount(); setState(S.doc && S.doc.shared ? S.state : "local"); }
  async function logout() { try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch (e) {} signedOut(); if (typeof showHome === "function" && doc && !doc.shared) showHome(); else renderHomeList(); toast("Signed out."); }

  function renderAccount() {
    const el = $("#acct"); if (!el) return;
    if (S.user) {
      el.innerHTML = `<span>Signed in as <b></b>${S.info && S.info.admin ? ' <em class="adm">admin</em>' : ""}</span>${S.info && S.info.admin ? '<button id="adminBtn">Admin</button>' : ""}<button id="acctBtn">Account</button><button id="outBtn">Sign out</button>`;
      $("b", el).textContent = (S.info && (S.info.name || S.info.email)) || "you"; $("b", el).title = (S.info && S.info.email) || "";
      if ($("#adminBtn")) $("#adminBtn").onclick = () => window.openAdmin && openAdmin();
      $("#outBtn").onclick = logout; $("#acctBtn").onclick = () => { $("#acctErr").textContent = ""; $("#acEmail").textContent = (S.info && S.info.email) || ""; $("#acctDlg").showModal(); };
    } else {
      el.innerHTML = `<span>Sign in with your GirolletServer account to save papers and sync them live between devices.</span><button id="inBtn" class="primary">Sign in</button>`;
      $("#inBtn").onclick = signIn;
    }
    const pill = $("#syncPill"); if (pill) pill.hidden = false;
    setState(S.user ? (S.ws && S.ws.readyState === 1 ? "synced" : S.doc ? "connecting" : "idle") : "local");
  }
  function openAuth() { signIn(); }
  function wireDialogs() {
    $("#acClose").onclick = () => $("#acctDlg").close();
    $("#delForm").onsubmit = async e => {
      e.preventDefault(); $("#acctErr").textContent = "";
      if ($("#delConfirm").value.trim().toLowerCase() !== "delete") { $("#acctErr").textContent = 'Type "delete" to confirm.'; return; }
      try { await jsonOrThrow(await api("/api/auth/delete", { method: "POST", body: "{}" })); $("#acctDlg").close(); signedOut(); renderHomeList(); toast("Your TypePDF papers have been deleted. Your GirolletServer account is unchanged."); }
      catch (err) { $("#acctErr").textContent = err.message; }
    };
  }

  // ---------- documents over HTTP ----------
  async function listDocs() { return jsonOrThrow(await api("/api/docs")); }
  async function deleteDoc(id, purge) { return jsonOrThrow(await api("/api/docs/" + id + (purge ? "?purge=1" : ""), { method: "DELETE" })); }
  async function patchDoc(id, fields) { return jsonOrThrow(await api("/api/docs/" + id, { method: "PATCH", body: JSON.stringify(fields) })); }
  async function createDoc(rec) { return jsonOrThrow(await api("/api/docs", { method: "POST", body: JSON.stringify(rec) })); }
  async function saveFolders(folders, ver) { const r = await api("/api/library", { method: "PUT", body: JSON.stringify({ folders, ver }) }); const j = await r.json().catch(() => ({})); if (r.status === 409) return { conflict: true, ...j }; if (!r.ok) throw new Error(j.error || "Couldn't save folders"); return j; }
  async function getPdf(hash) { const r = await api("/api/pdf/" + hash); if (!r.ok) throw new Error("the PDF isn't in your account yet"); return r.arrayBuffer(); }
  // ---------- sharing ----------
  const share = {
    codes: async id => jsonOrThrow(await api("/api/share/codes", { method: "POST", body: JSON.stringify({ doc: id }) })),
    reset: async id => jsonOrThrow(await api("/api/share/reset", { method: "POST", body: JSON.stringify({ doc: id }) })),
    people: async id => jsonOrThrow(await api("/api/share/people", { method: "POST", body: JSON.stringify({ doc: id }) })),
    remove: async (id, pid) => jsonOrThrow(await api("/api/share/remove", { method: "POST", body: JSON.stringify({ doc: id, pid }) })),
    join: async (code, name) => jsonOrThrow(await api("/api/share/join", { method: "POST", body: JSON.stringify({ code, name }) })),
    rejoin: async (owner, id) => jsonOrThrow(await api("/api/share/rejoin", { method: "POST", body: JSON.stringify({ owner, doc: id }) })),
    list: async () => jsonOrThrow(await api("/api/shared/list")),
    leave: async (owner, id) => jsonOrThrow(await api("/api/shared/remove", { method: "POST", body: JSON.stringify({ owner, doc: id }) })),
    pdf: async pass => { const r = await fetch("/api/share/pdf", { headers: { "x-share": pass } }); if (!r.ok) throw new Error("couldn't fetch the paper"); return r.arrayBuffer(); },
  };
  function focus(rid) { if (S.ws && S.ws.readyState === 1 && S.doc) S.ws.send(JSON.stringify({ t: "focus", rid: rid || null })); S.myFocus = rid || null; }
  async function refreshInfo() { try { S.info = await jsonOrThrow(await api("/api/auth/me")); } catch (e) {} return S.info; }
  const admin = {
    overview: async () => jsonOrThrow(await api("/api/admin/overview")),
    quota: async (user, quota) => jsonOrThrow(await api("/api/admin/quota", { method: "POST", body: JSON.stringify({ user, quota }) })),
    setDefault: async quota => jsonOrThrow(await api("/api/admin/default", { method: "POST", body: JSON.stringify({ quota }) })),
    docs: async user => jsonOrThrow(await api(`/api/admin/user/${user}/docs`)),
    deleteDoc: async (user, id) => jsonOrThrow(await api(`/api/admin/user/${user}/docs/${id}`, { method: "DELETE" })),
    deleteUser: async user => jsonOrThrow(await api(`/api/admin/user/${user}`, { method: "DELETE" })),
  };
  function fetchPdf(url) { return api("/api/fetch-pdf?url=" + encodeURIComponent(url)); }
  async function uploadPdf(d) {
    try {
      const r = await api(`/api/pdf/${d.pdf || d.id}?doc=${d.id}&name=${encodeURIComponent(d.name)}`, { method: "PUT", body: d.bytes.slice(0), headers: { "content-type": "application/pdf" } });
      if (!r.ok) { const j = await r.json().catch(() => ({})); toast("This paper's PDF couldn't be stored in your account: " + (j.error || r.status), 6000); }
    } catch (e) { /* retried next time the paper is opened */ }
  }

  // ---------- values for each key ----------
  function valueOf(k) {
    if (k === "meta") return JSON.stringify(metaOf());
    if (k === "timer") return doc.timer ? JSON.stringify(doc.timer) : null;
    if (k === "font") return doc.font ? JSON.stringify(doc.font) : null;
    if (k.startsWith("flag:")) return doc.flags && doc.flags[k.slice(5)] ? JSON.stringify(doc.flags[k.slice(5)]) : null;
    let m;
    if ((m = k.match(/^page:(\d+)$/))) { const P = doc.pages[+m[1]]; if (!P) return null; return JSON.stringify({ w: P.w, h: P.h, rot: P.rot, hasText: P.hasText, ocr: P.ocr, items: P.items, qs: P.qs, regions: P.regions.map(cleanRegion) }); }
    if ((m = k.match(/^text:(.+)$/))) return doc.text[m[1]] ? JSON.stringify(doc.text[m[1]]) : null;
    if ((m = k.match(/^s:(\d+):(.+)$/))) { const s = (doc.strokes[+m[1]] || []).find(q => q.id === m[2]); if (!s || s._live) return null; const { _live, ...rest } = s; return JSON.stringify(rest); }
    return null;
  }
  function allKeys() {
    const ks = ["meta"]; if (doc.timer) ks.push("timer"); if (doc.font) ks.push("font");
    for (const k of Object.keys(doc.flags || {})) ks.push("flag:" + k);
    doc.pages.forEach((P, p) => { if (P && P.regions) ks.push("page:" + p); });
    for (const k of Object.keys(doc.text)) ks.push("text:" + k);
    for (const [p, arr] of Object.entries(doc.strokes)) for (const s of arr || []) ks.push(`s:${p}:${s.id}`);
    return ks;
  }

  // ---------- applying changes from other devices ----------
  function applyRemote(k, raw) {
    if (S.received) S.received.add(k);
    if (doc.dirty[k]) return;                       // our newer change is still on its way
    const v = raw == null ? null : JSON.parse(raw);
    let m;
    if (k === "meta") { if (v && v.name && v.name !== doc.name) { doc.name = v.name; if (S.live) { $("#docName").textContent = doc.name; } } return; }
    if (k === "timer") { doc.timer = v; if (S.live) timerTick(); return; }
    if (k === "font") { if (v) { doc.font = v; if (S.live) applyFont(); } return; }
    if (k.startsWith("flag:")) { const id = k.slice(5); doc.flags ||= {}; if (v) doc.flags[id] = v; else delete doc.flags[id]; if (S.live) { const p = +id.split(":")[0]; layoutPage(p); renderFlags(); } return; }
    if ((m = k.match(/^page:(\d+)$/))) {
      const p = +m[1]; if (!v) return;
      const gaps = (doc.pages[p] && doc.pages[p].gaps) || {};
      const fresh = { ...v, regions: (v.regions || []).map(cleanRegion), gaps: {} };
      for (const r of fresh.regions) if (gaps[r.id]) fresh.gaps[r.id] = gaps[r.id];
      doc.pages[p] = fresh;
      if (S.live && views[p]) rebuildPageFields(p);
      return;
    }
    if ((m = k.match(/^text:(.+)$/))) {
      const id = m[1];
      if (v) doc.text[id] = v; else delete doc.text[id];
      if (S.live) {
        const r = findRegion(id);
        if (r && r._el && r._el.value !== (v || "")) {
          const ta = r._el, focused = document.activeElement === ta, s = ta.selectionStart, e = ta.selectionEnd;
          ta.value = v || "";
          if (focused) { const L = ta.value.length; ta.setSelectionRange(Math.min(s, L), Math.min(e, L)); }
          const p = +id.split(":")[0]; queueFit(p, r);
        }
        updateCount();
      }
      return;
    }
    if ((m = k.match(/^s:(\d+):(.+)$/))) {
      const p = +m[1], sid = m[2]; const arr = doc.strokes[p] ||= [];
      const i = arr.findIndex(q => q.id === sid);
      if (!v) { if (i >= 0) arr.splice(i, 1); }
      else if (i >= 0) arr[i] = v; else arr.push(v);
      if (S.live) drawInk(p);
      return;
    }
  }

  // ---------- connection ----------
  function wsUrl(d) {
    const u = new URL("/api/sync", location.href); u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    if (d.shared) u.searchParams.set("share", d.shared.pass);
    else { u.searchParams.set("doc", d.id); u.searchParams.set("token", S.token); u.searchParams.set("device", device); }
    return u.toString();
  }
  const canSync = d => !!(d && (d.shared || S.user));
  function attach(d) {
    if (!canSync(d)) return Promise.resolve();
    detach(); S.doc = d; S.live = false;
    return new Promise(resolve => {
      let done = false; const finish = () => { if (!done) { done = true; resolve(); } };
      S.ready = finish; setTimeout(finish, 7000);      // never block opening a paper for long
      connect();
    });
  }
  function connect() {
    if (!S.doc || !canSync(S.doc)) return;
    if (S.doc.shared && S.doc.shared.exp && S.doc.shared.exp < Date.now() + 60e3) { S.doc.shared.expired = true; setState("offline"); toast("Your pass for this shared paper has run out. Go home and join again with the code.", 8000); return; }
    const d = S.doc;
    setState("connecting");
    let ws; try { ws = new WebSocket(wsUrl(d)); } catch (e) { return scheduleRetry(); }
    S.ws = ws;
    ws.onopen = () => {
      S.retry = 1000;
      S.received = d.seq || d.shared ? null : new Set();
      ws.send(JSON.stringify({ t: "hello", since: d.seq || 0, name: d.name, pdf: d.pdf || d.id }));
      clearInterval(S.pingT); S.pingT = setInterval(() => { if (ws.readyState === 1) ws.send('{"t":"ping"}'); }, 25000);
    };
    ws.onmessage = ev => {
      if (S.doc !== d) return;
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === "snap") {
        for (const [k, v, seq] of m.items) { applyRemote(k, v); if (seq > d.seq) d.seq = seq; }
        if (m.live) { flashLive(); scheduleSave(); }
      } else if (m.t === "ready") {
        if (m.seq > d.seq) d.seq = m.seq;
        // first time this device links this paper: send anything the account doesn't have yet
        if (S.received) { for (const k of allKeys()) if (!S.received.has(k)) d.dirty[k] = ++S.ver; S.received = null; }
        if (!m.haspdf && !d.shared) uploadPdf(d);
        setState("synced"); flush();
        if (S.ready) { S.ready(); S.ready = null; }
      } else if (m.t === "ack") {
        for (const [id, seq] of m.acks) { const i = id.lastIndexOf("#"); const k = id.slice(0, i), ver = +id.slice(i + 1); if (d.dirty[k] === ver) delete d.dirty[k]; if (seq > d.seq) d.seq = seq; }
        setState(Object.keys(d.dirty).length ? "syncing" : "synced"); scheduleSave();
      } else if (m.t === "welcome") { S.sid = m.sid; }
      else if (m.t === "presence") { S.presence = m.n; S.people = m.people || []; setState(S.state); if (window.onPeople) onPeople(S.people, S.sid); if (S.myFocus) { /* keep the server's lock in step after a reconnect */ const me = S.people.find(p => p.sid === S.sid); if (me && me.focus !== S.myFocus) ws.send(JSON.stringify({ t: "focus", rid: S.myFocus })); } }
      else if (m.t === "locked") { S.myFocus = null; if (window.onLocked) onLocked(m.rid, m.by); }
      else if (m.t === "removed") { d.shared && (d.shared.gone = true); }
      else if (m.t === "deleted") {
        if (d.shared) { d.shared.gone = true; toast("The owner deleted this paper, or moved it to their bin."); detach(); if (typeof showHome === "function") showHome(); }
        else { toast("This paper was deleted from your account on another device. It's still saved here."); detach(); d.seq = 0; d.dirty = {}; }
      }
    };
    ws.onclose = ev => {
      clearInterval(S.pingT);
      if (S.ws !== ws) return;
      S.ws = null;
      if (ev.code === 4001 || ev.code === 4002) { setState("idle"); return; }
      if (ev.code === 4003 || (d.shared && d.shared.gone)) { toast("The owner removed you from this paper.", 6000); S.doc = null; if (typeof showHome === "function") showHome(); return; }
      if (S.ready) { S.ready(); S.ready = null; }
      scheduleRetry();
    };
    ws.onerror = () => {};
  }
  function scheduleRetry() {
    if (!S.doc) return;
    setState("offline");
    clearTimeout(S.retryT); S.retryT = setTimeout(connect, S.retry); S.retry = Math.min(S.retry * 2, 15000);
  }
  window.addEventListener("online", () => { if (S.doc && !S.ws) { S.retry = 1000; connect(); } });
  function detach() { clearTimeout(S.retryT); clearTimeout(S.flushT); clearInterval(S.pingT); if (S.ws) { const w = S.ws; S.ws = null; try { w.close(); } catch (e) {} } S.doc = null; S.live = false; S.presence = 1; S.people = []; S.sid = null; S.myFocus = null; if (window.onPeople) onPeople([], null); setState(S.user ? "idle" : "local"); }
  function live() { if (S.doc) S.live = true; flush(); }

  // ---------- sending ----------
  function changed(k) {
    if (!S.doc || S.doc !== doc || !canSync(doc)) return;
    if (doc.shared && doc.shared.role === "view") return;
    doc.dirty[k] = ++S.ver;
    clearTimeout(S.flushT); S.flushT = setTimeout(flush, 120);
    if (S.state === "synced") setState("syncing");
  }
  function flush() {
    const d = S.doc; if (!d || !S.ws || S.ws.readyState !== 1) return;
    const keys = Object.keys(d.dirty); if (!keys.length) return;
    for (let i = 0; i < keys.length; i += 200) {
      const ops = keys.slice(i, i + 200).map(k => ({ k, v: valueOf(k), id: k + "#" + d.dirty[k] }));
      S.ws.send(JSON.stringify({ t: "sets", ops }));
    }
  }

  // ---------- status ----------
  function setState(st) {
    S.state = st; const pill = $("#syncPill"); if (!pill) return;
    const sh = S.doc && S.doc.shared;
    const n = S.presence > 1 ? (sh || S.people.some(p => p.role !== "owner") ? ` · ${S.presence} here` : ` · open on ${S.presence} devices`) : "";
    const label = sh ? ({ connecting: "Joining…", synced: (sh.role === "view" ? "View only" : "Shared") + n, syncing: "Saving…" + n, offline: "Reconnecting…" }[st] || "Shared")
      : ({ local: "Not saved · sign in to save", idle: "Signed in", connecting: "Connecting…", synced: "Synced" + n, syncing: "Syncing…" + n, offline: "Offline · saved here, will sync" }[st] || st);
    pill.textContent = label; pill.dataset.state = st;
    pill.title = st === "local" && !sh ? "Without an account nothing is saved. Export the PDF before you leave, or sign in to save." : sh ? "Someone shared this paper with you. Changes are saved in their account." : "";
  }
  function flashLive() { const pill = $("#syncPill"); if (!pill) return; pill.classList.remove("flash"); void pill.offsetWidth; pill.classList.add("flash"); }

  return {
    init, wireDialogs, attach, detach, live, changed, listDocs, deleteDoc, patchDoc, createDoc, saveFolders, getPdf, fetchPdf, openAuth, signIn, refreshInfo, admin, share, focus,
    get user() { return S.user; }, get info() { return S.info; }, get people() { return S.people; }, get sid() { return S.sid; },
  };
})();
const Sync = window.Sync; Sync.wireDialogs();
$("#syncPill").onclick = () => { if (!Sync.user && !(doc && doc.shared)) Sync.signIn(); };
Sync.init().then(() => {}).catch(() => {});
