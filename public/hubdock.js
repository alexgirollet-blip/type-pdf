// hubdock.js — a small round GirolletServer button that's always on screen and takes you back to the hub.
// Drag it to any corner of the screen and it stays there on this device. Used by Girolibrary and TypePDF.
//   HubDock.init('https://girolletserver.com')
"use strict";
(() => {
  const KEY = "hubdock-corner";
  const CORNERS = ["bl", "br", "tl", "tr"];
  const css = `
#hubdock{position:fixed;z-index:2147483000;display:flex;align-items:center;gap:0;height:42px;min-width:42px;padding:0;border-radius:999px;
  background:#0b0a08;color:#f3ead3;text-decoration:none;font:600 13px/1 Inter,system-ui,-apple-system,sans-serif;
  box-shadow:0 0 0 1px #d4af3766,0 6px 18px rgba(0,0,0,.35);opacity:.9;transition:opacity .15s,box-shadow .15s,padding .18s;touch-action:none;
  -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;cursor:pointer}
#hubdock:hover,#hubdock:focus-visible{opacity:1;box-shadow:0 0 0 1.5px #d4af37,0 8px 22px rgba(0,0,0,.45);outline:none;padding-right:14px}
#hubdock .g{width:42px;height:42px;flex:none;display:grid;place-items:center;font:700 22px Georgia,'Times New Roman',serif;color:#d4af37}
#hubdock .t{max-width:0;overflow:hidden;white-space:nowrap;transition:max-width .2s}
#hubdock:hover .t,#hubdock:focus-visible .t{max-width:180px}
#hubdock.bl{left:max(12px,env(safe-area-inset-left));bottom:max(12px,env(safe-area-inset-bottom))}
#hubdock.br{right:max(12px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom))}
#hubdock.tl{left:max(12px,env(safe-area-inset-left));top:max(12px,env(safe-area-inset-top))}
#hubdock.tr{right:max(12px,env(safe-area-inset-right));top:max(12px,env(safe-area-inset-top))}
#hubdock.dragging{transition:none;opacity:1;cursor:grabbing}
/* Girolibrary's app mode on a phone: sit above the dock */
@media (max-width:640px){body.appmode #hubdock.bl,body.appmode #hubdock.br{bottom:calc(19vh + env(safe-area-inset-bottom))}}
@media print{#hubdock{display:none}}`;

  function corner() {
    try { const c = localStorage.getItem(KEY); if (CORNERS.includes(c)) return c; } catch (e) {}
    return "bl";
  }

  function init(url) {
    if (!url || document.getElementById("hubdock")) return;
    let href;
    try { href = new URL(url, location.href).toString(); } catch (e) { return; }
    const st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
    const a = document.createElement("a");
    a.id = "hubdock";
    a.href = href;
    a.className = corner();
    a.title = "Back to GirolletServer (drag to move)";
    a.setAttribute("aria-label", "Back to the GirolletServer hub");
    a.innerHTML = '<span class="g" aria-hidden="true">G</span><span class="t">GirolletServer</span>';
    document.body.appendChild(a);

    // drag anywhere, let go and it snaps to the nearest corner
    let start = null, moved = false;
    a.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY };
      moved = false;
      try { a.setPointerCapture(e.pointerId); } catch (err) {}
    });
    a.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 8) return;
      moved = true;
      a.classList.add("dragging");
      const w = a.offsetWidth, h = a.offsetHeight;
      a.className = "dragging";
      a.style.left = Math.max(4, Math.min(innerWidth - w - 4, e.clientX - w / 2)) + "px";
      a.style.top = Math.max(4, Math.min(innerHeight - h - 4, e.clientY - h / 2)) + "px";
    });
    const end = (e) => {
      if (!start) return;
      start = null;
      if (!moved) return;
      const c = (e.clientY < innerHeight / 2 ? "t" : "b") + (e.clientX < innerWidth / 2 ? "l" : "r");
      a.style.left = a.style.top = "";
      a.className = c;
      try { localStorage.setItem(KEY, c); } catch (err) {}
    };
    a.addEventListener("pointerup", end);
    a.addEventListener("pointercancel", end);
    // a drag shouldn't count as a click
    a.addEventListener("click", (e) => { if (moved) { e.preventDefault(); moved = false; } });
  }

  window.HubDock = { init };
})();
