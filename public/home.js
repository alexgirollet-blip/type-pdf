// home.js — the home screen: your papers, nested folders, search/sort/filter, storage, bin, admin.
"use strict";
const Home = window.Home = { folder: null, folders: [], foldersVer: 0, entries: [], used: 0, quota: 0 };
const fmtBytes = n => n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1) + " GB" : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
const ago = t => { if (!t) return ""; const s = (Date.now() - t) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago"; if (s < 86400) return Math.round(s / 3600) + " h ago"; if (s < 86400 * 7) return Math.round(s / 86400) + " d ago"; return new Date(t).toLocaleDateString(); };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hexId = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, "0")).join("");
const signedIn = () => !!(window.Sync && Sync.user);
let prefs = { sort: "opened", filter: "all" }; try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem("homePrefs") || "{}") }; } catch (e) {}
function savePrefs() { try { localStorage.setItem("homePrefs", JSON.stringify(prefs)); } catch (e) {} }

// ---------------- data ----------------
async function localLib() { return (await DB.getMeta("__lib").catch(() => null)) || { id: "__lib", folders: [] }; }
async function saveFolders(folders) {
  Home.folders = folders;
  await DB.putMeta({ id: "__lib", folders, updated: Date.now() }).catch(() => {});
  if (signedIn()) {
    let r = await Sync.saveFolders(folders, Home.foldersVer).catch(e => { toast(e.message); return null; });
    if (r && r.conflict) {              // changed on another device meanwhile: merge by id and save again
      const byId = new Map(r.folders.map(f => [f.id, f])); for (const f of folders) byId.set(f.id, f);
      Home.foldersVer = r.ver; r = await Sync.saveFolders([...byId.values()], r.ver).catch(() => null);
    }
    if (r && r.ver) Home.foldersVer = r.ver;
  }
}
async function setMeta(e, fields) {
  // update this device's record and the account's copy
  Object.assign(e, fields);
  if (e.local) { const m = await DB.getMeta(e.id).catch(() => null); if (m) await DB.putMeta({ ...m, ...fields }).catch(() => {}); }
  if (e.cloud && signedIn()) {
    const send = { ...fields }; if ("deleted" in send) send.deleted = !!send.deleted;
    await Sync.patchDoc(e.id, send).catch(err => toast("Couldn't update your account: " + err.message));
  }
}
async function loadEntries() {
  let local = []; try { local = (await DB.list()).filter(m => m.id !== "__lib"); } catch (e) {}
  const lib = await localLib();
  let remote = null;
  if (signedIn()) { try { remote = await Sync.listDocs(); } catch (e) {} }
  const byId = new Map();
  for (const m of local) byId.set(m.id, { ...m, local: true });
  if (remote) {
    for (const r of remote.docs || []) {
      const l = byId.get(r.id);
      const e = { ...r, ...(l || {}), cloud: true, local: !!l, size: Math.max(l?.size || 0, (r.size || 0) + (r.data || 0)),
        name: r.name || l?.name, folder: r.folder ?? null, star: !!r.star, deleted: r.deleted || null, flags: r.flags ?? l?.flags,
        updated: Math.max(l?.updated || 0, r.updated || 0), opened: Math.max(l?.opened || 0, r.opened || 0), pdf: r.pdf || l?.pdf || r.id };
      // carry this device's folder/star across the first time a paper reaches the account
      if (l && r.folder == null && l.folder) { e.folder = l.folder; Sync.patchDoc(r.id, { folder: l.folder }).catch(() => {}); }
      if (l && !r.star && l.star) { e.star = true; Sync.patchDoc(r.id, { star: true }).catch(() => {}); }
      byId.set(r.id, e);
    }
    Home.used = remote.used || 0; Home.quota = remote.quota;
    // folders: merge this device's folders into the account once
    let folders = remote.folders || []; Home.foldersVer = remote.foldersVer || 0;
    const missing = lib.folders.filter(f => !folders.some(g => g.id === f.id));
    if (missing.length) { folders = folders.concat(missing); Home.folders = folders; await saveFolders(folders); }
    Home.folders = folders;
    await DB.putMeta({ id: "__lib", folders }).catch(() => {});
  } else Home.folders = lib.folders;
  Home.entries = [...byId.values()];
  if (Home.folder && !Home.folders.some(f => f.id === Home.folder)) Home.folder = null;
}

