# @claimseed/mcp

An [MCP](https://modelcontextprotocol.io) server that lets an agent list, generate and render claimseed's synthetic
medical-billing specimen documents. Rendered documents come back as page images that chat clients show in the
conversation, and, if you give it a folder, as PDF and ground-truth files in that folder. It runs over stdio, writes
nowhere but that one folder, never reads a file a client names, and needs no network access and no API key.

## Run it

Node.js 22.13 or later. Rendering needs Chrome or Chromium (`CLAIMSEED_CHROME=/path/to/chrome`, or an install in a
usual place); listing and `generate_data` do not.

To see documents in the chat and save no files:

```json
{ "mcpServers": { "claimseed": { "command": "npx", "args": ["-y", "@claimseed/mcp"] } } }
```

To also keep each PDF and its ground truth as files, give it a folder:

```json
{
  "mcpServers": {
    "claimseed": {
      "command": "npx",
      "args": ["-y", "@claimseed/mcp", "--workspace", "/absolute/path/to/claimseed-out"]
    }
  }
}
```

Or from a checkout: `node packages/mcp/src/cli.js` (add `--workspace ./out` for files). With Docker, using the published image
`ghcr.io/claimseed/claimseed-mcp` (Chromium is inside it; `:latest`, or a version tag such as `:0.1.0`), or one you
build from the `Dockerfile` at the repository root (`docker build -t claimseed-mcp .`, then use `claimseed-mcp` as the
image name below):

```sh
docker run -i --rm --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" -v "$PWD/claimseed-out:/work" ghcr.io/claimseed/claimseed-mcp
```

(The image writes to `/work`; to save no files, leave out the `-v` mount and add `-e CLAIMSEED_WORKSPACE=`.)

```json
{ "mcpServers": { "claimseed": { "command": "docker",
  "args": ["run", "-i", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL",
           "--security-opt", "no-new-privileges", "--user", "1000:1000",
           "-v", "/absolute/path/to/claimseed-out:/work", "ghcr.io/claimseed/claimseed-mcp"] } } }
```

The server is listed in the MCP registry as `io.github.claimseed/claimseed`.

Replace `1000:1000` with your user and group ids (`id -u`, `id -g`) so the files in the folder are yours. Chromium's
own sandbox needs privileges a container does not have, so inside the image it runs without it; the container is the
boundary, which is why the flags above take away its network, its capabilities and its writable filesystem.

## Tools

| Tool | What it does |
| --- | --- |
| `list_document_types` | The types (`msn`, `itemized-bill`, `ppo-eob`, `hmo-eob`), each with a description and its scenarios. |
| `describe_document_type` | Every scenario of one type: description, period, claim count, the errors it injects (kind, severity, rule) and its public sources. |
| `generate_data` | The data and ground truth of one document, without rendering; nothing is written. |
| `render_document` | Renders one document and returns its pages as images, its ground truth, the PDF's SHA-256 and page count; with a workspace, also writes the PDF and its ground-truth JSON there and returns both paths. |
| `verify_document` | Scores what an extractor or bill auditor reported about one document against its answer key: field accuracy with the paths read wrong or missed, error recall and precision, false alarms and the decoys flagged. Nothing is rendered or written. |

Arguments are a type, a scenario slug and a seed (letters, digits, `.`, `_`, `-`; up to 64 characters). The same
type, scenario and seed always give the same data, and on Linux with the same Chrome build the same PDF bytes.
`render_document` also takes:

- `preview`: `none`, `first` or `all` — which pages come back as images (default `all` without a workspace, `first`
  with one). Pages are 1200 pixels on the long side, PNG (JPEG when only a JPEG still fits), and one result carries
  at most `CLAIMSEED_MCP_PREVIEW_KB` of image data (default 800 KB, under the 1 MB some clients allow a tool result);
  the result says which pages it holds and where to continue. The first requested page is always included, drawn
  smaller or as a JPEG to fit, and at its smallest even when that is over a very low limit.
- `from_page`: the first page to return as an image (default 1), to see the pages one result had no room for.
- `include_pdf`: also return the PDF itself, embedded in the result. It counts toward the same limit: when it fits,
  page images take the room left (none is forced in); when the PDF alone is over the limit it is left out, and the
  result says so (`pdfEmbedded: false`).

`verify_document` takes the type, scenario and seed of the document and `output`, the report in the shape of
`schema://extractor-output`: `fields` maps answer-key field paths (the keys of `documents[0].fields`) to the values
read, and `errors` lists `{ kind, fieldRef or lineRef }`. It rebuilds the answer key from the seed with this
version of claimseed. Matching follows `@claimseed/core`'s `verify` command: money to the cent, dates in ISO,
M/D/YYYY or "April 11, 2026", text without regard to case; an error is found when its kind and line match, and
for a duplicate charge either line counts; a flag on a decoy (a line that looks wrong but follows the rules) is a
false alarm. To score a whole rendered set, use `claimseed-core batch` and `claimseed-core verify --manifest`.

Resources: `schema://ground-truth` (the ground-truth JSON Schema), `schema://extractor-output` (the report
`verify_document` scores), `catalog://scenarios`, `catalog://mutations` (error and decoy operations),
`docs://error-taxonomy`, `policy://synthetic-data`, and `ui://claimseed/preview` (the MCP Apps view below). Prompt:
`build_test_case` (a goal, optionally a type) plans and renders a small test set with expected results.

## Seeing documents in the chat

A `render_document` result holds the page images as standard MCP image content, the ground truth as structured
content, and names an [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) view
(`_meta.ui.resourceUri = "ui://claimseed/preview"`) that shows the pages with a table of the injected errors. What
you see depends on the client:

| Client | What it shows |
| --- | --- |
| Clients with MCP Apps (ChatGPT, Claude, VS Code and others) | The view: every returned page and the injected errors, in the conversation. |
| Clients that show image content (Claude Desktop, claude.ai, MCP Inspector) | The page images in the tool result. |
| Clients that pass images to the model only (several command-line agents) | The text summary; the model sees the pages and can describe them. |

Every client gets the text summary and the structured ground truth. The view is one self-contained page: it loads
nothing (its Content-Security-Policy allows only `data:` images), sends nothing but the MCP Apps messages to its host,
shows every value as text, and takes only colour and font values from the host's style variables.

ChatGPT reaches MCP servers over HTTPS, so a stdio server needs a bridge and a public address. One way, with
third-party tools (pin versions you have checked): run `npx -y supergateway@4.1.0 --stdio "npx -y @claimseed/mcp"
--outputTransport streamableHttp --stateful --port 8000`, expose port 8000 with a tunnel (for example
`cloudflared tunnel --url http://localhost:8000`), and add `https://<tunnel address>/mcp` as a connector in ChatGPT's
developer mode. Anyone who has the tunnel address can call the server while it runs; without a workspace it writes
nothing, but stop the tunnel when you are done.

## Limits and safety

- **One folder, or none.** Without a workspace the server saves no file. Its browser, like any Chrome, keeps a
  temporary profile in the system temp folder while it runs (in the container, the in-memory `/tmp`); the profile is
  removed when the browser closes, after a minute without renders or when the server stops, and is left behind only
  if the process is killed. With a workspace, the server writes only into the
  workspace folder (`--workspace` or `CLAIMSEED_WORKSPACE`), which must exist and may not be `/` or your home folder. It picks every file name itself
  (`<type>_<scenario>_<seed>_<random>.pdf` and `.ground-truth.json`), creates files exclusively and never through a
  symbolic link, and stops if the folder is moved or replaced by a link while it runs.
- **Quota.** `CLAIMSEED_MCP_QUOTA_MB` (default 500) caps the total size of its outputs, counted across runs in a ledger
  (`.claimseed-mcp.json`) with each file's size and SHA-256. Over the quota it deletes its own oldest outputs from the
  current run, and only files still exactly as it wrote them; the right to delete is kept in memory, not in the
  ledger, so an edited ledger cannot make it delete anything. It never deletes any other file, including its outputs
  from earlier runs: when those alone fill the quota, a render is refused until you remove some. Run one server per
  folder.
- **Time and load.** One shared browser per server process; `CLAIMSEED_MCP_CONCURRENCY` renders at once (default 2,
  at most 4) and up to 4 more waiting, after which a render is refused as busy. A render that takes longer than
  `CLAIMSEED_MCP_TIMEOUT_MS` (default 30000) fails and the browser is restarted; a render running beside it at that
  moment fails too and can be retried. The browser closes after a minute without renders. A protocol message over
  4 MB closes the server.
- **Rendering is locked down** as in `@claimseed/core`: HTML is printed from memory with JavaScript off, a strict
  CSP, request interception and a dead proxy (see `SECURITY.md`). Run the Docker image with the flags above.
- **Page images are drawn from the stamped PDF** by [PDF.js](https://mozilla.github.io/pdf.js/) in a page of the
  same browser, in a browser context of its own that is closed after each render. That page runs script (PDF.js),
  but it opens only the PDF the server just rendered, loads only PDF.js and its fonts from this package (served
  from memory), has scripting in PDFs off and no network. The images show the specimen band and watermark like the
  PDF, and each image file carries the specimen text in its metadata (PNG `tEXt`, or Exif and a comment in a JPEG).
- **Reports are capped and never echoed.** `verify_document` refuses a report over 5,000 fields, 1,000 errors,
  200-character paths or 1,000-character values, or in any other shape, with a message that gives positions only.
  Its result holds counts, rates, answer-key paths, kinds and decoy ids; nothing the caller sent comes back, and
  nothing in a report is used as a file path.
- **Output is marked.** Every page carries the specimen band and watermark and the PDF metadata says it is a
  synthetic specimen; no tool argument turns that off. See `policy://synthetic-data` for acceptable use.

## Develop

```sh
npm test -w @claimseed/mcp          # end to end through the MCP client over stdio; rendering tests need Chrome
npm run sync-resources -w @claimseed/mcp   # after changing schemas/ or the two documents in docs/ it serves
```
