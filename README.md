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
- **Multiple choice**: tick boxes, ovals and pills are found automatically (small closed outlines that come in lined-up groups, named by the letter or words beside them). Click or tap to choose, as many as you like; the export ticks boxes and fills ovals in, the AI export lists each question's options and the ones chosen, and a multiple-choice question counts once in progress and Go to. Boxes → Choice adds one that was missed. Options printed as plain letters with nothing to fill in (Save My Exams' **A.** 6%, **B.** 12% …) are found too: tap a letter and a thick blue circle goes round it, one answer per question (tap another letter to move it, tap the circled one to clear it), even when a question's options carry on over the page; the export draws the circle. On Save My Exams papers (topic practice, mocks, or one opened from your files) the letters are found by their own rules: only options lined up under each other count (a superscript "A" in the question doesn't), and each circle is centred on the letter's ink Options set out as a table (A, B, C, D down the first column, the answers in the other columns) work the same way, and the table's empty corner cell isn't taken for an answer space.
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
- **Export for AI**: **Download for Claude** gives one `.zip` to drag into a Claude chat (on an iPad, **Share to Claude** sends the same files straight to the Claude app): a *READ ME FIRST* prompt telling Claude how to mark the paper and exactly what to send back (a marking file, with this paper's id filled in), the answers JSON, the workings PDF, and the whole answered paper as a PDF so nothing is missed. **Copy the marking prompt** copies just the instructions; the separate files are still there too. The answers file itself: answers as compact JSON, one entry per question part in paper order, plus a small greyscale PDF holding only the handwriting, one image per part. Each answer is labelled with its own part (AQA's hidden "answer space for question 01.2" labels are used when the paper has them, else the nearest part printed above), gap-fills are labelled one by one (e.g. "mass number of Th"), and multiple-choice questions give their question, every option with its letter, and the letters chosen. Question text is only that part's own wording, without page furniture, and keeps its maths (`^{…}`, `_{…}`, `\frac{…}{…}`). Drawing on a figure goes to the part that asks for it ("draw an arrow on Figure 7"), handwriting outside any space goes to the nearest part number, and a part's pieces (even across a page break) are one image. "Blank" only lists parts with nothing typed, chosen or handwritten. The candidate-details cover page is left out. On scanned / image-only papers the question numbers are read from the margin with built-in OCR. Every answer has a stable, unique `id` (`3a-iii`, `4a-gap3`, `5d-drawn`), the export carries the paper's `paperId`, and each handwritten part records the strip of the page its workings image was cropped from, so a marking can point back at exactly the right spot (format: [docs/ai-export-format.md](docs/ai-export-format.md)).
- **Mark with AI, Mark with Claude, and a chat about your marks** ([setup](docs/ai-setup.md)): **✨ Mark with AI** marks the paper in one press and puts the marks on it. It looks like one AI, but the server tries a list of free providers best first (Google Gemini, GitHub Models, Mistral, OpenRouter, Groq, any other OpenAI-compatible API, and Cloudflare Workers AI if you switch it on, plus Claude if you add a paid, capped key), moving on whenever one is at its limit, errors or sends back something that isn't a proper marking. The admin pastes the keys in **AI settings** (they stay on the server); each free one stops at its limit instead of charging. **Mark with Claude** uses your own Claude account: TypePDF is a Claude *connector* (an MCP server at a private link you add once in Claude's settings), so TypePDF prepares the paper, opens Claude beside it with the request typed in, and Claude fetches the paper, marks it and sends the marks, which appear on the open paper straight away. (Claude.ai can't be embedded inside another site, and other sites can't use a Claude subscription, so this is the way round that works.) Every Export for AI bundle also carries a private **drop link**: any AI that can make web requests can POST the marking to it and it appears on the paper with no copying. Once marked, **Ask about your marks** in the Marks panel is a chat with the same free AIs, which see the paper, your answers and the marking. Tested end to end by   ok   signed in through the hub
AI settings
  ok   no AI set up at first; every provider listed
  ok   a key is saved (and never sent back)
  ok   Test: the first model's at its limit, so the next one answers
Mark with AI
  ok   Mark with AI: marked by the provider that answered, on the paper
  ok   the handwriting went to the AI as an image
