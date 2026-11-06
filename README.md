# TypePDF

Fill in any PDF paper in the browser. Open a PDF and TypePDF finds the answer spaces — dotted lines, ruled lines, underscores, empty table cells and answer boxes — so you can click and type straight onto them. Write or draw anywhere with a pen, mouse or Apple Pencil, then export a filled-in PDF.

## Features

- **Finds answer spaces automatically** from the page image and the text layer, so it works on most exam papers and on scans. Thin pale-grey answer lines are found wherever they fall on the pixel grid, graph paper and page frames are ignored, and short gaps in equations (including the mass and atomic numbers in nuclear equations) become answer spaces. Labelled lines ("Name …", "Description …") become separate spaces. Code answers (SQL, pseudocode, CSS) get a monospace font where Tab indents; a **</> Code** switch beside any answer (or just typing code) turns code mode on: no auto-capitals or corrections, Tab/Shift+Tab indent, and Enter keeps the indentation.
- **Typed text sits on the printed lines.** Long answers shrink a little, then fit two lines per printed line, and only then extend the page with extra writing lines. The page is never split through printed text.
- **Text, Pen and Smart tools**: Text only types, Pen only draws, Smart does both (tap to type, drag to draw). Laptops start on Text; iPads and devices where an Apple Pencil has been used start on Pen.
- **Perfect shapes**: draw a line, arrow, circle, ellipse, square, rectangle, triangle or other polygon and hold the pen (or mouse) still for half a second: it becomes the perfect shape (near-level edges are levelled). Keep moving before lifting to resize it evenly (a line's end follows the pen), with its length, angle or size shown in cm beside the pen.
- **Protractor with a ruler base** (📐): a semicircle marked 0–180° both ways on a ruler marked in cm and mm, true to the paper's size (an A4 paper measures 21 cm), so it measures printed diagrams. Drag to move; two fingers move, turn and pinch it longer or shorter all at once (or use the ⟳ and ↔ handles). Turning snaps to every 15° when close, and its length changes in half centimetres (15 cm → 30 cm and so on), markings staying true to the paper; and drag the red needle to read an angle. The Pencil draws straight through it; a stroke started on its straight edges draws a perfect line (with its length), and on its curved edge an arc.
- **Compass**: press where the point goes and drag out the radius (whole millimetres, shown as you go); let go to draw the circle.
- **Line of best fit**: select plotted crosses or dots with Select and press **Best-fit line** (or **Best-fit curve**).
- **Select and move drawings**: draw a box round any ink (mouse, finger or Pencil) and drag it anywhere, even to another page; Delete removes it and arrow keys nudge it. Undo works, and moves sync live.
- **Pen, highlighter and eraser** in four colours and three sizes, with undo/redo and Shift for straight lines. On an iPad the Pencil writes (lightly pressure-sensitive, with a hover preview) while fingers scroll and pinch to zoom; two-finger tap undoes, three-finger tap redoes, and two to four quick one-finger taps (or three quick taps of the Pencil) swap between the pen and the eraser (after rubbing something out, lifting the Pencil goes back to the pen). Mirroring a laptop screen to an iPad also works.
- **Multiple choice**: tick boxes, ovals and pills are found automatically (small closed outlines that come in lined-up groups, named by the letter or words beside them). Click or tap to choose, as many as you like; the export ticks boxes and fills ovals in, the AI export lists each question's options and the ones chosen, and a multiple-choice question counts once in progress and Go to. Boxes → Choice adds one that was missed. Options printed as plain letters with nothing to fill in (Save My Exams' **A.** 6%, **B.** 12% …) are found too: tap a letter and a thick blue circle goes round it, one answer per question (tap another letter to move it, tap the circled one to clear it), even when a question's options carry on over the page; the export draws the circle. On Save My Exams papers (topic practice, mocks, or one opened from your files) the letters are found by their own rules: only options lined up under each other count (a superscript "A" in the question doesn't), and each circle is centred on the letter's ink.
- **Answer colour and style**: typed answers (and choices) in black, blue, dark blue, red, green or purple, and plain, highlighted, bold, highlighted + bold or in a tinted box, set per paper, synced and used in the exported PDF.
- **Click to add a missed space**: with Text, clicking blank paper away from any answer space looks there again for lines or a box that detection missed, and otherwise adds a space fitted to the blank area. (When you're typing in an answer, the first click just leaves it.)
- **Go to a question**: the Go to… button (or G, ⌘/Ctrl+G, or tapping the page number) jumps to any question or part by typing it (3, 4b, 4b(ii), 06.2) or picking it from a list that shows which questions are answered, started or flagged. It also jumps to a page (p5) or the next empty answer space (N). Typed and drawn answers both count. Papers whose numbering starts again in each section (Save My Exams' Easy / Medium / Hard Questions) label their questions by section, E1(a), M2, H3(b), listed under a heading for each section; type e1a or m3b to jump. A topic practice paper of several topics puts the topic first (4-2 M3(b)), and its MCQ questions say so (4-2 MCQ M2).
- **Question markers**: every printed question number and part (1, 2, (a), (b), (i), (ii), AQA's boxed 0 6 . 1 …) gets its own small marker box, and Go to jumps to its start. They're found from the paper's text (or, on scanned papers, read from the margin), following the numbering across pages and preferring bold numbers, so page numbers, barcodes, code line numbers, table data and "1 hour 30 minutes" are ignored. In the Boxes tool they show in purple: move, resize, relabel or delete any of them, or pick **Question** and drag a box over a number that was missed. "Show spaces" shows them too.
- **Tab through the whole paper**: Tab stops at every answer space, at each multiple-choice question once (Space or Enter chooses the option it's on), and at the number of any question with no space of its own (draw on the diagram, sketch the graph), so none is skipped. Shift+Tab goes back.
- **Read the question first**: Tab, and every jump, scrolls so the question's wording stays in view above the answer space instead of hiding it at the top of the screen.
- **Live sync with an account.** Sign in on two devices and open the same paper; typing and ink appear on the other device as you go. Offline changes are kept and sent when the connection returns.
- **Picks up where you left off**: page, zoom, tool, colour and the answer you were typing in.
- **Physics mock papers**: in the past paper finder, pick **Physics mock papers (Save My Exams)** (next to Physics) to list the Save My Exams mocks in the same library as topic practice (`Mock Paper 1 - Set A.pdf` …), tagged by paper and set. Each PDF has its mark scheme at the end: **Question paper** opens just the questions (with the timer set to the time on the cover), **Mark scheme** just the mark scheme.
- **Topic practice** (home page, anyone signed in): your own Save My Exams topic-question PDFs, kept on your server, as tags by module and topic, with question type (Structured / MCQ / Exam questions) and difficulty (Easy / Medium / Hard: only those sections' pages are kept) tags. **Build practice paper** merges the chosen files into one paper, named like `SMX 4-3 Moments – Structured (Hard)`, adds it to your papers and opens it. Topics you've started or finished show a dot. The section explains itself in three steps, shows the marks and suggested time before you build (about 1.2 minutes a mark, from the papers' covers once they've been read), and the paper starts with a contents page (each topic's pages, marks and the suggested time) and opens with the timer set to that time. The covers are left out. MCQ pages get only the letter circles (no answer spaces), structured pages only their answer lines, so a paper that mixes both works. Links such as `/#topics=4-3,4-5&types=Structured&diff=Medium,Hard` open it with everything chosen (the daily revision pack sends these). Setup is below.
- **Past paper finder** (home page, signed in): search Physics & Maths Tutor's A-level past papers by typing (e.g. "AQA physics paper 1 2019 mark scheme") or picking a subject, then narrow the list with tags for level (AS or A level), exam board, paper, year, series and type (question paper, mark scheme, examiner report) and sort it. **Add & open** fetches the PDF through your account, names it properly and adds it to your papers. The Worker reads PMT's listing pages only as far as a search needs and caches them for a day (`src/pmt.js`).
- **Open PDFs any way you like**: choose a file, drag and drop, paste a file with ⌘/Ctrl+V, or paste a link.
- **Export PDF** keeps the original paper sharp (vector) and adds typed text and ink on top. The exported file also carries the original paper and your answers, so opening it in TypePDF again brings everything back editable.
- **Export for AI**: answers as compact JSON, one entry per question part in paper order, plus a small greyscale PDF holding only the handwriting, one image per part. Each answer is labelled with its own part (AQA's hidden "answer space for question 01.2" labels are used when the paper has them, else the nearest part printed above), gap-fills are labelled one by one (e.g. "mass number of Th"), and multiple-choice questions give their question, every option with its letter, and the letters chosen. Question text is only that part's own wording, without page furniture, and keeps its maths (`^{…}`, `_{…}`, `\frac{…}{…}`). Drawing on a figure goes to the part that asks for it ("draw an arrow on Figure 7"), handwriting outside any space goes to the nearest part number, and a part's pieces (even across a page break) are one image. "Blank" only lists parts with nothing typed, chosen or handwritten. The candidate-details cover page is left out. On scanned / image-only papers the question numbers are read from the margin with built-in OCR.
- **Fix anything detection missed** with the Boxes tool: add, move, resize, delete or retype any answer space, or re-detect a page.
- **Flags**: mark any answer space to come back to (to draw it on the iPad, or because it's hard). Flagged spaces show a marker, are listed under ⚑ in the toolbar, and appear in the AI export.
- **Fonts**: answers start in the font closest to the paper's own (detected from the PDF), and you can pick another per paper: Arial, Times, Calibri or Cambria style, a clear sans, an easy-to-read font, handwriting, or Courier style. The exported PDF uses the same font.
- **Folders and organising**: nested folders, drag papers onto folders, search, sort (recently opened, changed, name, size, progress), filters (starred, has flags, not started, in progress, finished), stars, rename, and "New attempt" to make a blank copy of a paper without touching your first try. Copies share one stored PDF.
- **Bin**: deleted papers stay in the bin for 30 days and can be restored.
- **Storage**: each paper shows its size; a bar shows how much space you've used.
- **Paste PDF button** for devices without a keyboard shortcut (e.g. an iPad).
- Timer, "show answer spaces", Tab to glide between spaces, and backup files to move papers between devices without an account.

Signed out, nothing is saved and the PDF is never uploaded.

## How it's built

- `public/` — the app (plain HTML/CSS/JS). Uses [pdf.js](https://mozilla.github.io/pdf.js/) to render, [pdf-lib](https://pdf-lib.js.org/) with fontkit to export, and DejaVu fonts so on-screen text and exported text match.
- `src/worker.js` — a Cloudflare Worker that serves `public/` and handles `/api/*`:
  - `AuthStore` (Durable Object, SQLite): accounts (PBKDF2-hashed passwords), sessions, rate limits.
  - `UserStore` (one Durable Object per account, SQLite): papers, every synced change, and the PDFs (stored in 1 MB chunks). Live sync runs over hibernating WebSockets.

### Accounts, sharing, admin and storage

- **Accounts come from the GirolletServer hub.** "Sign in" sends people to the hub, which sends them back with a short-lived signed pass. Hub admins are TypePDF admins; anyone removed from the hub is signed out and their papers are deleted 30 days later. Set two variables on this Worker (Settings → Variables and Secrets): `HUB_URL` (text: the hub's address) and `HUB_SSO_SECRET` (secret: the same value as `TYPEPDF_SSO_SECRET` on the hub).
- **Without an account** you can open, fill in and export a paper, but nothing is saved.
- **Sharing:** the Share button gives each paper an edit code and a view-only code. Anyone can join from the home page with a code (guests just type a name). Everyone sees changes live; an answer space someone is typing in is locked for the others. The owner can see who joined, remove people, and make new codes.
- Each account's allowance is set by an admin (100 MB – 2 GB, 250 MB by default); admins have no limit. Single PDFs are limited to 40 MB.
- The free plan's 5 GB of Durable Object storage is per **Cloudflare account**, shared by every Worker in it. Each PDF is stored in its own small Durable Object, because a single object is capped at 1 GB on the free plan.

### Showing the real storage left (optional)

By default the admin's storage bar counts only what TypePDF stores. To show what your whole Cloudflare account uses:

1. Find your **Account ID**: Cloudflare dashboard → Workers & Pages → it's shown in the right-hand sidebar (or in any dashboard URL, the 32-character code).
2. Create an **API token**: My Profile → API Tokens → Create Token → Custom token → Permissions: *Account* · *Account Analytics* · *Read* → Account Resources: your account → Create, then copy the token.
3. Open the Worker → **Settings → Variables and Secrets → Add**, type **Secret**, and add `CF_ACCOUNT_ID` (the ID) and `CF_API_TOKEN` (the token). Use *Secret* for both so GitHub deploys never overwrite them.
4. Reload the site. The admin storage bar now shows Cloudflare's own figure (updated by Cloudflare about once a day; the site checks every 10 minutes).

### Updates never lose data

- Server storage changes are additive only: new tables and new columns are added if missing; nothing is dropped or rewritten.
- Papers saved in the browser are upgraded in place when opened (older formats are converted, nothing is removed), and the site asks the browser to keep its storage persistent.
- Answers not yet synced stay marked on the device and are sent when the connection returns.

### Topic practice: your Save My Exams library

The PDFs stay on your own server; TypePDF reads them through a Cloudflare Tunnel that only it can get through. Expected layout (as Save My Exams downloads are organised):

```
SMX AQA A level Physics/
  2 Particles and Radiation/
    2-1 Atomic Structure and Decay Equations - Structured.pdf
    2-1 Atomic Structure and Decay Equations - MCQ.pdf
  9 Astrophysics/
    9-1 Telescopes - Exam Questions.pdf
```

1. Copy the folder to the server, e.g. `/DATA/SaveMyExams` on ZimaOS.
2. Serve it read-only with Caddy (ZimaOS: App Store → + → Install a customized app → Docker Compose):
   ```yaml
   services:
     sme-files:
       image: caddy:2.8
       restart: unless-stopped
       volumes:
         - /DATA/SaveMyExams:/srv:ro
       command: caddy file-server --root /srv --browse --listen :8085
       ports:
         - "8085:8085"
   ```
3. Cloudflare Zero Trust → Networks → Tunnels → your tunnel → Public hostname: `sme.<your domain>` → HTTP → `<server-ip>:8085`.
4. Lock it: Access → Service credentials → Service Tokens → create `TypePDF` (copy the Client ID and Secret). Access → Applications → Self-hosted for `sme.<your domain>`, policy **Service Auth** including that token.
5. On this Worker: `SME_URL` (text, `https://sme.<your domain>`), `SME_ACCESS_ID` and `SME_ACCESS_SECRET` (secrets).

Every signed-in account sees Topic practice (the library is read-only). The Worker only ever fetches files that appear in the folder listing, and caches the listing for 10 minutes (↻ in the section re-reads it).

## Deploy on Cloudflare (auto-deploys from GitHub)

Durable Objects with SQLite storage work on the Workers Free plan; no card is needed.

1. In the Cloudflare dashboard go to **Workers & Pages → Create → Import a repository** and pick this repository.
2. Leave the build command empty. The deploy command is `npx wrangler deploy` (the default).
3. Deploy. Every push to `main` now redeploys automatically.
4. To use your own domain: open the Worker → **Settings → Domains & Routes → Add → Custom domain** and enter the hostname you want. Domains are set in the dashboard, not in this repository.

If the same hostname was previously attached to another Pages project or Worker, remove it there first.

## Run locally

```sh
npm install
npm run dev        # http://localhost:8787
```

## Licence

Apache-2.0. Bundled libraries keep their own licences (pdf.js and pdf-lib: Apache-2.0 / MIT; fontkit: MIT; Tesseract.js and its English data in `public/lib/ocr`: Apache-2.0; bundled fonts: see `public/fonts/LICENSES.md`).
