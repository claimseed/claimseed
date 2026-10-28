# Security policy

Report vulnerabilities privately through GitHub's private vulnerability reporting on the claimseed repository
(Security tab → Report a vulnerability), or by e-mail to maintainers@gildage.co (subject line "security"). Please do not open public issues for
security reports. We aim to acknowledge within 3 business days.

In scope: the renderer (headless Chrome), template handling, the CLI and the MCP server — in particular any path
that lets caller-supplied data reach the filesystem, the network, or JavaScript execution. Layouts are trusted
code; a malicious layout is out of scope, a malicious *data* object is in scope.

What the MCP server (`packages/mcp`) adds to the renderer guarantees below (`packages/mcp/test/` exercises it): a client
supplies only a type, a scenario slug and a seed, each checked against a fixed pattern, and no tool reads a file a
client names. The server writes only into the workspace folder fixed at startup (resolved to its real path, re-checked
before every write, never `/` or the home folder), under names it chooses itself, creating each file exclusively and
without following symbolic links. To stay under its quota it deletes only files listed in its own ledger whose size
and SHA-256 are still what it wrote; a ledger entry whose name is not one the server makes is ignored, so a planted
ledger cannot point it at another file. Renders share one browser per process, with at most 4 running and 4 waiting;
a render over the time limit is stopped by closing that browser; a protocol message over 4 MB closes the server. stdout carries only protocol messages. Known limit: the folder is re-checked before each write, not held open, so someone who can rename the folder's parent directory on the same machine could race a write between the check and the file's creation (an MCP client cannot). Inside the
Docker image Chromium runs without its own sandbox, so the container is the boundary: the documented command runs it
without network, read-only, with no capabilities and as the calling user. A way to make the server read or write
outside its folder, delete a file it did not write, or return an unstamped document is a vulnerability.

What the renderer guarantees (and `test/render-security.test.js` exercises): Nunjucks autoescape is on
and `| safe` is used only on stock fields; HTML is handed to Chrome as a string on `about:blank`, never
loaded from disk; JavaScript is disabled; a Content-Security-Policy allows only inline styles and `data:`
fonts and images; Chrome is launched with a dead proxy, DNS prefetch and prerender/speculation disabled;
request interception refuses everything but `about:blank` and `data:`; `<meta refresh>` and `<base>` are
stripped by an HTML-tokenizer-aware filter and, behind it, a navigation sentinel refuses any render whose
document was replaced; the renderer's fontconfig sees no system fonts. The specimen band and watermark are
stamped into the finished PDF with pdf-lib inside `mergePdfs`, independent of the HTML, so no data object
or template can remove them and no entry point (CLI or library) skips them. If you find markup that reaches
the network or the filesystem from inside a render, or a way to obtain an unstamped document, that is a
vulnerability. The page size is the renderer's own (Letter, portrait or landscape per layout), never the
document's `@page` rule, so the band is always on a page large enough to show it. Data that does not fit a
layout is refused rather than clipped: element boxes, every text run (so an unbreakable token in a table
cell cannot overprint its neighbours) and hidden-overflow containers are all measured against the page
box before the PDF is written, and the ground truth can never describe text that is absent from the page.
A way to make the renderer silently drop or hide data it also reports in the ground truth is a vulnerability.
Text may not run into a positioned running header or footer either. On a caller-supplied PDF (`finalizePdf`,
`mergePdfs`) the markers are drawn inside the visible page — the CropBox clipped to the MediaBox — and a page
whose visible area is under 3 in on a side, or not a finite rectangle, is refused. 

On a caller-supplied PDF (`finalizePdf`, `mergePdfs`) the page's own content is read before anything is drawn, the
way a viewer reads it: operands are parsed as objects (numbers, names, strings, arrays, dictionaries), and an inline
image is measured exactly, from `/W`, `/H`, `/BPC` and a device or indexed colour space (rows padded to whole bytes),
or up to the `>` / `~>` end of ASCIIHex or ASCII85 data, with a PDF 2.0 `/L` length accepted only when it agrees.
A page is refused (`stamp refused: page N content ...`) when its content restores a graphics state it never saved
or leaves one unrestored; ends a marked-content sequence it never began or leaves a `BMC`/`BDC` open (an optional-
content sequence left open would hide everything drawn after it, the markers included); ends inside a path object
(an unpainted path or a pending `W` clip, which some viewers carry past `Q`); cannot be decoded; or could be read
differently by different viewers: an inline image with any other filter, a named or unknown colour space, a
length that disagrees, bytes between its data and `EI`, or an `EI` inside its data; a token that is neither a valid
number nor a PDF operator (viewers split `1Q` or `qQ` differently); an operator inside an array or a dictionary; a
stray delimiter; `ID`/`EI` outside an inline image; or an unterminated string, array or dictionary.