Chat
  ok   the chat answers about the marks
Claude connector
  ok   preparing the paper gives a drop link
  ok   a connector link
  ok   MCP initialize
  ok   the five tools are listed
  ok   list_papers shows the paper, ready to mark
  ok   get_paper_for_marking: instructions, answers and handwriting images
  ok   get_page returns a picture of the page
  ok   submit_marking accepts it
  ok   the marks appear on the open paper straight away (and the inbox empties)
  ok   get_marking returns the marking on the paper
  ok   a wrong connector link is refused
Drop link
  ok   an AI POSTs the marking to the drop link
  ok   and it appears on the paper
  ok   junk sent to a drop link is refused
Limits
  ok   other accounts only see that AI is ready (not the settings)
  ok   only the admin can change the AI settings
  ok   no page errors

All checks passed (the real Worker under wrangler dev, a fake AI provider, and the connector driven like Claude does).
- **Marking, like a teacher's red pen**: send the Export for AI files to a marker (e.g. Claude), which sends back `<paper> - marking.json` ([format](docs/marking-schema.json), [example](docs/examples/)). **✓ Marks → Import marking** (choose the file, or paste it: easiest on an iPad) draws it on the paper as its own layer: green ticks and red crosses at the words or the spot in your workings they're about, underlines, circles, carets with the missing word, red hand-lettered comments in the margin (wrapped, never on top of each other, each with a thin line to what it's about) with the right answer under them, each part's marks in a circle in the margin, a bracketed total at the end of each question, and on the front page your score (in the paper's own "Total" box when it has one; a "For Examiner's Use" table gets each question's marks out of its total in its own row, a range row such as 8–32 (the multiple choice) the sum of those questions, and TOTAL the score out of the paper's total) plus a summary with the percentage, grade and a per-question table in the emptiest part of the page. Parts skipped on purpose (`excluded`) are grey and left out of the total. It isn't only for typed text: on a multiple-choice question the marker gives the right letter and TypePDF ticks your choice in green if it's right, or crosses it in red and circles and ticks the right one in green; a `working` (step by step) is written in a dashed box in the blank space under or beside the question (never under the next one) whenever you didn't get full marks; drawings, graphs and logic circuits are marked at the spot in your workings (circle the gate, cross the wrong wire, an arrow with "needs a NOT here"), and the marker can draw the right thing in red: a sketch, or a logic gate symbol (AND, OR, NOT, NAND, NOR, XOR, XNOR); gap-fills and table cells get their tick or cross just beside them, with the right value. Nothing is ever blue (blue is for your own corrections). Nothing the marking writes ever covers the paper, your answers or other marks: every page is mapped (the printed ink, read from the page itself; what you typed, line by line; your pen strokes; chosen options; marks already placed) and each comment, label, working box, total and the summary goes in the nearest clear space, within its own part (the blank lines of an answer space count as clear, as they would for a teacher). Ticks and crosses go right after the words they mark (just above the line if more writing follows), inside the empty end of a table cell, or beside an option. A note with no room by its answer becomes a small numbered marker there, written out in a Notes box on that page (or at the end of the marked PDF, and in the Marks panel). Full-mark parts get ticks but no "Correct." comment, 0/0 parts no circle, and a logic-gate symbol that would land on your wires moves to the nearest clear spot. The Marks panel lists every part with its marks and verdict (tap one to go to it), shows or hides the layer, lets you move or delete any mark and add your own ticks, crosses, circles and notes, undoes the last import, and **Export marked PDF** flattens answers, workings and marks into one PDF. Your answers are never changed, and the marking is kept with the paper and synced like the answers. A link `…/#mark=<base64url(gzip(json))>` opens the right paper and imports the marking in one tap. Checked by `node tests/marking.test.js` (with the app served on port 8799).
- **Answers that carry on over the page**: when a long question's lines run to the bottom of a page and carry on at the top of the next (nothing in between but the page footer and header), the two spaces are one answer: just keep typing and the text flows from one into the next, between words, with the caret following it. Deleting pulls the text back, Backspace at the start of the second space carries on into the first, and the arrow keys move between them. It counts as one answer, and Export for AI gives it as one piece of text.
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
