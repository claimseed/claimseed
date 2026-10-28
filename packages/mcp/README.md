# @claimseed/mcp

An [MCP](https://modelcontextprotocol.io) server that lets an agent list, generate and render claimseed's synthetic
medical-billing specimen documents. It runs over stdio, writes only into one folder you give it, never reads a file
a client names, and needs no network access and no API key.

## Run it

Rendering needs Chrome or Chromium (`CLAIMSEED_CHROME=/path/to/chrome`, or an install in a usual place); listing and
`generate_data` do not.

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

Or from a checkout: `node packages/mcp/src/cli.js --workspace ./out`. With Docker, using the published image
`ghcr.io/claimseed/claimseed-mcp` (Chromium is inside it; `:latest`, or a version tag such as `:0.1.0`), or one you
build from the `Dockerfile` at the repository root (`docker build -t claimseed-mcp .`, then use `claimseed-mcp` as the
image name below):

```sh
docker run -i --rm --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" -v "$PWD/claimseed-out:/work" ghcr.io/claimseed/claimseed-mcp
```

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
| `render_document` | Renders one document to PDF in the workspace, with its ground-truth JSON beside it; returns both paths, the PDF's SHA-256, page count and the ground truth. |

Arguments are a type, a scenario slug and a seed (letters, digits, `.`, `_`, `-`; up to 64 characters). The same
type, scenario and seed always give the same data, and on Linux with the same Chrome build the same PDF bytes.

Resources: `schema://ground-truth` (the ground-truth JSON Schema), `catalog://scenarios`, `catalog://mutations`,
`docs://error-taxonomy`, `policy://synthetic-data`. Prompt: `build_test_case` (a goal, optionally a type) plans and
renders a small test set with expected results.

## Limits and safety

- **One folder.** The server writes only into the workspace folder (`--workspace` or `CLAIMSEED_WORKSPACE`), which
  must exist and may not be `/` or your home folder. It picks every file name itself
  (`<type>_<scenario>_<seed>_<random>.pdf` and `.ground-truth.json`), creates files exclusively and never through a
  symbolic link, and stops if the folder is moved or replaced by a link while it runs.
- **Quota.** `CLAIMSEED_MCP_QUOTA_MB` (default 500) caps the total size of its outputs. Over the quota it deletes its
  own oldest outputs, and only files still exactly as it wrote them (it keeps a ledger, `.claimseed-mcp.json`, with
  each file's size and SHA-256). It never deletes any other file. Run one server per folder.
- **Time and load.** One shared browser per server process; `CLAIMSEED_MCP_CONCURRENCY` renders at once (default 2,
  at most 4) and up to 4 more waiting, after which a render is refused as busy. A render that takes longer than
  `CLAIMSEED_MCP_TIMEOUT_MS` (default 30000) fails and the browser is restarted; a render running beside it at that
  moment fails too and can be retried. The browser closes after a minute without renders. A protocol message over
  4 MB closes the server.
- **Rendering is locked down** as in `@claimseed/core`: HTML is printed from memory with JavaScript off, a strict
  CSP, request interception and a dead proxy (see `SECURITY.md`). Run the Docker image with the flags above.
- **Output is marked.** Every page carries the specimen band and watermark and the PDF metadata says it is a
  synthetic specimen; no tool argument turns that off. See `policy://synthetic-data` for acceptable use.

## Develop

```sh
npm test -w @claimseed/mcp          # end to end through the MCP client over stdio; rendering tests need Chrome
npm run sync-resources -w @claimseed/mcp   # after changing schemas/ or the two documents in docs/ it serves
```
