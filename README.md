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
- Timer, "show answer spaces", Tab to jump between spaces, and backup files to move papers between devices without an account.

Signed out, everything stays in the browser and the PDF is never uploaded.

## How it's built

- `public/` — the app (plain HTML/CSS/JS). Uses [pdf.js](https://mozilla.github.io/pdf.js/) to render, [pdf-lib](https://pdf-lib.js.org/) with fontkit to export, and DejaVu fonts so on-screen text and exported text match.
- `src/worker.js` — a Cloudflare Worker that serves `public/` and handles `/api/*`:
  - `AuthStore` (Durable Object, SQLite): accounts (PBKDF2-hashed passwords), sessions, rate limits.
  - `UserStore` (one Durable Object per account, SQLite): papers, every synced change, and the PDFs (stored in 1 MB chunks). Live sync runs over hibernating WebSockets.

Limits: 40 MB per PDF, 400 MB per account.

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

Apache-2.0. Bundled libraries keep their own licences (pdf.js and pdf-lib: Apache-2.0 / MIT; fontkit: MIT; DejaVu fonts: Bitstream Vera licence).
