# TypePDF

Fill in any PDF paper in the browser. Open a PDF and TypePDF finds the answer spaces — dotted lines, ruled lines, underscores, empty table cells and answer boxes — so you can click and type straight onto them. Write or draw anywhere with a pen, mouse or Apple Pencil, then export a filled-in PDF.

## Features

- **Finds answer spaces automatically** from the page image and the text layer, so it works on most exam papers and on scans. Thin pale-grey answer lines are found wherever they fall on the pixel grid, graph paper and page frames are ignored, and short gaps in equations (including the mass and atomic numbers in nuclear equations) become answer spaces. Labelled lines ("Name …", "Description …") become separate spaces. Code answers (SQL, pseudocode, CSS) get a monospace font where Tab indents; a **</> Code** switch beside any answer (or just typing code) turns code mode on: no auto-capitals or corrections, Tab/Shift+Tab indent, and Enter keeps the indentation.
- **Typed text sits on the printed lines.** Long answers shrink a little, then fit two lines per printed line, and only then extend the page with extra writing lines. The page is never split through printed text.
- **Text, Pen and Smart tools**: Text only types, Pen only draws, Smart does both (tap to type, drag to draw). Laptops start on Text; iPads and devices where an Apple Pencil has been used start on Pen.
- **Select and move drawings**: draw a box round any ink (mouse, finger or Pencil) and drag it anywhere, even to another page; Delete removes it and arrow keys nudge it. Undo works, and moves sync live.
- **Pen, highlighter and eraser** in four colours and three sizes, with undo/redo and Shift for straight lines. On an iPad the Pencil writes (lightly pressure-sensitive, with a hover preview) while fingers scroll and pinch to zoom; two-finger tap undoes, three-finger tap redoes, and four quick one-finger taps swap between the pen and the eraser (after rubbing something out, lifting the Pencil goes back to the pen). Mirroring a laptop screen to an iPad also works.
- **Multiple choice**: tick boxes, ovals and pills are found automatically (small closed outlines that come in lined-up groups, named by the letter or words beside them). Click or tap to choose, as many as you like; the export ticks boxes and fills ovals in, the AI export lists each question's options and the ones chosen, and a multiple-choice question counts once in progress and Go to. Boxes → Choice adds one that was missed.
- **Answer colour and style**: typed answers (and choices) in black, blue, dark blue, red, green or purple, and plain, highlighted, bold, highlighted + bold or in a tinted box, set per paper, synced and used in the exported PDF.
- **Click to add a missed space**: with Text, clicking blank paper away from any answer space looks there again for lines or a box that detection missed, and otherwise adds a space fitted to the blank area. (When you're typing in an answer, the first click just leaves it.)
- **Go to a question**: the Go to… button (or G, ⌘/Ctrl+G, or tapping the page number) jumps to any question or part by typing it (3, 4b, 4b(ii), 06.2) or picking it from a list that shows which questions are answered, started or flagged. It also jumps to a page (p5) or the next empty answer space (N). Typed and drawn answers both count.
- **Question markers**: every printed question number and part (1, 2, (a), (b), (i), (ii), AQA's boxed 0 6 . 1 …) gets its own small marker box, and Go to jumps to its start. They're found from the paper's text (or, on scanned papers, read from the margin), following the numbering across pages and preferring bold numbers, so page numbers, barcodes, code line numbers, table data and "1 hour 30 minutes" are ignored. In the Boxes tool they show in purple: move, resize, relabel or delete any of them, or pick **Question** and drag a box over a number that was missed. "Show spaces" shows them too.
- **Read the question first**: Tab, and every jump, scrolls so the question's wording stays in view above the answer space instead of hiding it at the top of the screen.
- **Live sync with an account.** Sign in on two devices and open the same paper; typing and ink appear on the other device as you go. Offline changes are kept and sent when the connection returns.
- **Picks up where you left off**: page, zoom, tool, colour and the answer you were typing in.
- **Open PDFs any way you like**: choose a file, drag and drop, paste a file with ⌘/Ctrl+V, or paste a link.
- **Export PDF** keeps the original paper sharp (vector) and adds typed text and ink on top. The exported file also carries the original paper and your answers, so opening it in TypePDF again brings everything back editable.
- **Export for AI**: typed answers as compact JSON (labelled by question, optionally with the question wording; on scanned / image-only papers the question numbers are read from the margin with built-in OCR) plus a small greyscale PDF holding only the hand-drawn areas. This is far cheaper for an AI model to mark than the whole paper.
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