// ---------------- rendering ----------------
let renderSeq = 0;
async function renderHomeList() {
  const my = ++renderSeq;
  await loadEntries();
  if (my !== renderSeq) return;
  renderStorage();
  const q = $("#search").value.trim().toLowerCase();
  $("#sortSel").value = prefs.sort; $("#filterSel").value = prefs.filter;
  const bin = prefs.filter === "bin";
  const folderPath = id => { const out = []; let f = Home.folders.find(x => x.id === id); let guard = 0; while (f && guard++ < 50) { out.unshift(f); f = Home.folders.find(x => x.id === f.parent); } return out; };
  // breadcrumbs
  const crumbs = $("#crumbs"); crumbs.innerHTML = "";
  const addCrumb = (label, id) => { const b = document.createElement("button"); b.textContent = label; b.className = "crumb"; b.onclick = () => { Home.folder = id; renderHomeList(); }; dropTarget(b, id); crumbs.appendChild(b); };
  addCrumb(bin ? "Bin" : "All papers", null);
  if (!bin && !q) for (const f of folderPath(Home.folder)) { crumbs.append(" › "); addCrumb(f.name, f.id); }
  // which papers to show
  let list = Home.entries.filter(e => bin ? !!e.deleted : !e.deleted);
  if (q) list = list.filter(e => (e.name || "").toLowerCase().includes(q));
  else if (!bin) list = list.filter(e => (e.folder || null) === Home.folder || (e.folder && !Home.folders.some(f => f.id === e.folder) && Home.folder === null));
  const prog = e => e.total ? (e.filled || 0) / e.total : 0;
  if (prefs.filter === "star") list = list.filter(e => e.star);
  if (prefs.filter === "flag") list = list.filter(e => e.flags > 0);
  if (prefs.filter === "new") list = list.filter(e => !e.filled);
  if (prefs.filter === "doing") list = list.filter(e => e.filled && e.filled < e.total);
  if (prefs.filter === "done") list = list.filter(e => e.total && e.filled >= e.total);
  const cmp = { opened: (a, b) => Math.max(b.opened || 0, b.updated || 0) - Math.max(a.opened || 0, a.updated || 0), updated: (a, b) => (b.updated || 0) - (a.updated || 0), name: (a, b) => (a.name || "").localeCompare(b.name || "", undefined, { numeric: true }), size: (a, b) => (b.size || 0) - (a.size || 0), progress: (a, b) => prog(b) - prog(a) }[prefs.sort];
  list.sort((a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0) || cmp(a, b));
  // folders in this folder
  const fl = $("#folderList"); fl.innerHTML = "";
  if (!q && !bin && prefs.filter === "all") {
    const sub = Home.folders.filter(f => (f.parent || null) === Home.folder).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const f of sub) fl.appendChild(folderRow(f));
  }
  const ul = $("#recent"); ul.innerHTML = "";
  for (const e of list) ul.appendChild(paperRow(e, q ? folderPath(e.folder).map(f => f.name).join(" › ") : ""));
  const any = Home.entries.length || Home.folders.length;
  $("#recentWrap").hidden = !any && !signedIn();
  $("#emptyLib").textContent = list.length || fl.children.length ? "" : bin ? "The bin is empty. Papers you delete stay here for 30 days." : q ? "No papers match that search." : prefs.filter !== "all" ? "Nothing matches this filter." : Home.folder ? "This folder is empty. Open a PDF while you're here, or drag papers onto it." : "No papers yet. Open a PDF to start.";
  $("#emptyBin").hidden = !bin || !list.length;
}
function folderStats(id) {
  const ids = new Set([id]); let grew = true;
  while (grew) { grew = false; for (const f of Home.folders) if (f.parent && ids.has(f.parent) && !ids.has(f.id)) { ids.add(f.id); grew = true; } }
  const docs = Home.entries.filter(e => !e.deleted && ids.has(e.folder));
  return { n: docs.length, size: docs.reduce((s, e) => s + (e.size || 0), 0), sub: ids.size - 1 };
}
function folderRow(f) {
  const li = document.createElement("li"); li.className = "folder";
  const st = folderStats(f.id);
  li.innerHTML = `<button class="fopen" aria-label="Open folder ${esc(f.name)}"><svg viewBox="0 0 24 24" class="ficon"><path d="M3 6h7l2 2h9v11H3z"/></svg><span class="nm"><b>${esc(f.name)}</b><small>${st.n} paper${st.n === 1 ? "" : "s"}${st.sub ? ` · ${st.sub} folder${st.sub === 1 ? "" : "s"}` : ""}${st.size ? " · " + fmtBytes(st.size) : ""}</small></span></button><button class="more" aria-label="Folder options">⋯</button>`;
  $(".fopen", li).onclick = () => { Home.folder = f.id; renderHomeList(); };
  $(".more", li).onclick = ev => menu(ev.currentTarget, [
    ["Rename", () => askName("Rename folder", f.name, async n => { f.name = n; await saveFolders(Home.folders); renderHomeList(); })],
    ["Move to…", () => pickFolder(`Move "${f.name}" to`, f.id, async dest => { f.parent = dest; await saveFolders(Home.folders); renderHomeList(); })],
    ["Delete folder", async () => {
      // papers and sub-folders move up a level; nothing inside is deleted
      for (const g of Home.folders) if (g.parent === f.id) g.parent = f.parent || null;
      for (const e of Home.entries) if (e.folder === f.id) await setMeta(e, { folder: f.parent || null });
      await saveFolders(Home.folders.filter(g => g.id !== f.id)); toast(`Folder deleted. Its contents moved up a level.`); renderHomeList();
    }],
  ]);
  dropTarget(li, f.id);
  return li;
}
function paperRow(e, path) {
  const li = document.createElement("li"); li.className = "paper"; li.draggable = !e.deleted;
  const pct = e.total ? Math.round((e.filled || 0) / e.total * 100) : 0;
  const where = e.cloud && e.local ? "synced" : e.cloud ? "in your account" : "this device";
  const bits = [`${e.pages || "?"} pages`, `${e.filled || 0}/${e.total ?? "?"} answered`];
  if (e.flags) bits.push(`⚑ ${e.flags}`);
  if (e.size) bits.push(fmtBytes(e.size));
  bits.push(e.deleted ? "deleted " + ago(e.deleted) : "opened " + ago(Math.max(e.opened || 0, e.updated || 0)));
  bits.push(where);
  li.innerHTML = `<button class="star${e.star ? " on" : ""}" aria-label="${e.star ? "Unstar" : "Star"}" title="Star (starred papers stay at the top)">${e.star ? "★" : "☆"}</button>
    <div class="nm"><b></b><small>${esc(bits.join(" · "))}${path ? " · in " + esc(path) : ""}</small><span class="prog"><i style="width:${pct}%"></i></span></div>
    ${e.deleted ? `<button class="restore">Restore</button><button class="purge danger">Delete forever</button>` : `<button class="open">Open</button><button class="more" aria-label="Paper options">⋯</button>`}`;
  $("b", li).textContent = e.name || "Untitled";
  $(".star", li).onclick = async () => { await setMeta(e, { star: !e.star }); renderHomeList(); };
  if (e.deleted) {
    $(".restore", li).onclick = async () => { await setMeta(e, { deleted: null }); toast("Restored."); renderHomeList(); };
    $(".purge", li).onclick = ev => confirmInline(ev.currentTarget, "Delete for good?", async () => { await purge(e); renderHomeList(); });
    return li;
  }
  $(".nm", li).onclick = () => openStored(e.id, e);
  $(".open", li).onclick = () => openStored(e.id, e);
  $(".more", li).onclick = ev => menu(ev.currentTarget, [
    ["Rename", () => askName("Rename paper", e.name, async n => { await setMeta(e, { name: n }); const d = e.local && await DB.get(e.id).catch(() => null); if (d) { d.name = n; await DB.put(d); } renderHomeList(); })],
    ["Move to…", () => pickFolder(`Move "${e.name}" to`, null, async dest => { await setMeta(e, { folder: dest }); renderHomeList(); })],
    ["New attempt (blank copy)", () => duplicate(e)],
    e.local ? ["Download backup", async () => { const d = await DB.get(e.id); if (d) downloadBackup(d); }] : null,
    ["Move to bin", async () => { await setMeta(e, { deleted: Date.now() }); toast("Moved to the bin. Restore it from Filter → Bin within 30 days."); renderHomeList(); }],
  ].filter(Boolean));
  li.addEventListener("dragstart", ev => { ev.dataTransfer.setData("text/x-typepdf", e.id); ev.dataTransfer.effectAllowed = "move"; li.classList.add("dragging"); });
  li.addEventListener("dragend", () => li.classList.remove("dragging"));
  return li;
}
function dropTarget(el, folderId) {
  el.addEventListener("dragover", ev => { if ([...ev.dataTransfer.types].includes("text/x-typepdf")) { ev.preventDefault(); el.classList.add("over"); } });
  el.addEventListener("dragleave", () => el.classList.remove("over"));
  el.addEventListener("drop", async ev => {
    const id = ev.dataTransfer.getData("text/x-typepdf"); el.classList.remove("over"); if (!id) return;
    ev.preventDefault(); ev.stopPropagation();
    const e = Home.entries.find(x => x.id === id); if (!e) return;
    await setMeta(e, { folder: folderId }); toast("Moved."); renderHomeList();
  });
}
async function purge(e) {
  if (e.local) { await DB.del(e.id).catch(() => {}); try { localStorage.removeItem("view:" + e.id); } catch (x) {} }
  if (e.cloud && signedIn()) await Sync.deleteDoc(e.id, true).catch(err => toast(err.message));
}
async function duplicate(e) {
  let src = await DB.get(e.id).catch(() => null);
  let bytes = src && src.bytes;
  if (!bytes && signedIn()) { busy(true, "Downloading…"); bytes = await Sync.getPdf(e.pdf || e.id).catch(() => null); busy(false); }
  if (!bytes) { toast("Open the paper once on this device first."); return; }
  const n = Home.entries.filter(x => (x.pdf || x.id) === (e.pdf || e.id)).length + 1;
  const id = hexId(), name = `${(e.name || "Untitled").replace(/ \(attempt \d+\)$/, "")} (attempt ${n})`;
  const d = newDoc(id, e.pdf || e.id, name, bytes);
  if (src && src.pages) d.pages = JSON.parse(JSON.stringify(src.pages.map(P => P && ({ ...P, gaps: {}, regions: P.regions.map(({ _el, ...r }) => r) }))));
  if (src && src.font) d.font = src.font;
  await DB.put(d); await DB.putMeta({ id, name, pdf: d.pdf, folder: e.folder || null, pages: d.pages.length, filled: 0, total: d.pages.reduce((s, P) => s + (P ? P.regions.length : 0), 0), updated: Date.now(), size: docSize(d), local: true });
  if (signedIn()) await Sync.createDoc({ id, name, pdf: d.pdf, folder: e.folder || null }).catch(() => {});
  toast(`Made "${name}". Your first attempt is unchanged.`); renderHomeList();
}

