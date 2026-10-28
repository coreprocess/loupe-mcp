# Loupe MCP

Loupe is an MCP server that reads documents for AI agents. It turns PDFs, scans, photos and Office files into text, at one of two quality levels:

| Quality | How | Result |
|---|---|---|
| `fast` | Azure Document Intelligence, layout model | Markdown per page |
| `accurate` | Document Intelligence (high-resolution OCR), the PDF's text layer and form fields, and an image of the page, reconciled per page by a vision model | HTML per page; photos and drawings described, checkboxes, handwriting and strike-through marked |

Accepted inputs: PDF; JPEG, PNG, BMP, TIFF (multi-page), HEIC/HEIF; DOCX, DOCM, XLSX, PPTX; HTML. Types are detected by content, never by name.

Agents upload files from their sandbox with `curl` to a signed URL, submit them as one batch job, and read the text page by page in context or download it. Jobs run independently of the MCP connection, report progress per document, and continue on another replica if one restarts. One Loupe deployment serves many projects.

The full design is in [docs/CONCEPT.md](docs/CONCEPT.md).

## Tools

| Tool | Purpose |
|---|---|
| `create_upload` | Creates an upload and returns a signed URL; `PUT` each file to `<uploadUrl><name>` |
| `submit` | Starts a job over an upload's files at quality `fast` or `accurate`, optionally with a language hint and a page selection |
| `get_job` | Status, progress per document, page methods, and one manifest URL for downloads |
| `read_result` | Whole pages of one document's transcript, as many as fit into a window |
| `cancel_job` | Stops a job; documents already read stay readable |

A typical session:

```text
create_upload()                                   → u_8sLx2…, uploadUrl
submit("u_8sLx2…", "accurate", language: "de")    → j_4fKq9…, 120 documents
get_job("j_4fKq9…", wait: 10)                     → running, 37 of 120 succeeded
read_result("j_4fKq9…", "contract.pdf")           → pages 1–4
```

```bash
U="<uploadUrl>"; for f in scans/*; do curl -fsS -T "$f" "$U"; done
M="<download.manifestUrl>"; B="${M%/manifest.json}"
curl -fsS "$M" | jq -r '.documents[] | select(.status == "succeeded") | .path' \
  | xargs -P4 -I{} curl -fsS --create-dirs -o {} "$B/{}"
```

## Run locally (stdio)

Requires Node.js 24, pnpm, and an Azure Document Intelligence resource plus an Azure OpenAI deployment of a vision model.

```bash
pnpm install
cp .env.example .env.loupe   # add your endpoints and keys
node src/index.ts --env-file .env.loupe
```

Register it with Claude Code:

```bash
claude mcp add loupe -- node /path/to/loupe-mcp/src/index.ts --env-file /path/to/.env.loupe
```

In stdio mode, the store is `./.loupe/store`, and upload and download URLs point to a small HTTP endpoint on `127.0.0.1` that the server starts alongside.

With Docker (the published image runs the HTTP transport by default):

```bash
docker run -i --rm --env-file .env.loupe \
  -e LOUPE_TRANSPORT=stdio -e LOUPE_HOST=0.0.0.0 -e LOUPE_PORT=8765 \
  -e LOUPE_PUBLIC_URL=http://127.0.0.1:8765 -p 127.0.0.1:8765:8765 \
  ghcr.io/coreprocess/loupe-mcp:0.1.0
```

## Deploy

Loupe runs as one shared container deployment, protected by Microsoft Entra ID (OAuth 2.1, MCP authorization spec): directly when the host is on a domain verified in the tenant, otherwise through Loupe's built-in authorization server, which signs users in at Entra (`LOUPE_AUTH=entra-broker`). See [docs/deployment.md](docs/deployment.md), the configuration reference in [docs/configuration.md](docs/configuration.md), and the Terraform module in [terraform/](terraform/).

## Development

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests, no Docker
pnpm test:integration                       # Azurite, two replicas, curl; needs Docker
```

The tests run against mocks of Document Intelligence and Azure OpenAI; test documents are generated.

## License

[MIT](LICENSE)
