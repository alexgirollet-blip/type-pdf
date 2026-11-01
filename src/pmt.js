// Past paper finder: searches Physics & Maths Tutor's (physicsandmathstutor.com) A-level past paper pages.
//
// PMT has no search API, so this reads its own listing pages, only as far as a search needs:
//   1. the past papers page          → A-level subjects
//   2. the subject that matches      → its exam boards / papers (followed one more level if needed)
//   3. the pages that match          → the PDFs, filtered by year, series and paper type
// Every page read is cached (in memory and in Cloudflare's cache) for a day, so repeated searches cost nothing
// and PMT sees very little traffic. The PDF itself is then opened through /api/fetch-pdf like any link.

const ROOT = "https://www.physicsandmathstutor.com/past-papers/";
const SITE = /(^|\.)physicsandmathstutor\.com$/i;
const UA = "Mozilla/5.0 (compatible; TypePDF past paper finder; +https://typepdf.girolletserver.com)";
const TTL = 24 * 3600;
const mem = new Map();   // url → { at, links }

const decode = s => s.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;|&#160;/g, " ").replace(/&#8211;|&ndash;/g, "–").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n));
const clean = s => decode(String(s || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

// every link on a page: { href (absolute), text }
async function links(pageUrl) {
  const hit = mem.get(pageUrl);
  if (hit && Date.now() - hit.at < TTL * 1000) return hit.links;
  const cache = typeof caches !== "undefined" ? caches.default : null, key = new Request("https://typepdf-cache/pmt?u=" + encodeURIComponent(pageUrl));
  if (cache) { const c = await cache.match(key).catch(() => null); if (c) { const l = await c.json(); mem.set(pageUrl, { at: Date.now(), links: l }); return l; } }
  const r = await fetch(pageUrl, { headers: { "user-agent": UA, accept: "text/html" }, redirect: "follow", cf: { cacheTtl: TTL } });
  if (!r.ok) throw new Error(`Physics & Maths Tutor answered ${r.status}${r.status === 403 ? " (it may be blocking automatic look-ups right now)" : ""}.`);
  const html = await r.text(), out = [], seen = new Set();
  const re = /<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href; try { href = new URL(decode(m[1]), r.url || pageUrl).toString(); } catch { continue; }
    if (seen.has(href)) continue; seen.add(href);
    out.push({ href, text: clean(m[2]).slice(0, 160) });
  }
  mem.set(pageUrl, { at: Date.now(), links: out });
  if (cache) await cache.put(key, new Response(JSON.stringify(out), { headers: { "content-type": "application/json", "cache-control": `max-age=${TTL}` } })).catch(() => {});
  return out;
}

const isPdf = h => /\.pdf(\?|$)/i.test(h) && SITE.test(new URL(h).hostname);
const samePmt = h => { try { return SITE.test(new URL(h).hostname); } catch { return false; } };
const slugWords = h => decodeURIComponent(new URL(h).pathname).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// words people use → words on PMT's pages
const ALIASES = {
  maths: "mathematics math", math: "maths mathematics", mathematics: "maths", further: "further", fm: "further maths mathematics",
  cs: "computer science computing", computing: "computer science", compsci: "computer science", comp: "computer",
  chem: "chemistry", bio: "biology", phys: "physics", econ: "economics", eco: "economics", psych: "psychology", geog: "geography",
  english: "english", lit: "literature", lang: "language", bus: "business", stats: "statistics", mech: "mechanics",
  edexcel: "edexcel pearson", pearson: "edexcel", cie: "cie cambridge caie", caie: "cie cambridge", ocr: "ocr", aqa: "aqa", wjec: "wjec eduqas", eduqas: "eduqas wjec",
};
const BOARDS = ["aqa", "ocr", "edexcel", "pearson", "wjec", "eduqas", "cie", "caie", "cambridge", "ccea", "iaal", "ial", "international"];
const NUM_WORDS = { one: "1", two: "2", three: "3", four: "4" };

function parseQuery(q) {
  const raw = String(q || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const words = raw.split(" ").filter(Boolean).map(w => NUM_WORDS[w] || w);
  const year = (raw.match(/\b(19[89]\d|20[0-4]\d)\b/) || [])[1] || "";
  const type = /\b(ms|mark ?schemes?|marks?|answers?)\b/.test(raw) ? "ms" : /\b(er|examiner|reports?)\b/.test(raw) ? "er" : /\b(qp|question ?papers?|questions?)\b/.test(raw) ? "qp" : "";
  const series = (raw.match(/\b(june|jun|summer|may|november|nov|october|oct|january|jan|winter|specimen|sample|sams?)\b/) || [])[1] || "";
  const paper = (raw.match(/\b(?:paper|p|component|comp|unit)\s?(\d{1,2}[a-z]?)\b/) || [])[1] || "";
  const ignore = new Set(["a", "level", "alevel", "as", "past", "paper", "papers", "pmt", "the", "and", "for", "of", "qp", "ms", "mark", "scheme", "schemes", "question", "questions", "er", "examiner", "report", "reports", year, series, paper, "p" + paper, "component", "unit", "pdf"]);
  const topic = words.filter(w => !ignore.has(w) && !/^\d+$/.test(w));
  return { raw, words, year, type, series, paper, topic };
}
const expand = w => (w + " " + (ALIASES[w] || "")).trim().split(" ");
// how well some text matches the topic words (subject, board …)
function score(text, topic) {
  const t = " " + text.toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  let s = 0;
  for (const w of topic) { if (expand(w).some(x => x && t.includes(" " + x + " "))) s += 2; else if (w.length > 3 && t.includes(w)) s += 1; }
  return s;
}

// the A-level subjects PMT lists: [{ name, href }]
export async function pmtSubjects() {
  const root = await links(ROOT), seen = new Set();
  return root.filter(l => samePmt(l.href) && /a-level/i.test(l.href + " " + l.text) && !isPdf(l.href) && new URL(l.href).pathname.replace(/\/$/, "") !== new URL(ROOT).pathname.replace(/\/$/, ""))
    .map(l => ({ name: (l.text || slugWords(l.href)).replace(/\s*past papers?$/i, "").trim(), href: l.href }))
    .filter(x => x.name && !seen.has(x.href) && seen.add(x.href));
}

// tags for a PDF from its address and the page it was listed on
const BOARD_NAMES = [[/^ocr[\s-]?a$/i, "OCR A"], [/^ocr[\s-]?b$/i, "OCR B"], [/^ocr/i, "OCR"], [/^aqa/i, "AQA"], [/^(edexcel|pearson)/i, "Edexcel"], [/^(ial|iaal|international)/i, "Edexcel IAL"], [/^wjec/i, "WJEC"], [/^eduqas/i, "Eduqas"], [/^(cie|caie|cambridge)/i, "CIE"], [/^ccea/i, "CCEA"]];
const boardOf = s => { for (const [re, n] of BOARD_NAMES) if (re.test(s)) return n; return ""; };
function tagsFor(url, text, where) {
  const path = decodeURIComponent(new URL(url).pathname), file = path.split("/").pop().replace(/\.pdf$/i, "");
  const segs = path.split("/").filter(Boolean), all = (path + " " + text + " " + where).toLowerCase();
  let board = ""; for (const sg of segs) { board = boardOf(sg); if (board) break; }
  if (!board) for (const w of where.split(/[\s·-]+/)) { board = boardOf(w); if (board) break; }
  const pseg = segs.find(sg => /^(paper|component|unit|module)[-\s]?\d/i.test(sg)) || (where.match(/\b(paper|component|unit|module)\s?\d{1,2}[a-z]?\b/i) || [])[0] || "";
  const paper = pseg.replace(/[-_]+/g, " ").replace(/\s+/g, " ").replace(/\b\w/, c => c.toUpperCase()).trim();
  const year = (file.match(/\b(19[89]\d|20[0-4]\d)\b/) || text.match(/\b(19[89]\d|20[0-4]\d)\b/) || [])[1] || "";
  const kind = /\bms\b|mark ?scheme/.test(all) ? "Mark scheme" : /\ber\b|examiner/.test(all) ? "Examiner report" : /\bqp\b|question paper/.test(all) ? "Question paper" : /insert|data ?sheet|formula/.test(all) ? "Insert" : "Other";
  const sm = (file + " " + text).toLowerCase().match(/\b(june|jun|may|november|nov|october|oct|january|jan|specimen|sample|sams?)\b/);
  const series = sm ? ({ jun: "June", june: "June", may: "June", nov: "November", november: "November", oct: "October", october: "October", jan: "January", january: "January" }[sm[1]] || "Specimen") : "";
  return { board, paper, year, kind, series, file };
}

// search (free text, and/or a chosen subject): every PDF found, each with its tags. The words in the search that
// name a board, paper, year, series or type come back as `hints`, which the page turns into selected tags.
export async function pmtSearch(q, subjectHref) {
  const Q = parseQuery(q);
  const subjects = await pmtSubjects();
  if (!subjects.length) return { error: "Couldn't read Physics & Maths Tutor's list of subjects." };
  let subject = subjectHref && subjects.find(s => s.href === subjectHref);
  if (!subject) {
    if (!Q.raw) return { error: "Pick a subject or type a search, e.g. AQA physics paper 1 2019." };
    const subjTopic = Q.topic.filter(w => !BOARDS.includes(w));
    const ranked = subjects.map(sj => ({ sj, s: score(sj.name + " " + slugWords(sj.href), subjTopic) - (/further/.test(sj.name.toLowerCase() + slugWords(sj.href)) && !subjTopic.includes("further") && !subjTopic.includes("fm") ? 1 : 0) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
    if (!ranked.length) return { results: [], note: "Which subject? Pick one from the list, or include it in your search." };
    subject = ranked[0].sj;
  }
  // the subject's pages (boards, papers), and one more level down when a page only lists further pages
  let fetches = 0;
  const base = new URL(subject.href).pathname.replace(/\/?$/, "/"), pdfs = [];
  const collect = (ls, where) => { for (const l of ls) if (isPdf(l.href)) pdfs.push({ url: l.href, text: l.text, where }); };
  const sub = await links(subject.href); fetches++;
  collect(sub, "");
  const under = (ls, b) => ls.filter(l => samePmt(l.href) && !isPdf(l.href) && new URL(l.href).pathname.startsWith(b) && new URL(l.href).pathname.replace(/\/?$/, "/") !== b);
  const boardWords = Q.topic.filter(w => BOARDS.includes(w));
  const pageScore = l => {
    const t = (l.text + " " + slugWords(l.href)).toLowerCase(); let s = score(t, boardWords);
    if (Q.paper) { if (new RegExp(`\\b(paper|component|unit|p)\\s?0?${Q.paper}\\b`).test(t)) s += 3; else if (/\b(paper|component|unit)\s?\d/.test(t)) s -= 2; }
    return s;
  };
  // every page of the subject, best matches first, as far as the budget of page reads allows
  const pages = under(sub, base).map(l => ({ l, s: pageScore(l) })).sort((a, b) => b.s - a.s).slice(0, 24);
  for (const { l } of pages) {
    if (fetches >= 40) break;
    const ls = await links(l.href).catch(() => []); fetches++;
    const where = l.text || slugWords(l.href);
    collect(ls, where);
    if (!ls.some(x => isPdf(x.href))) {
      const more = under(ls, new URL(l.href).pathname.replace(/\/?$/, "/")).map(x => ({ x, s: pageScore(x) })).sort((a, b) => b.s - a.s).slice(0, 8);
      for (const { x } of more) { if (fetches >= 40) break; collect(await links(x.href).catch(() => []), where + " · " + (x.text || slugWords(x.href))); fetches++; }
    }
  }
  const subj = subject.name.replace(/^a[- ]level\s*/i, "").trim();
  const seen = new Set(), results = [];
  for (const p of pdfs) {
    if (seen.has(p.url)) continue; seen.add(p.url);
    const t = tagsFor(p.url, p.text, p.where);
    const label = p.text && p.text.length > 3 && !/^(download|pdf|here)$/i.test(p.text) ? p.text : t.file;
    results.push({ url: p.url, title: label, subject: subj, ...t, name: [t.board, subj, t.paper, t.series, t.year, t.kind !== "Other" ? t.kind : ""].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 110) || t.file });
  }
  const hints = { board: boardOf(Q.topic.find(w => BOARDS.includes(w)) || ""), year: Q.year, kind: { qp: "Question paper", ms: "Mark scheme", er: "Examiner report" }[Q.type] || "", series: { jun: "June", june: "June", summer: "June", may: "June", nov: "November", november: "November", oct: "October", october: "October", jan: "January", january: "January", winter: "January", specimen: "Specimen", sample: "Specimen", sam: "Specimen", sams: "Specimen" }[Q.series] || "", paper: Q.paper };
  return { subject: subj, subjectHref: subject.href, results, hints, partial: fetches >= 40 };
}

// only PMT's own downloads are fetched through the finder
export const isPmtPdf = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && SITE.test(x.hostname) && /\.pdf$/i.test(x.pathname); } catch { return false; } };
export const PMT_UA = UA;