// ---------------- storage bar ----------------
async function renderStorage() {
  const el = $("#storage"); let used = 0, limit = 0, label = "";
  if (signedIn()) {
    const info = await Sync.refreshInfo() || {};
    if (info.admin) {
      limit = info.globalLimit || 0;
      if (info.cf && info.cf.used != null) { used = info.cf.used; label = `Cloudflare account (all your Workers): ${fmtBytes(used)} of ${fmtBytes(limit)} used · ${fmtBytes(Math.max(0, limit - used))} left · TypePDF users: ${fmtBytes(info.globalUsed || 0)} · you: ${fmtBytes(Home.used || info.used || 0)}, no limit`; }
      else { used = info.globalUsed || 0; label = `TypePDF users: ${fmtBytes(used)} of the account's ${fmtBytes(limit)} · you: ${fmtBytes(Home.used || info.used || 0)}, no limit · other Workers' storage isn't counted (connect it in Admin)`; }
    }
    else { used = Home.used || info.used || 0; limit = info.quota > 0 ? info.quota : 0; label = `Your storage: ${fmtBytes(used)} of ${fmtBytes(limit)} used · ${fmtBytes(Math.max(0, limit - used))} left`; }
  } else if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate().catch(() => ({}));
    used = est.usage || 0; limit = est.quota || 0;
    label = `On this device: ${fmtBytes(used)} used${limit ? ` of ${fmtBytes(limit)} the browser allows this site` : ""}. Sign in to keep papers in your account.`;
  }
  el.hidden = !label;
  const frac = limit ? Math.min(1, used / limit) : 0;
  $("#storageTxt").textContent = label;
  const bar = $("#storageBar i"); bar.style.width = (frac * 100).toFixed(1) + "%";
  el.dataset.level = frac > 0.95 ? "full" : frac > 0.8 ? "high" : "ok";
}