The checked bytes are then drawn as one Form XObject, so a viewer runs exactly what was checked, with no content-
stream boundaries left to interpret, and the markers are drawn on the page after it, from the default graphics
state. A viewer saves the graphics state before a Form XObject and restores it afterwards, so nothing the content
sets (a clip, a transform, a soft mask, a text state, an unbalanced `q` or `Q`) reaches the markers, even through a
construct the check and a viewer might read differently. Form XObjects that the content itself draws are not
parsed: in poppler, PDFium and Chrome an open marked-content sequence, an unbalanced `q`/`Q`, a clip or a transform
inside a Form XObject do not reach what the page draws after it (measured on rasters), and the markers are drawn
after all of it. Tagged content keeps its structure: marked content moved into the Form XObject is addressed through
marked-content references to it. Annotations and page actions are removed, as before.

Limits. Rendering behaviour was measured in poppler, PDFium and Chrome only; other viewers (pdf.js, Preview,
Acrobat) were not tested, in particular for state left open inside nested Form XObjects. Inline images that are
well formed but use a compression filter (Flate, DCT, LZW, RunLength, CCITT, JBIG2) or a named colour space are
refused; use an image XObject instead. Content using operators outside the PDF operator set, even inside a `BX`/`EX`
compatibility section, is refused. The watermark is drawn at 14% opacity: over a dark or saturated page it remains
visible as a tint, at lower contrast; the band is opaque. `mergePdfs` does not carry an input's catalog, so the
optional-content configuration of a merged input is not kept (its hidden layers become visible) and its structure
tree is dropped. Content drawn by the page can still cover the page's own content; it cannot cover the markers,
which are drawn last.

The fit check measures the area that actually prints. The PDF is always printed on the renderer's own page box
(Letter, portrait or landscape per layout) with zero margins, and the document is laid out and measured on exactly
that box: every `@page` rule in the document, wherever it is nested (`@media`, `@supports`, `@layer`, `@container`,
an imported sheet), may only restate the paper's size (or `auto`) and zero margins. Any other page size, a non-zero
page margin, a page-margin box (`@top-center { content: ... }`) or any other `@page` property is refused, as is CSS
`zoom` other than 1 on any element and a document that contains a shadow root (declarative, open or closed). The fit
check runs on the print layout (print media, a viewport the size of the paper), so a rule under `@media print` cannot
clip what the check measured unclipped.

Every text run is measured with its transforms (`Range.getClientRects`). It must lie inside its `.page` box, inside
every ancestor that clips it (overflow other than visible, `contain: paint` — paint containment on the root and the
body too, where overflow passes to the viewport and clips nothing) and inside its table cell, and it may not
run into a positioned block it is not part of. Every `.page` box must lie on one sheet of paper: the layout is
continuous and the PDF cuts it into sheets of the paper's height, so after the first `.page` each must start at the
top of a sheet of its own; a page moved by a transform or a margin, a page taller than the paper and a forced page
break inside a page are refused. Text outside `.page` elements (all of a document without them) must lie within the
paper's width and below its top edge, and may not straddle the edge of a sheet when it is transformed or when the
document has `.page` elements. `position: fixed` text in a document of more than one sheet is refused (it would repeat
on every sheet).

