# Export for AI: the answers file

**Export for AI** makes two files:

- `<paper> - answers.json`: the typed and chosen answers.
- `<paper> - workings.pdf`: only the handwriting, one greyscale image per part.

A marker reads both, then sends back `<paper> - marking.json` (see [marking-schema.json](marking-schema.json)). TypePDF draws that on the paper.

## answers.json

```json
{
  "paper": "Computer systems June 2025",
  "paperId": "66c87aa270410239d0aff1f2",
  "exported": "2026-11-07T17:22:16.551Z",
  "format": "typepdf-answers",
  "version": 2,
  "time_used": "1:52:10 of 2:30:00",
  "note": "…",
  "marking": { "file": "… - marking.json", "format": "typepdf-marking", "version": 1, "how": "…" },
  "answers": [ … ],
  "blank": ["2", "6(b)"],
  "blankIds": ["2", "6b"],
  "handwritten": [{ "q": "5(d)", "pages": [11], "on": "Figure 7" }],
  "flagged": ["4(a)"]
}
```

| field | |
|---|---|
| `paperId` | **new.** The paper's id in your library. A marking should copy it back. |
| `exported` | When this export was made. A marking should copy it back, so TypePDF can tell whether your answers changed since. |
| `format`, `version` | **new.** `typepdf-answers`, version 2. Version 1 had no `id`, `paperId` or `workings` fields. Nothing else changed. |
| `marking` | **new.** A one-line description of the marking format, so a marker knows what to send back. |
| `blankIds` | **new.** The ids of answers left blank. `blank` still lists their labels. |

## Each answer

```json
{ "id": "3a-iii", "q": "3(a)(iii)", "page": 7, "question": "…", "type": "written", "answer": "228" }
{ "id": "4a-gap3", "q": "4(a)", "page": 8, "part": "mass number of Th", "type": "gap", "answer": "234" }
{ "id": "1c", "q": "1(c)", "page": 3, "type": "multiple choice", "options": ["A …", "B …"], "answer": ["B"] }
{ "id": "5d-drawn", "q": "5(d)", "page": 11, "type": "drawn", "handwritten": "drawn on Figure 7: see the workings PDF",
  "workings": { "image": 3, "width": 595.3, "height": 210, "crops": [ { "page": 11, "x0": 0, "y0": 402, "x1": 595.3, "y1": 612, "imageY0": 0, "imageY1": 210 } ] } }
```

- **`id`** (**new**): unique within the paper, and the same each time the same paper is exported.
  - It is built from the label: `3(a)(iii)` gives `3a-iii`, `06.2` gives `6.2`, `E1(a)` gives `e1a`, and `4-2 M3(b)` gives `4-2m3b`.
  - Then a suffix where needed: `-gap1`, `-gap2` … for gap-fills in a part, `-drawn` for drawings, `-table` for tables.
  - If two answers would still share an id, one gets `-mc` / `-written` or `-2`, `-3`.
- **`q`**, **`page`** and **`part`** are as before.
  - `q` is the printed label and isn't unique: several gaps share one, and a part can have both written and drawn answers.
- **`workings`** (**new**, on every answer that has handwriting): where that part's handwriting is in the workings PDF.
  - `image` is the image's page number in the workings PDF. `width` and `height` are the image's size in points, not counting the caption strip at the top.
  - Each crop is a strip of the paper's page `page`, from `y0` to `y1` (points from the top of the printed page, full width `x0`–`x1`). It is drawn in the image from `imageY0` to `imageY1`.
  - The strips are stacked top to bottom with a 6 pt gap between them.
  - So a point at (x, y), as 0–1 fractions of the image, is on page `crop.page` at x × `width` across and `crop.y0` + (y × `height` − `crop.imageY0`) down, using the crop whose `imageY0`–`imageY1` range holds y × `height`.
- An answer that carries on over the page (lines at the bottom of one page and the top of the next) is one answer. Its text is joined back up exactly as typed.

TypePDF remembers the latest export of each paper, including which answer spaces each id is. It keeps that with the paper and syncs it, so a marking can be imported on another device.

## Marking things that aren't typed text

The marking file ([marking-schema.json](marking-schema.json)) has ways in for every kind of answer:

| answer | how the marker points at it | what TypePDF draws |
|---|---|---|
| typed words | `{kind:"text", match:"…"}` | tick/cross after the words, underline, circle, caret with the missing word |
| multiple choice | `correctOptions: ["C"]` on the part, or `{kind:"option", letter:"C"}` | your choice ticked green or crossed red; the right one circled and ticked green |
| a gap-fill | the gap's own id (`4a-gap3`) with `{kind:"part"}` | tick/cross just after the gap, label (the right value) beside it |
| a table | `{kind:"cell", index: n}` (the order of `cells`) | tick/cross beside that cell |
| drawing, graph, circuit | `{kind:"workings", x, y, w, h}` (0–1 of that part's workings image) | circle, cross, arrow (`from`), bracket at that spot; `sketch` (a path) or `symbol` (a logic gate) drawn in red in that box |
| anything else | `{kind:"part"}` or `{kind:"page", page, x, y}` | beside the answer, or at that spot on the page |

`working` (a list of steps) is shown in a dashed box near the answer whenever the part isn't fully right.