// ---------------- small UI pieces ----------------
function menu(anchor, items) {
  closeMenu();
  const m = document.createElement("div"); m.className = "menu"; m.id = "menu"; m.setAttribute("role", "menu");
  for (const [label, fn] of items) { const b = document.createElement("button"); b.textContent = label; b.setAttribute("role", "menuitem"); b.onclick = () => { closeMenu(); fn(); }; m.appendChild(b); }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = Math.min(window.innerHeight - m.offsetHeight - 8, r.bottom + 4) + "px";
  m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth)) + "px";
  m.querySelector("button").focus();
}
function closeMenu() { const m = $("#menu"); if (m) m.remove(); }
document.addEventListener("pointerdown", e => { const m = $("#menu"); if (m && !m.contains(e.target)) closeMenu(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenu(); });
function confirmInline(btn, q, fn) {
  const c = document.createElement("span"); c.className = "confirmdel"; c.innerHTML = `${esc(q)} <button>Yes</button><button>No</button>`;
  const [y, n] = $$("button", c); y.onclick = fn; n.onclick = () => c.replaceWith(btn); btn.replaceWith(c);
}
function askName(title, value, done) {
  const d = $("#nameDlg"); $("#nameTitle").textContent = title; $("#nameIn").value = value || ""; $("#nameErr").textContent = "";
  d.showModal(); $("#nameIn").select();
  $("#nameForm").onsubmit = ev => { ev.preventDefault(); const v = $("#nameIn").value.trim(); if (!v) { $("#nameErr").textContent = "Give it a name."; return; } d.close(); done(v.slice(0, 80)); };
}
$("#nameCancel").onclick = () => $("#nameDlg").close();
function pickFolder(title, movingFolder, done) {
  const d = $("#moveDlg"); $("#moveTitle").textContent = title; const list = $("#moveList"); list.innerHTML = "";
  const banned = new Set(); if (movingFolder) { banned.add(movingFolder); let grew = true; while (grew) { grew = false; for (const f of Home.folders) if (f.parent && banned.has(f.parent) && !banned.has(f.id)) { banned.add(f.id); grew = true; } } }
  const add = (label, id, depth) => { const b = document.createElement("button"); b.style.paddingLeft = 12 + depth * 18 + "px"; b.textContent = label; b.disabled = banned.has(id); b.onclick = () => { d.close(); done(id); }; list.appendChild(b); };
  add("All papers (top level)", null, 0);
  const walk = (parent, depth) => Home.folders.filter(f => (f.parent || null) === parent).sort((a, b) => a.name.localeCompare(b.name)).forEach(f => { add("📁 " + f.name, f.id, depth); walk(f.id, depth + 1); });
  walk(null, 1);
  d.showModal();
}
$("#moveCancel").onclick = () => $("#moveDlg").close();

// ---------------- toolbar ----------------
$("#newFolder").onclick = () => askName("New folder", "", async n => { const f = { id: "f" + hexId().slice(0, 12), name: n, parent: prefs.filter === "bin" ? null : Home.folder }; await saveFolders([...Home.folders, f]); renderHomeList(); });
let searchT; $("#search").addEventListener("input", () => { clearTimeout(searchT); searchT = setTimeout(renderHomeList, 150); });
$("#sortSel").onchange = e => { prefs.sort = e.target.value; savePrefs(); renderHomeList(); };
$("#filterSel").onchange = e => { prefs.filter = e.target.value; savePrefs(); renderHomeList(); };
$("#emptyBin").onclick = ev => confirmInline(ev.currentTarget, "Delete everything in the bin for good?", async () => { for (const e of Home.entries.filter(x => x.deleted)) await purge(e); renderHomeList(); });

// ---------------- paste button (no keyboard needed) ----------------
$("#pasteBtn").onclick = async () => {
  try {
    if (navigator.clipboard && navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const t = it.types.find(t => /pdf/i.test(t));
        if (t) { const blob = await it.getType(t); return openFile(new File([blob], "Pasted paper.pdf", { type: "application/pdf" })); }
      }
      for (const it of items) for (const t of it.types) if (/text\/(plain|uri-list)/.test(t)) { const s = (await (await it.getType(t)).text()).trim(); if (/^https?:\/\/\S+$/i.test(s)) return openLink(s); }
    }
  } catch (e) { /* permission refused or unsupported — fall back to the paste box */ }
  $("#pasteDlg").showModal(); setTimeout(() => $("#pasteZone").focus(), 50);
};
$("#pasteZone").addEventListener("paste", () => setTimeout(() => { $("#pasteDlg").close(); $("#pasteZone").textContent = ""; }, 0));
$("#pasteZone").addEventListener("input", () => {   // a link typed or pasted as text
  const s = $("#pasteZone").textContent.trim(); if (/^https?:\/\/\S+$/i.test(s)) { $("#pasteDlg").close(); $("#pasteZone").textContent = ""; openLink(s); }
});
$("#pasteCancel").onclick = () => $("#pasteDlg").close();
// drop a PDF anywhere on the home screen
$("#home").addEventListener("dragover", e => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); $("#home").classList.add("over"); } });
$("#home").addEventListener("dragleave", e => { if (e.target === $("#home")) $("#home").classList.remove("over"); });
$("#home").addEventListener("drop", e => { $("#home").classList.remove("over"); const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) { e.preventDefault(); openFile(f); } });