Rotated, skewed and vertical text is refused (a `transform` or `rotate` that turns the text or an ancestor by any
angle but a half turn, or skews it; a `writing-mode` other than `horizontal-tb`): the rendered-text check reads
printed lines by their horizontal geometry. A half turn or a reflection (`rotate(180deg)`, `scale(-1, -1)`, a matrix
with negative diagonal terms) is not refused; such text keeps its horizontal lines, so `scan-rendered` still reads it
(executed: a sentence turned by a half turn is reported). Text whose printed result is not a rectangle the check can
compare is refused: `clip-path`, `mask` / `mask-image` / mask-border, the legacy `clip`, `filter` and `mix-blend-mode`
on the text or on any element that contains it. Text that would not print visibly is refused: text with no layout box
(`display: none`, the closed part of a `<details>`, the options of a closed `<select>`, an SVG `<title>`),
`visibility: hidden` or `collapse`, an effective opacity (the product over the text's ancestors) under 0.05, a fill
colour whose alpha times that opacity is under 0.05 with no visible stroke, and text printed less than 3 px high.
`content-visibility: hidden` on an ancestor is not detected: its text keeps a layout box and is not painted, so a
document can print less than it holds (the specimen marks are unaffected).

A render whose document navigates or is replaced at any point between setting the content and the end of printing
is refused with `render refused: the document navigated or was replaced during rendering (meta refresh or
equivalent)`, whichever Puppeteer call the navigation interrupted: Puppeteer's "execution context was destroyed",
"frame detached", "target/session closed" and failed-navigation errors are normalised into that refusal at the print
boundary (the original error is kept as `cause`). The sentinel is checked before the document is measured and again
after it is printed, and a main-frame navigation event refuses the render even if the sentinel check raced it. A
refused render leaves no PDF behind.

Known limitations of the repository's own checks (`npm run check`). They are a safety net for honest
mistakes, not a sandbox: `check-synthetic` finds files hidden inside text (base64, base32, base85/ASCII85,
base36, hex dumps, byte arrays, BigInt literals, escapes, compressed and container formats — a gzip, zlib,
raw-deflate, bzip2, xz, zstd, lz4 or Brotli stream is refused however short — as base64, base32, hex
(contiguous, or separated by colons, dashes, underscores, commas or spaces), evenly grouped base32, base64 in groups
of any widths or wrapped over short lines, a short list of numbers in source or dump syntax (comma, semicolon, space or
tab separated; decimal or hex; signed, unsigned or mixed; with casts and suffixes such as `(byte)31` or `0x1fu`) read as
bytes or, when the values need it, as 16- or 32-bit words in either byte order (`Uint16Array`, `Uint32Array`), pieces
of string literals (with `b''`, `r''`, `u''`, `f''`, `L""` or `u8""` prefixes too) joined by `+`, `..`, `||`, `&`, commas or juxtaposition, or a run of encoded-alphabet literals assembled
through a little code between them (up to 60 characters on up to three lines between two: variables added together,
`.concat()`, template interpolation) — and a gzip, bzip2 or xz stream is refused even when it is damaged or
truncated, a raw-deflate stream when what it yields before it breaks off reads as words, and a Brotli stream when it
is still producing output at the 1 MiB decoding budget: decoding is bounded and a stream over the budget is a payload,
never "not Brotli"; what a stream holds is read as text in UTF-8, UTF-16 or UTF-32, with or without a byte-order mark,
and with NUL padding removed) and fails closed on any unknown decoded blob of 1 KB or more (2 KB per file, 8 KB across the
tree). It does not decode uncommon alphabets (base58, base91, Z85, yEnc) or hex separated by dots, nor evaluate code (literals assembled
through functions, computed indexes, more than 60 characters of code between pieces, or encoded pieces interleaved
with other strings such as object keys), nor reassemble very small chunks scattered between comment lines, nor read
data hidden in whitespace patterns or acrostics; a compressed stream cut by more than a few bytes yields only part
of its text; and it can flag long lists of independent checksums as one encoded blob. `verify-stock-sources` and `scan-rendered` judge every printed sentence of six or more words; template
placeholders (`{{ x }}`, `{field}`, short `[field]` brackets) are not text, bracketed or braced prose is.

`verify-stock-sources` reads layout from the markup and simple CSS selectors. Besides inline-level elements and the
children of a flex or grid row, a box that prints beside its neighbours — an absolutely or fixed positioned element,
an item of a multi-column container (`columns`, `column-count`, `column-width`), an item of a flex or grid container
(also through `display: contents`) — is joined with its neighbours when its whole text is one line, however deeply
that text is nested. A sentence split over two positioned boxes, two columns or two grid cells is therefore judged
whole, and a label printed beside a sentence in such a layout is judged as part of that sentence; complete reviewed
sentences side by side still pass.

`scan-rendered` judges what the PDF prints, by geometry: the words of every page (with their boxes) are grouped into
the lines they print on, whatever separates them horizontally. On every printed line, a run of six or more words must
be verified text (a public-source sentence or a reviewed original). Only these separate words: a verified sentence
covering them (judged in reading order, so a wrapped sentence is covered on both lines), the document's own values
(strings that differ between seeds — several alternative seeds, so a value two seeds happen to share is still a value),
numbers, month names, the fictional plan names, the band, the start of a table or text column, and the edge of a table
cell that holds one of the document's own data fields (the cell's words are the whole field, or two or more consecutive
words of it: "Full eye exam, returning patient | YES" is a service cell beside its approval cell). Short pieces of the
tree (labels, template text, stock fragments) exempt nothing on a printed line: two pieces that are fine alone but
print side by side as one unreviewed sentence are reported. A sentence broken over two lines of one block is judged
whole: when a line of one run ends without closing punctuation and the next line starts directly below it, aligned
with it, with a lower-case word, the run of words carries over the line end.

