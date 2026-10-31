// fonts.js — the typefaces answers can be typed in. Each has a matching TTF so the exported PDF
// uses exactly the same letter shapes and widths as the screen. asc/desc are the font's own
// line metrics (fraction of the font size), used to sit text on the printed lines.
"use strict";
const FONTS = {
  arial:    { label: "Arial / Helvetica style", file: "LiberationSans-Regular.ttf",  asc: 0.9053, desc: 0.2119 },
  times:    { label: "Times New Roman style",   file: "LiberationSerif-Regular.ttf", asc: 0.8911, desc: 0.2163 },
  calibri:  { label: "Calibri style",           file: "Carlito-Regular.ttf",         asc: 0.9521, desc: 0.2686 },
  cambria:  { label: "Cambria style",           file: "Caladea-Regular.ttf",         asc: 0.9,    desc: 0.25 },
  clear:    { label: "Clear sans",              file: "DejaVuSans.ttf",              asc: 0.9282, desc: 0.2358 },
  readable: { label: "Easy to read",            file: "AtkinsonHyperlegible-Regular.ttf", asc: 0.95, desc: 0.29 },
  hand:     { label: "Handwriting",             file: "PatrickHand-Regular.ttf",     asc: 1.042,  desc: 0.312, scale: 1.12 },
  courier:  { label: "Courier style",           file: "LiberationMono-Regular.ttf",  asc: 0.8325, desc: 0.3003, scale: 0.92 },
};
const MONO = { file: "DejaVuSansMono.ttf", asc: 0.9282, desc: 0.2358 };
const FONT_DEFAULT = "clear";

// map a PDF font name (e.g. "ABCDEF+ArialMT", "TimesNewRomanPSMT") to the closest bundled font
function matchFont(name) {
  const n = String(name || "").replace(/^[A-Z]{6}\+/, "").toLowerCase();
  if (!n) return null;
  if (/arial|helvetica|liberationsans|arimo|nimbussans|swiss/.test(n)) return "arial";
  if (/times|tinos|liberationserif|nimbusrom|georgia|garamond|minion|palatino|book ?antiqua/.test(n)) return "times";
  if (/calibri|carlito|candara|corbel/.test(n)) return "calibri";
  if (/cambria|caladea|constantia/.test(n)) return "cambria";
  if (/courier|cousine|mono|consolas|lucidaconsole/.test(n)) return "courier";
  if (/verdana|tahoma|dejavu|segoe|trebuchet|frutiger|gill|open ?sans|roboto|noto ?sans|lato|source ?sans|myriad|univers|futura|avenir|century ?gothic/.test(n)) return "clear";
  if (/serif|roman|cmr\d|lmroman|sabon|baskerville|cmmi|cmsy/.test(n)) return "times";
  if (/sans|grotesk|gothic/.test(n)) return "arial";
  return null;
}

// inject @font-face rules once
(function () {
  const css = Object.entries(FONTS).map(([k, f]) => `@font-face{font-family:"TP-${k}";src:url(fonts/${f.file}) format("truetype");font-display:block}`).join("\n");
  const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
})();