// ---------------- admin ----------------
window.openAdmin = async function openAdmin() {
  const d = $("#adminDlg"); d.showModal(); $("#adminBody").innerHTML = "<p class='note'>Loading…</p>";
  try { renderAdmin(await Sync.admin.overview()); } catch (e) { $("#adminBody").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
};
$("#adminClose").onclick = () => $("#adminDlg").close();
function quotaSelect(choices, value) { return `<select>${choices.map(c => `<option value="${c}"${c === value ? " selected" : ""}>${fmtBytes(c)}</option>`).join("")}</select>`; }
function renderAdmin(o) {
  const body = $("#adminBody");
  const cf = o.cf || {}, real = cf.used != null ? cf.used : null, shown = real != null ? real : o.globalUsed, f2 = o.globalLimit ? shown / o.globalLimit : 0;
  const cfNote = real != null ? `Cloudflare reports ${fmtBytes(real)} used across your whole account${cf.date ? " (as of " + cf.date + ")" : ""}, including any other Workers.`
    : cf.configured ? `Couldn't read your Cloudflare usage${cf.error ? ": " + esc(cf.error) : ""}. Check the API token has "Account Analytics: Read".`
    : `This only counts TypePDF. To see the real storage left on your Cloudflare account (shared with your other Workers), add two secrets to this Worker in the Cloudflare dashboard: <b>CF_ACCOUNT_ID</b> and <b>CF_API_TOKEN</b> (a token with "Account Analytics: Read"). Steps are in the README.`;
  body.innerHTML = `<div class="storage" data-level="${f2 > 0.95 ? "full" : f2 > 0.8 ? "high" : "ok"}"><div class="sbar"><i style="width:${(Math.min(1, f2) * 100).toFixed(1)}%"></i></div><span>${real != null ? "Whole account" : "TypePDF"}: ${fmtBytes(shown)} of ${fmtBytes(o.globalLimit)} used · ${fmtBytes(Math.max(0, o.globalLimit - shown))} left · TypePDF users: ${fmtBytes(o.globalUsed)}</span></div>
    <p class="note">${cfNote}</p>
    <label class="inline">New accounts get ${quotaSelect(o.choices, o.defaultQuota)}</label>
    <div class="users"></div>`;
  $("label.inline select", body).onchange = async ev => { await Sync.admin.setDefault(+ev.target.value).catch(e => toast(e.message)); toast("Default updated."); openAdmin(); };
  const host = $(".users", body);
  for (const u of o.users) {
    const row = document.createElement("div"); row.className = "urow";
    const f = u.quota > 0 ? Math.min(1, u.used / u.quota) : 0;
    row.innerHTML = `<div class="uhead"><b>${esc(u.user)}</b>${u.admin ? ' <em class="adm">admin</em>' : ""}<small>joined ${new Date(u.created).toLocaleDateString()} · ${fmtBytes(u.used)}${u.quota > 0 ? " of " + fmtBytes(u.quota) : " · no limit"}</small></div>
      ${u.quota > 0 ? `<div class="sbar"><i style="width:${(f * 100).toFixed(1)}%"></i></div>` : ""}
      <div class="uact">${u.admin ? "" : `<label>Space ${quotaSelect(o.choices, u.quota)}</label>`}<button class="files">Files</button>${u.admin ? "" : `<button class="del danger">Delete account</button>`}</div><ul class="ufiles" hidden></ul>`;
    const sel = $("select", row); if (sel) sel.onchange = async ev => { await Sync.admin.quota(u.user, +ev.target.value).catch(e => toast(e.message)); toast(`${u.user} now has ${fmtBytes(+ev.target.value)}.`); };
    $(".files", row).onclick = async () => {
      const ul = $(".ufiles", row); if (!ul.hidden) { ul.hidden = true; return; }
      ul.hidden = false; ul.innerHTML = "<li>Loading…</li>";
      try {
        const j = await Sync.admin.docs(u.user); ul.innerHTML = j.docs.length ? "" : "<li>No papers.</li>";
        for (const dd of j.docs) {
          const li = document.createElement("li");
          li.innerHTML = `<span>${esc(dd.name)}<small>${fmtBytes((dd.size || 0) + (dd.data || 0))} · ${dd.deleted ? "in bin" : "updated " + ago(dd.updated)}</small></span><button class="danger">Delete</button>`;
          $("button", li).onclick = ev => confirmInline(ev.currentTarget, "Delete for good?", async () => { await Sync.admin.deleteDoc(u.user, dd.id).catch(e => toast(e.message)); li.remove(); });
          ul.appendChild(li);
        }
      } catch (e) { ul.innerHTML = `<li class="err">${esc(e.message)}</li>`; }
    };
    const del = $(".del", row); if (del) del.onclick = ev => confirmInline(ev.currentTarget, `Delete ${u.user} and all their papers?`, async () => { await Sync.admin.deleteUser(u.user).catch(e => toast(e.message)); openAdmin(); });
    host.appendChild(row);
  }
}

window.addEventListener("focus", () => { if (!$("#home").hidden) renderHomeList(); });
renderHomeList();
