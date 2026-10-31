# TypePDF

Fill in any PDF paper in the browser. Open a PDF and TypePDF finds the answer spaces — dotted lines, ruled lines, underscores, empty table cells and answer boxes — so you can click and type straight onto them. Write or draw anywhere with a pen, mouse or Apple Pencil, then export a filled-in PDF.

## Features

- **Finds answer spaces automatically** from the page image and the text layer, so it works on most exam papers and on scans. Labelled lines ("Name …", "Description …") become separate spaces. Code answers (SQL, pseudocode, CSS) get a monospace font where Tab indents.
- **Typed text sits on the printed lines.** Long answers shrink a little, then fit two lines per printed line, and only then extend the page with extra writing lines. The page is never split through printed text.
- **Pen, highlighter and eraser** in four colours and three sizes, with undo/redo and Shift for straight lines. On an iPad the Pencil writes while fingers scroll and pinch to zoom. Mirroring a laptop screen to an iPad also works.
- **Live sync with an account.** Sign in on two devices and open the same paper; typing and ink appear on the other device as you go. Offline changes are kept and sent when the connection returns.
- **Picks up where you left off**: page, zoom, tool, colour and the answer you were typing in.
- **Open PDFs any way you like**: choose a file, drag and drop, paste a file with ⌘/Ctrl+V, or paste a link.
- **Export PDF** keeps the original paper sharp (vector) and adds typed text and ink on top.
- **Export for AI**: typed answers as compact JSON (labelled by question, optionally with the question wording) plus a small greyscale PDF holding only the hand-drawn areas. This is far cheaper for an AI model to mark than the whole paper.
- **Fix anything detection missed** with the Boxes tool: add, move, resize, delete or retype any answer space, or re-detect a page.
- **Flags**: mark any answer space to come back to (to draw it on the iPad, or because it's hard). Flagged spaces show a marker, are listed under ⚑ in the toolbar, and appear in the AI export.
- **Fonts**: answers start in the font closest to the paper's own (detected from the PDF), and you can pick another per paper: Arial, Times, Calibri or Cambria style, a clear sans, an easy-to-read font, handwriting, or Courier style. The exported PDF uses the same font.
- **Folders and organising**: nested folders, drag papers onto folders, search, sort (recently opened, changed, name, size, progress), filters (starred, has flags, not started, in progress, finished), stars, rename, and "New attempt" to make a blank copy of a paper without touching your first try. Copies share one stored PDF.
- **Bin**: deleted papers stay in the bin for 30 days and can be restored.
- **Storage**: each paper shows its size; a bar shows how much space you've used.
- **Paste PDF button** for devices without a keyboard shortcut (e.g. an iPad).
- Timer, "show answer spaces", Tab to jump between spaces, and backup files to move papers between devices without an account.

Signed out, everything stays in the browser and the PDF is never uploaded.

## How it's built

- `public/` — the app (plain HTML/CSS/JS). Uses [pdf.js](https://mozilla.github.io/pdf.js/) to render, [pdf-lib](https://pdf-lib.js.org/) with fontkit to export, and DejaVu fonts so on-screen text and exported text match.
- `src/worker.js` — a Cloudflare Worker that serves `public/` and handles `/api/*`:
  - `AuthStore` (Durable Object, SQLite): accounts (PBKDF2-hashed passwords), sessions, rate limits.
  - `UserStore` (one Durable Object per account, SQLite): papers, every synced change, and the PDFs (stored in 1 MB chunks). Live sync runs over hibernating WebSockets.

### Accounts, admin and storage

- The **first account created is the admin**. The admin has no storage limit, sees how much of Cloudflare's free 5 GB everyone is using, sets each user's allowance (100 MB – 2 GB, 250 MB by default), can list and delete any user's papers, and can delete accounts. Users are told the admin can see their papers' names and sizes.
- Other accounts get the default allowance until the admin changes it. Single PDFs are limited to 40 MB.
- The free plan's 5 GB of Durable Object storage is per **Cloudflare account**, shared by every Worker in it (Pages static files, KV, D1 and R2 have their own separate allowances). Each PDF is stored in its own small Durable Object, because a single object is capped at 1 GB on the free plan.

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

Apache-2.0. Bundled libraries keep their own licences (pdf.js and pdf-lib: Apache-2.0 / MIT; fontkit: MIT; bundled fonts: see `public/fonts/LICENSES.md`).