Further limits:

- The fit check compares geometry, not pixels. Text drawn in the background colour (white on white), text with too
  little contrast, and text covered by an opaque box that holds no text are not detected (executed: a white `<h1>` on
  a white `.page`, and an empty white absolutely positioned box over a line, both render).
- Text generated by CSS (`::before` / `::after` `content`) is not measured as text, and form-control values
  (`<input>`, `<textarea>`, `<select>`) only as the control's box.
- A document without `.page` elements is measured against the paper's width and top edge; how Chrome then paginates it
  vertically is Chrome's (lines it pushes to the next sheet are not lost).
- `verify-stock-sources` joins one-line boxes only. A multi-line positioned box or a multi-line flex, grid or column
  item beside another keeps its own lines; what prints beside it is judged by `scan-rendered` (executed: a two-line
  positioned box whose first line completes a sentence started in a neighbouring box passes `verify-stock-sources`
  and is reported by `scan-rendered`).
- `scan-rendered`'s column test is a heuristic: a run starts a new column when it lines up (left edge, right edge or
  centre, within 1 pt) with a run on another line up to four line heights away on which there is also text under the
  run to its left — a table row under its header or under an earlier row, the next lines of two text columns. Pieces
  deliberately laid out as a table with a row close below separate there, and so do the pieces of a sentence split over
  two data fields printed in neighbouring table cells (each field is judged at the source).
  In particular a sentence spread over the header cells of a real table by a data-only edit of stock labels is not
  joined by either check (`verify-stock-sources` keeps table cells on their own lines; `scan-rendered` sees a table
  header aligned with its rows).
- The line-end carry-over needs a lower-case continuation directly below: a sentence split over stacked blocks whose
  second part starts with a capital letter or with an opening quotation mark, whose first part ends in a colon, or
  whose second line is set further apart (more than about 1.8 line heights) or indented by more than two line heights,
  is judged line by line (two short lines).
- Label lines the templates print only for some data are judged only when a scanned seed prints them: with four seeds,
  `scan-rendered` reports the PPO claim header of a claim continued from the previous page ("In-network provider
  (continued from the previous page) Claim number", seed `scan-3`) as an unreviewed assembled line; it needs a
  reviewed-original entry before more seeds are scanned in CI.
- PDF marks: Rendering behaviour was measured in poppler, PDFium and Chrome only; other viewers (pdf.js, Preview,
Acrobat) were not tested, in particular for state left open inside nested Form XObjects. Inline images that are
well formed but use a compression filter (Flate, DCT, LZW, RunLength, CCITT, JBIG2) or a named colour space are
refused; use an image XObject instead. Content using operators outside the PDF operator set, even inside a `BX`/`EX`
compatibility section, is refused. The watermark is drawn at 14% opacity: over a dark or saturated page it remains
visible as a tint, at lower contrast; the band is opaque. `mergePdfs` does not carry an input's catalog, so the
optional-content configuration of a merged input is not kept (its hidden layers become visible) and its structure
tree is dropped. Content drawn by the page can still cover the page's own content; it cannot cover the markers,
which are drawn last.

If you believe a published specimen contains information about a real person, report it the same way
and we will treat it as a critical issue.
