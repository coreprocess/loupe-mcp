# Loupe MCP: Concept

Status: draft for review · 2026-10-28

Loupe is an MCP server that reads documents for AI agents. It turns PDFs, scans, photos and Office files into text. An agent uploads files over HTTP from its sandbox, submits them as one batch job at one of two quality levels, and gets the text per document and page: either paged into context, or downloaded.

- **`fast`:** Azure Document Intelligence reads the document with its layout model. The result is Markdown per page.
- **`accurate`:** Document Intelligence, the PDF's own text layer and form fields, and a rendered image of the page are reconciled per page by a vision model. The result is HTML per page, with every photo and drawing described.

Unlike Periscope, Loupe is deployed **once** and serves every project whose users hold its app role. It has no data sources: it reads only what agents upload, and writes only to its own store.

**Clients:** Claude Code in the IDE and on the CLI, and Claude Code on the web, including agent workflows that run unattended in the cloud. Any MCP client that supports the MCP authorization spec should work. Uploads and downloads need a client that can run `curl`.

---

## 1. Goals and non-goals

**Goals**
- One server, shipped as one Docker image, deployed once and shared by projects. Configuration through environment variables only.
- **A small tool set:** `create_upload`, `submit`, `get_job`, `read_result`, `cancel_job`.
- **Uploads from the agent sandbox.** `create_upload` returns a signed URL, and the agent `PUT`s any number of files to it with `curl`. This is the reverse of Periscope's downloads.
- **Batch jobs.** A job covers any number of documents, runs independently of MCP requests, reports progress per document, and continues on another replica when one restarts.
- **Two quality levels** with a clear trade-off between cost and quality, chosen per job.
- **Results in context or as downloads:** page windows through `read_result`, whole documents over HTTP.
- Safe, usable authentication for local and cloud clients, with no static API keys.
- Deployment through infrastructure as code (Terraform).

**Non-goals**
- Interpretation of the text: field extraction, classification, summaries, translation. Loupe transcribes; what the text means is the agent's business.
- Containers and media: e-mails, archives, e-invoices, audio and video. An agent unpacks them itself and uploads the parts it wants read.
- Fetching documents from URLs or storage accounts. Documents only arrive through uploads.
- Isolation of jobs between users (§7.3).
- Machine-to-machine access without a user (e.g. CI pipelines with app-only tokens).

---

## 2. Input types and quality levels

| Input                                                       | `fast`                                   | `accurate`                                                                                                                  |
| ----------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| PDF                                                         | Document Intelligence layout, Markdown   | Per page: Document Intelligence (high-resolution OCR), text layer, form fields and page image, reconciled by the vision model (§6.2) |
| Images: JPEG, PNG, BMP, TIFF (multi-page), HEIC/HEIF        | Document Intelligence layout, Markdown   | Per page: Document Intelligence (high-resolution OCR) and the image, reconciled by the vision model                         |
| Office: DOCX, DOCM, XLSX, PPTX; HTML                        | Document Intelligence layout, Markdown   | Same as `fast`. These files carry their text; there is nothing to recognize optically.                                     |

**What the levels cost.** `fast` is one Document Intelligence analysis per document, without add-ons. `accurate` is one analysis with the high-resolution OCR add-on, plus one vision-model call per page (up to `LOUPE_ACCURATE_MAX_PAGES`, §4). It is considerably slower and more expensive per page, and worth it for scans, photos, handwriting, forms, poor print and dense tables.

**Type detection** is by content, never by file name or `Content-Type`: magic bytes for PDF and the image formats, the package's own `[Content_Types].xml` for Office files, a document prolog for HTML. A DOCM is rewritten into a DOCX before analysis, because Document Intelligence does not take macro-enabled packages; the macros stay inert. Any other type is refused at upload (§6.5).

**Language.** `submit` takes an optional `language` (BCP 47, e.g. `de`). It is passed to Document Intelligence as the `locale` hint and to the vision model. Without it, both detect the language themselves. Transcripts are never translated.

**Output.** Each document yields one text file. Every page is wrapped in a `<page number="N">…</page>` element, so agents can address, split and grep pages in both formats.
- **`fast` → Markdown** (`.md`), as Document Intelligence writes it: headings, paragraphs, tables as HTML `<table>`, selection marks as `☒`/`☐`, figures as `<figure>`. Page headers and footers stay as the service marks them (`<!-- PageHeader="…" -->`); page numbers and page breaks are dropped, since the `<page>` elements carry them.
- **`accurate` → HTML** (`.html`): one semantic fragment per page. Page furniture sits in `<header>`/`<footer>`, photos and drawings in `<figure><figcaption>` with a full description, checkboxes as `[ ]`/`[x]`/`[?]`, handwriting and strike-through marked (§6.2).

Every page records the **method** that produced it: `vision`, `layout` (the Document Intelligence transcript), `text-layer` (the PDF's text and form fields) or `none` (a placeholder for a page nothing could read). An `accurate` page that the vision model could not deliver falls back, page by page, and says so.

---

## 3. Architecture

```
                                                        ┌──────────────────────────────────────────────┐
Claude Code (IDE/CLI) ─┐  MCP + OAuth                   │ Loupe (container)                            │
Claude Code (cloud)   ─┼─────────────▶ /mcp ───────────▶│   control plane: MCP tools                   │
claude.ai connector   ─┘                                │                                              │
agent sandbox (curl) ── PUT ─▶ /u/<signed-token>/… ────▶│   uploads ──────▶ store                      │
                     ◀─ GET ── /r/<signed-token>/… ◀────│   downloads ◀──── store                      │
                                                        │   job runners ──▶ Azure Document Intelligence│
                                                        │               ──▶ Azure OpenAI (vision model)│
                                                        └──────────────────────────────────────────────┘
                                                          Store: Loupe's own Blob container
```

- **Deployment location:** Loupe reaches no private data sources, only its store, Document Intelligence, Azure OpenAI and Entra ID. It needs no VNet of its own and can run in any Container Apps environment; private endpoints for its dependencies are optional.
- **Control plane (MCP):** create uploads, submit jobs, report status, read page windows, cancel.
- **Data plane (HTTP):** uploads (`PUT /u/…`) and downloads (`GET /r/…`), both behind signed, expiring URLs, because `curl` in a sandbox can't do OAuth. Plain HTTP on the same container.
- **Store:** Loupe's own Blob container holds uploads, job state and results, and deletes them after a retention period. Replicas hold no state of their own: any replica answers any tool call, upload or download from the store.
- **Job runners:** every replica runs jobs. A job is leased to one replica at a time, and another replica takes it over when the lease lapses (§6.4).
- **Transport:** MCP Streamable HTTP for deployed instances, and stdio for local development. In stdio mode the store is a local directory, and Loupe also starts the HTTP data plane on `127.0.0.1`, so upload and download URLs work the same way as in a deployment.
- **Tech stack:** TypeScript on Node.js 24, as Periscope (§9.1).

---

## 4. Configuration

All configuration comes from environment variables. In Azure, secrets come in as Key Vault references. For local development, `--env-file <path>` loads a gitignored dotenv file. Loupe refuses to start, naming the offending variable, when a value is invalid, a required one is missing, or `LOUPE_RETENTION` does not exceed `LOUPE_MAX_JOB_DURATION` plus `LOUPE_URL_TTL`.

| Variable                                                  | Default                                  | Purpose                                                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOUPE_TRANSPORT`                                         | `stdio`                                  | `stdio` or `http`                                                                                                                               |
| `LOUPE_PORT`                                              | `8080`                                   | HTTP port                                                                                                                                       |
| `LOUPE_PUBLIC_URL`                                        | (required for http)                      | Public base URL, e.g. `https://loupe.example.com`. The MCP endpoint is `<base>/mcp`, uploads are `<base>/u/…`, downloads `<base>/r/…`.        |
| `LOUPE_AUTH`                                              | `entra`                                  | `entra`, `entra-broker`, or `none` (only with stdio or a localhost bind) (§7.2)                                                                 |
| `LOUPE_AUTH_TENANT_ID`, `LOUPE_AUTH_CLIENT_ID`            |                                          | Entra tenant and Loupe's app registration. Broker mode takes the same further settings as Periscope's, with the `LOUPE_` prefix.             |
| `LOUPE_AUTH_REQUIRED_ROLE`                                | `Loupe.User`                             | App role required for any access                                                                                                                |
| `LOUPE_STORE`                                             | `azureblob` (http) / `filesystem` (stdio) | Where uploads, job state and results are kept                                                                                                  |
| `LOUPE_STORE_ACCOUNT_URL`, `LOUPE_STORE_CONTAINER`        |                                          | Store for `azureblob`, accessed with the managed identity; the deployment creates the container                                                 |
| `LOUPE_STORE_DIR`                                         | `./.loupe/store`                         | Store for `filesystem`                                                                                                                          |
| `LOUPE_RETENTION`                                         | `P2D`                                    | How long uploads, jobs and results are kept, counted from their creation                                                                       |
| `LOUPE_URL_TTL`                                           | `PT1H`                                   | Lifetime of a signed upload or download URL. The tools always issue fresh URLs.                                                                 |
| `LOUPE_SIGNING_KEY`                                       | (secret)                                 | Root key for URL signing and broker mode. Rotating it revokes all outstanding URLs (and, in broker mode, signs everybody out).                 |
| `LOUPE_DOCUMENT_INTELLIGENCE_ENDPOINT`                    | (required)                               | Endpoint of the Azure Document Intelligence resource                                                                                            |
| `LOUPE_DOCUMENT_INTELLIGENCE_KEY`                         |                                          | API key; without it, Loupe signs in with its managed identity                                                                                   |
| `LOUPE_OPENAI_ENDPOINT`                                   | (required)                               | Endpoint of the Azure OpenAI resource                                                                                                           |
| `LOUPE_OPENAI_KEY`                                        |                                          | API key; without it, Loupe signs in with its managed identity                                                                                   |
| `LOUPE_VISION_MODEL`                                      | `gpt-5.6-luna`                           | Deployment name of the vision model for `accurate`                                                                                              |
| `LOUPE_VISION_REASONING_EFFORT`                           | `medium`                                 | Reasoning effort of the page calls                                                                                                              |
| `LOUPE_MAX_FILE_BYTES`                                    | `134217728` (128 MiB)                    | Largest file an upload takes                                                                                                                    |
| `LOUPE_UPLOAD_MAX_FILES`                                  | `1000`                                   | Most files in one upload                                                                                                                        |
| `LOUPE_UPLOAD_MAX_BYTES`                                  | `10737418240` (10 GiB)                   | Most bytes in one upload                                                                                                                        |
| `LOUPE_MAX_PAGES`                                         | `2000`                                   | Most pages Loupe reads of one document; a longer one fails with `too_many_pages` unless `pages` selects fewer                                  |
| `LOUPE_ACCURATE_MAX_PAGES`                                | `100`                                    | Pages per document the vision model transcribes; the pages after them are read as in `fast` and marked `layout`                                |
| `LOUPE_MAX_JOB_DURATION`                                  | `PT12H`                                  | A job's documents still open after this fail with `timeout`                                                                                     |
| `LOUPE_ANALYSIS_CONCURRENCY`                              | `4`                                      | Document Intelligence analyses in flight per replica                                                                                            |
| `LOUPE_VISION_CONCURRENCY`                                | `8`                                      | Vision-model page calls in flight per replica                                                                                                   |
| `LOUPE_MAX_ACTIVE_JOBS`                                   | `8`                                      | Jobs one replica runs at once (§6.4)                                                                                                            |
| `LOUPE_READ_MAX_BYTES`                                    | `65536`                                  | Maximum response size of a `read_result` window                                                                                                 |
| `LOUPE_AUDIT_LOG`                                         | `stdout`                                 | `stdout`, `stderr` or a file path (JSONL)                                                                                                       |
| `AZURE_CLIENT_ID`                                         |                                          | Client ID of Loupe's user-assigned managed identity, used by `DefaultAzureCredential`                                                          |

Example (Terraform, Azure Container App):

```hcl
env = [
  { name = "LOUPE_TRANSPORT",                      value = "http" },
  { name = "LOUPE_PUBLIC_URL",                     value = "https://loupe.example.com" },
  { name = "LOUPE_AUTH_TENANT_ID",                 value = data.azuread_client_config.current.tenant_id },
  { name = "LOUPE_AUTH_CLIENT_ID",                 value = azuread_application.loupe.client_id },
  { name = "AZURE_CLIENT_ID",                      value = azurerm_user_assigned_identity.loupe.client_id },
  { name = "LOUPE_STORE_ACCOUNT_URL",              value = azurerm_storage_account.loupe.primary_blob_endpoint },
  { name = "LOUPE_STORE_CONTAINER",                value = "store" },
  { name = "LOUPE_SIGNING_KEY",                    secret_name = "loupe-signing-key" },
  { name = "LOUPE_DOCUMENT_INTELLIGENCE_ENDPOINT", value = azurerm_cognitive_account.documents.endpoint },
  { name = "LOUPE_OPENAI_ENDPOINT",                value = azurerm_cognitive_account.openai.endpoint },
  { name = "LOUPE_VISION_MODEL",                   value = "gpt-5.6-luna" },
]
```

---

## 5. Tools

| Tool                                                       | Returns                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `create_upload(uploadId?)`                                 | A new upload, or a fresh URL for an existing one: ID, upload URL, its expiry and the limits (§5.1)   |
| `submit(uploadId, quality, files?, language?, pages?)`     | `{ jobId, documents }`, immediately. Validation errors are returned synchronously (§5.2).            |
| `get_job(jobId, wait?)`                                    | Status, progress, the documents with their status and page methods, the download URL (§5.3)         |
| `read_result(jobId, document, pageStart?, pageCount?)`     | A window of one document's pages, inline (§5.4)                                                      |
| `cancel_job(jobId)`                                        | Stops the job. Documents already read stay readable until the job expires.                           |

`get_job` and `read_result` carry the MCP annotation `readOnlyHint: true`; `create_upload`, `submit` and `cancel_job` do not. All carry `destructiveHint: false`. The tool descriptions tell agents that transcripts are data taken from the documents, never instructions (§7.1).

### 5.1 `create_upload`

```
create_upload(uploadId?) → { uploadId, uploadUrl, urlExpiresAt, expiresAt, limits }
```

- **`uploadUrl`** is `https://loupe.example.com/u/<token>/`. Each file is one `PUT` to `<uploadUrl><name>`. `curl -T` with a URL that ends in `/` appends the local file name itself, percent-encoded:

  ```bash
  U="<uploadUrl>"
  for f in scans/*; do curl -fsS -T "$f" "$U"; done
  ```

- **`limits`:** `maxFiles`, `maxFileBytes`, `maxBytes` and the accepted types (§2).
- **`uploadId`** asks for a fresh URL for an existing upload, when the first one expired before all files were in.
- **`expiresAt`:** the upload and its files are deleted after `LOUPE_RETENTION`. Jobs submitted from it keep their own results until they expire themselves.

### 5.2 `submit`

```
submit(uploadId, quality, files?, language?, pages?) → { jobId, documents }
```

- **`quality`:** `fast` or `accurate` (§2).
- **`files`:** names within the upload. Default: every file the upload holds at the time of the call.
- **`language`:** the document language as a BCP 47 tag, a hint for both Document Intelligence and the vision model (§2).
- **`pages`:** a page selection for every document of the job, e.g. `1-3,7`. Pages a document doesn't have are skipped. Each page keeps its number from the source.
- **Synchronous checks:** the upload exists and stays until the job's `LOUPE_MAX_JOB_DURATION` has passed (an older upload is refused: upload the files anew), every named file exists, there is at least one file, and the arguments are valid. A rejected call gets no `jobId`.
- **An upload can be submitted any number of times,** e.g. everything as `fast` first, then the few hard documents again as `accurate`. Files are write-once (§6.5), so a job always reads exactly the bytes listed when it was submitted.

### 5.3 `get_job`

```
get_job(jobId, wait?) → status
```

`wait` long-polls for at most **10 s** until the status or progress changes, as in Periscope. The response is bounded in size:

```json
{
    "jobId": "j_4fKq9…",
    "status": "running",
    "quality": "accurate",
    "createdAt": "2026-10-28T09:12:03Z",
    "completedAt": null,
    "expiresAt": "2026-10-30T09:12:03Z",

    "progress": { "documents": 120, "succeeded": 37, "failed": 1, "pages": 812, "pagesDone": 233 },

    "documents": [
        { "name": "contract.pdf", "status": "succeeded", "type": "application/pdf", "pages": 4,
          "methods": { "vision": 4 }, "bytes": 18234 },
        { "name": "receipt.heic", "status": "failed", "type": "image/heic",
          "error": { "code": "unreadable", "message": "The image could not be decoded." } },
        { "name": "scan-0003.tif", "status": "running", "type": "image/tiff" }
    ],
    "documentsTruncated": false,

    "download": {
        "manifestUrl": "https://loupe.example.com/r/eyJ…/manifest.json",
        "urlExpiresAt": "2026-10-28T10:31:44Z"
    }
}
```

| Field                     | Meaning                                                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                  | `queued`, `running`, `completed` (every document reached a final status), `cancelled` or `expired`. Failures are per document; a job with failed documents is still `completed`.            |
| `documents[].status`      | `queued`, `running`, `succeeded`, `failed` or `cancelled`                                                                                                                                     |
| `documents[].methods`     | How many pages each method produced (§2); for `accurate`, anything other than `vision` shows where the vision model did not deliver                                                          |
| `documents[].bytes`       | Size of the result file                                                                                                                                                                       |
| `documents[].error.code`  | `unreadable` (corrupt, encrypted, or refused by Document Intelligence), `too_many_pages`, `timeout`, `service_unavailable` (the services stayed unavailable through every retry), `internal` |
| `documentsTruncated`      | Only the first 200 documents are inline; the manifest lists all                                                                                                                              |
| `download.manifestUrl`    | The single entry point for downloads (§6.6). It is already valid while the job runs and lists the documents finished so far.                                                                |

Like Periscope, `get_job` reports what is stored, on every replica alike: a status is reported only once it has been written to the store.

### 5.4 `read_result`

```
read_result(jobId, document, pageStart?, pageCount?) → window
```

```json
{
    "document": "contract.pdf",
    "format": "html",
    "pageCount": 4,
    "pages": [
        { "number": 1, "method": "vision", "content": "<header>…</header><h1>Service agreement</h1>…" },
        { "number": 2, "method": "vision", "content": "…" }
    ],
    "nextPage": 3
}
```

- A window holds whole pages, as many as fit into `LOUPE_READ_MAX_BYTES`, and at least one. A single page larger than the cap is cut off and marked `truncated: true`; the download holds it in full.
- A document is readable once it has `succeeded`, while the rest of the job still runs.

### 5.5 Typical agent flow

```
create_upload()                                   → u_8sLx2…, uploadUrl
U="<uploadUrl>"; for f in scans/*; do curl -fsS -T "$f" "$U"; done
submit("u_8sLx2…", "accurate", language: "de")    → j_4fKq9…, 120 documents
get_job("j_4fKq9…", wait: 10)                     → running, 37 of 120 succeeded
read_result("j_4fKq9…", "contract.pdf")           → pages 1–4, while the job still runs
get_job("j_4fKq9…", wait: 10)                     → completed, 119 succeeded, 1 failed
M="<download.manifestUrl>"; B="${M%/manifest.json}"
curl -fsS "$M" | jq -r '.documents[] | select(.status == "succeeded") | .path' \
  | xargs -P4 -I{} curl -fsS --create-dirs -o {} "$B/{}"
```

---

## 6. Processing and data plane

### 6.1 `fast`

- One Document Intelligence analysis per document: model `prebuilt-layout`, output `markdown`, `locale` from `language`, `pages` from the job, no add-on features. The file goes to the service as the request body, never through a URL, and never base64-encoded.
- The service runs the analysis as a long-running operation; Loupe polls it. An analysis that doesn't finish within 20 minutes is abandoned and started again, up to three attempts; then the document fails with `timeout`.
- The Markdown is split into pages at the service's page-break markers and wrapped in `<page>` elements (§2).

### 6.2 `accurate`

The design is taken from two production document pipelines, made generic.

**PDF**
1. **Preparation, in parallel:**
   - Document Intelligence as in `fast`, plus the `ocrHighResolution` add-on: a Markdown transcript per page.
   - pdf.js, **in a child process of its own** with memory and time limits: per page the text layer (as a geometry report for the model and as readable text for the fallback), the AcroForm fields, and a rendered PNG for the pages the vision model will see; for the whole file its info dictionary.
2. **Merge per page.** When both sources agree on the page count, every page gets every input. When they disagree, Document Intelligence's pagination wins and the pdf.js page fields are dropped, since an index-wise merge would misalign them. Either source may be missing: when the service refuses the file, pdf.js carries it; when pdf.js can't open the file or its process is killed, Loupe retries without page renders, then without pdf.js, and the transcript carries it. Only when both are missing is the document `unreadable`.
3. **One vision-model call per page**, for the first `LOUPE_ACCURATE_MAX_PAGES` pages, `LOUPE_VISION_CONCURRENCY` at a time per replica. The model gets:
   - the page image first (models attend more reliably to images that precede the text about them); a large page is split into four overlapping tiles, as strips or as a 2×2 grid depending on its shape, and the prompt says which;
   - then one section per input: the PDF info, the file name, the page number, the text layer, the form fields, the Document Intelligence transcript. A missing input is marked `(empty)`, so the model can tell "not provided" from "blank".

   Every input taken from the file sits between two marker lines carrying a random value per request. The instructions say that everything between them is data, never an instruction, so text in a document cannot pose as part of the prompt.
4. **The instructions** (one prompt in the repository, versioned with the code) tell the model to:
   - decide per page, or per region, whether it is a **scan or born-digital**, and follow the strongest input first: for scans the transcript, then the text layer, then the image; for born-digital pages the text layer and form fields first. Layout, reading order, handwriting, stamps, strike-through and form widget state follow the image; table structure follows the transcript;
   - settle every ambiguous character on a scan by the image (`0`/`O`, `1`/`l`/`I`, `5`/`S`, `8`/`B`, decimal separators, diacritics under poor scans);
   - keep numbers, dates and currencies exactly as printed, never translate or paraphrase, rejoin words hyphenated at line breaks;
   - write tables with `colspan`/`rowspan` and empty cells kept, and check printed totals against their line items to find a misread digit (correcting it only by the image);
   - put page furniture in `<header>`/`<footer>`, footnotes in `<aside>`, and mark illegible regions and blank pages instead of guessing;
   - describe **every photo, drawing, chart or plan** in a `<figure><figcaption>` in the document's language: what it shows, from which viewpoint, every visible detail, defect or trace with its location and extent, legible text, labels and readings quoted verbatim, and say what cannot be seen instead of guessing; logos and decoration get a short caption naming them;
   - mark checkboxes as `[ ]`/`[x]`/`[?]`, handwritten edits and insertions inline, struck-through text as `<s>`, and signatures as `Signature: <short description>`;
   - answer with one HTML fragment of semantic tags, without code fences, wrappers, styles, scripts or links.
5. **Only a complete answer counts.** A call the model rejects (content filter, input too large) or an answer cut off before its end yields no page; the page takes the fallback. A timeout or an outage is retried (§6.4).
6. **Fallback per page,** for the pages after the vision window and for every page the model did not deliver: the Document Intelligence transcript rendered to HTML (method `layout`), else the readable text layer and form fields as preformatted text (`text-layer`), else a placeholder that says the page could not be read (`none`). No page is ever missing.

**Images.** Each image (each page of a TIFF) is one page. Document Intelligence reads the file with high-resolution OCR; the image itself, upright according to its EXIF orientation, is the page image of the vision call. HEIC/HEIF and BMP are converted to JPEG first, and TIFF pages to PNG, since the model takes none of these formats. There is no text layer and there are no form fields. The fallback is the transcript, then the placeholder.

**Office files and HTML** are read as in `fast` (§2).

### 6.3 Results in the store

```
uploads/<uploadId>/upload.json              created, expiry, issuing user
uploads/<uploadId>/files/<name>             the uploaded bytes, write-once
jobs/<jobId>/job.json                       quality, options, the files with size and SHA-256, issuing user
jobs/<jobId>/state.json                     status and progress per document
jobs/<jobId>/cancel.json                    present once cancel_job was called
jobs/<jobId>/manifest.json                  the download manifest (§6.6)
jobs/<jobId>/documents/<name>.md|.html      one result file per document
queue/<jobId>                               present while the job is open; leased by the replica running it
```

A document's result file is written once, when the document succeeds, together with its page index (each page's number, method, and byte offset and length in the file). `read_result` reads the index and fetches only the byte range of the pages in its window.

### 6.4 Execution

- **Queue and leases.** `submit` writes the job and its queue entry. Every replica polls the queue (every 2 s, and at once after a local `submit`) and takes up to `LOUPE_MAX_ACTIVE_JOBS` jobs by acquiring a 60-second blob lease on their queue entries, renewed every 15 s. Only the lease holder writes a job's state, so state has one writer. The oldest job is taken first.
- **Takeover.** When a replica dies or loses its lease, the lease lapses and another replica (or the same one after its restart) takes the job over. Documents that succeeded are kept; documents that were running start again. In the filesystem store (stdio), one process holds every job, and leases are in memory.
- **Shutdown.** On SIGTERM a replica stops taking documents, aborts its running calls, writes the state of its jobs and releases its leases, so another replica continues at once.
- **Fair share.** A replica's running jobs take turns: documents are started round-robin across them, within `LOUPE_ANALYSIS_CONCURRENCY` and `LOUPE_VISION_CONCURRENCY`. A single large batch therefore doesn't hold back a small job submitted after it.
- **Retries.** Throttling (`429`) and server errors of Document Intelligence and Azure OpenAI are retried with exponential backoff, honoring `Retry-After`, for up to 10 minutes per call; then the document fails with `service_unavailable`. A refusal of the file itself (`InvalidRequest`, `InvalidArgument`) is a verdict, not retried: `unreadable` in `fast`, the fallback in `accurate`.
- **Limits.** `LOUPE_MAX_JOB_DURATION` per job, `LOUPE_MAX_PAGES` per document, and the upload limits (§6.5).
- **Progress.** `state.json` is written on every finished document and at most every 5 s otherwise.
- **Cancellation.** `cancel_job` writes `cancel.json`; the lease holder sees it within a few seconds, aborts the running calls, and marks the open documents `cancelled`.
- **Expiry.** After `LOUPE_RETENTION`, Loupe deletes uploads and jobs, and a storage lifecycle rule one day later is the backstop. An expired job reports `expired`.

### 6.5 Uploads

- **Endpoint.** `PUT /u/<token>/<name>`, one file per request, body streamed into the store. Nothing else is served under `/u/`: no `GET`, no listing, no other methods. Uploaded files are never served back.
- **Token.** HMAC-signed with a key derived for this purpose from `LOUPE_SIGNING_KEY`, so an upload token can never pass as a download token or the reverse. It contains the upload ID, the issuing user and the expiry (`LOUPE_URL_TTL`). It is stateless and works on any replica.
- **Names.** One path segment, percent-decoded, valid UTF-8, at most 255 bytes, no control characters, no `/` or `\`, not `.` or `..`. Names are unique per upload and **write-once**: the store write is conditional (`If-None-Match: *`), so of two concurrent `PUT`s of one name exactly one succeeds, and the other gets `409`.
- **Checks while streaming.** The body is counted and hashed (SHA-256) on the way in; a file over `LOUPE_MAX_FILE_BYTES` is cut off with `413` and deleted. After the body, the type is detected from the content (§2); an unsupported type gets `415` and is deleted. Before a file is accepted, the upload's file count and bytes are checked against `LOUPE_UPLOAD_MAX_FILES` and `LOUPE_UPLOAD_MAX_BYTES` (`413`). Concurrent `PUT`s can exceed the byte limit by at most the files in flight.
- **Answer.** `201` with `{ "name", "bytes", "sha256", "type" }`, so the agent sees at once what Loupe recognized. Errors carry a JSON body with a code and message. An expired or invalid token gets `403`, an expired upload `410`.

### 6.6 Downloads

- **One URL per job.** `get_job` returns `https://…/r/<token>/manifest.json`; the token covers the job. The result files are addressed relative to it: `documents/<name>.md` or `documents/<name>.html`, path segments percent-encoded. `HEAD` and `Range` are supported. Only `manifest.json` and `documents/…` are served; `job.json`, `state.json`, `cancel.json`, the uploads and the queue never are.
- **Token.** As for uploads (§6.5), with its own derived key: job ID, issuing user, expiry. When it expires, a new `get_job` call yields a new base; the relative paths stay the same.
- **Served as stored,** with `Content-Length`, `ETag` and Range, no compression or other transformation in transit, and `Cache-Control: private, no-store, no-transform`. `.md` files are served as `text/markdown; charset=utf-8`, `.html` as `text/html; charset=utf-8` with `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`, so a transcript opened in a browser runs nothing; `manifest.json` as `application/json`.
- **Why a proxy and not SAS:** the store stays private, every download is audited, and there is no SAS generation at all.

**Manifest** (Loupe's own format, versioned, public contract):

```json
{
    "version": 1,
    "jobId": "j_4fKq9…",
    "quality": "accurate",
    "status": "completed",
    "format": "html",
    "documents": [
        {
            "name": "contract.pdf",
            "status": "succeeded",
            "type": "application/pdf",
            "sourceBytes": 482113,
            "sourceSha256": "…",
            "path": "documents/contract.pdf.html",
            "bytes": 18234,
            "sha256": "…",
            "pages": [
                { "number": 1, "method": "vision", "byteOffset": 0, "byteLength": 5120 },
                { "number": 2, "method": "vision", "byteOffset": 5120, "byteLength": 4410 }
            ]
        },
        {
            "name": "receipt.heic",
            "status": "failed",
            "type": "image/heic",
            "error": { "code": "unreadable", "message": "The image could not be decoded." }
        }
    ],
    "createdAt": "2026-10-28T09:12:03Z",
    "completedAt": "2026-10-28T09:58:40Z",
    "expiresAt": "2026-10-30T09:12:03Z"
}
```

While the job runs, the manifest lists every document with its current status; a document gets its `path` once its result file is complete. The page byte ranges let an agent fetch single pages with `curl -r`.

---

## 7. Security

### 7.1 Principles

- **A fixed outbound surface.** Loupe talks to its store, Document Intelligence, Azure OpenAI and Entra ID, and nothing else. It never fetches a URL from a request or a document: files reach Document Intelligence as bytes, pdf.js runs without network access and without evaluating scripts, and the vision model has no tools.
- **Uploaded files are untrusted.** Every local parser runs with limits:
  - pdf.js in a child process with memory and time limits; a reader that hangs or dies is killed and the document continues without it (§6.2);
  - image decoding (sharp, the HEIC decoder) with a pixel limit against decompression bombs;
  - ZIP reading (Office type detection, the DOCM rewrite) with limits on entry count and uncompressed size, without extracting anything else.
- **Prompt injection is contained, not prevented.** A document can contain text written to steer the vision model. The fences (§6.2) keep it from posing as instructions, and the model has no tools and no access to anything but the page, so the worst case is a wrong transcript of that one document. The tool descriptions tell agents that transcripts are document content, to be treated as data.
- **Fail closed.** Unknown file types are refused at upload, invalid configuration stops the start, invalid or expired tokens are refused.
- **Signed URLs are bearer capabilities.** An upload URL can only add new files to one upload until it expires; it can neither read nor overwrite. A download URL can only read one job's results. Both are issued only to holders of the app role, and every use is audited with the user who issued the URL. Rotating `LOUPE_SIGNING_KEY` revokes all of them.

### 7.2 Authentication

Authentication is the same as Periscope's, and its implementation is taken over from Periscope: users sign in with Microsoft Entra ID, and there are no static API keys.

- **`entra` (direct mode):** Loupe is an OAuth 2.1 resource server. Protected Resource Metadata at `/.well-known/oauth-protected-resource/mcp` names Entra as authorization server. Tokens are validated against the tenant's JWKS: issuer, `aud` = the app's client ID, expiry, the scope `Loupe.Access`, the app role. This needs the MCP URL as Application ID URI on a domain verified in the tenant.
- **`entra-broker` (broker mode):** Loupe is the authorization server towards MCP clients (stateless dynamic client registration, PKCE, a consent page) and a confidential web client towards Entra. Use it when the host is not on a verified domain.
- **`none`:** only with stdio or a localhost bind, for local development.

Clients connect as with Periscope: a claude.ai custom connector (preferred, also used by Claude Code on the web and by scheduled tasks), or `claude mcp add --transport http loupe https://loupe.example.com/mcp`.

**Network.** The endpoints must be publicly reachable over IPv4 for claude.ai connectors and cloud sessions. Uploads and downloads from a cloud sandbox need Loupe's hostname in the cloud environment's network access list; MCP traffic through a connector does not.

### 7.3 Authorization

- **One app role.** `LOUPE_AUTH_REQUIRED_ROLE` (by default `Loupe.User`) grants every tool and every upload and download URL. It is checked on every call.
- **Jobs and uploads are not isolated between users.** Every holder of the role can create uploads, submit any upload, and read and cancel any job, given its ID. IDs are random (128 bits) and there is no tool that lists jobs or uploads, so in practice a job is seen by whoever was handed its ID. IDs can therefore be passed between agents and team members. The job state records who created it, and the audit log records every access.
- **One deployment, many projects.** Everyone in the role's group shares the deployment. Documents that must not be reachable by that group belong in a deployment of their own.

### 7.4 Identities and permissions

Loupe uses **its own user-assigned managed identity**:

| Target                         | Role                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| Store                          | _Storage Blob Data Contributor_, scoped to the store container only                       |
| Azure Document Intelligence    | _Cognitive Services User_ (or an API key in `LOUPE_DOCUMENT_INTELLIGENCE_KEY`)            |
| Azure OpenAI                   | _Cognitive Services OpenAI User_ (or an API key in `LOUPE_OPENAI_KEY`)                    |
| Key Vault                      | _Key Vault Secrets User_ on each of its secrets (never on the whole vault)                |

### 7.5 Data protection and audit

- **Documents are data at rest.** Uploads and transcripts sit in Loupe's private store, encrypted at rest, and are deleted after `LOUPE_RETENTION`.
- **Documents go to the operator's AI services.** Pages and images are sent to the Document Intelligence and Azure OpenAI resources the operator configures. Their region or data zone decides where documents are processed.
- **Data leaves the network.** Windows go into LLM context, and downloads land in agent sandboxes. Access is therefore limited to the members of the app role.
- **Audit log** as JSONL to stdout. Every MCP call is logged with timestamp, user (`oid`, `upn`), tool, upload or job ID, documents, pages and outcome; every upload with name, bytes, SHA-256, detected type and client IP; every URL issuance and download. Document content and transcripts are never logged.
- **Errors to clients are summaries:** a code and a short message. Service responses, hostnames and stack traces go only to the operational log.

---

## 8. Deployment

### 8.1 Image

- `ghcr.io/coreprocess/loupe-mcp:<semver>`, public, built by GitHub Actions on each tag, with SBOM and provenance attestation. Deployments pin the version or digest.
- A slim Node 24 image: sharp brings its own libvips, pdf.js and the HEIC decoder are JavaScript/WASM.
- The same image runs in stdio mode for local development (`docker run -i …`, with a mounted store directory).

### 8.2 Reference deployment on Azure

- **Container App** in an existing Container Apps environment, single revision mode, **`minReplicas: 1`**, so open jobs keep running. More replicas share the jobs through the queue (§6.4).
- **Ingress:** the Container App's own ingress with a custom domain and managed certificate, or a gateway in front. Requirements:
  - **No response buffering:** Streamable HTTP uses SSE.
  - **Request size and duration** must admit an upload of `LOUPE_MAX_FILE_BYTES`.
  - **Idle timeouts can be short (about 10 s):** `get_job` waits at most 10 s, and MCP runs stateless without the standalone SSE stream.
  - **No access logs with `/u/…` and `/r/…` paths.** The path carries the token, a bearer capability. Loupe audits every upload and download itself.
- **Store:** a dedicated storage account without public access (or with a private endpoint), one container, and a lifecycle rule deleting blobs one day after `LOUPE_RETENTION`.
- **Azure Document Intelligence** and **Azure OpenAI** with a deployment of the vision model (`gpt-5.6-luna`), existing or dedicated.
- **User-assigned identity** with the roles from §7.4.
- **Entra app registration** (§7.2), with assignment required and the role assigned to the groups that may use Loupe.
- **Key Vault** secret for the signing key, referenced as a Container App secret.

### 8.3 Terraform module

A reusable module in this repository (`terraform/`). It takes the Container Apps environment, the Document Intelligence and Azure OpenAI resources, the vision deployment name and the groups to assign. It creates:
- the identity and its role assignments
- the app registration
- the store account with its container and lifecycle rule
- the signing key in Key Vault
- the Container App

---

## 9. Implementation

### 9.1 Technology choices

**TypeScript on Node.js 24**, the same stack as Periscope, for the same reasons: the teams that run it, the reference MCP SDK, and first-class Azure SDKs. The pipeline it takes over is TypeScript already.

| Area                   | Choice                                                                    | Notes                                                                                             |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Runtime and tooling    | Node.js 24 LTS, TypeScript (strict, type stripping), pnpm, Biome, `node:test`, Testcontainers |                                                                         |
| HTTP                   | Express 5                                                                 | One server for `/mcp`, `/u/…` and `/r/…`                                                          |
| MCP                    | `@modelcontextprotocol/server`, `/express`, `/node` (v2 SDK)              | Stateless Streamable HTTP and stdio; bearer validation on `jose`                                  |
| Validation             | `zod`                                                                     | Configuration and tool schemas                                                                    |
| Store                  | `@azure/storage-blob`, `@azure/identity`                                  | Conditional writes for write-once files, blob leases for the queue                                |
| Document Intelligence  | `@azure-rest/ai-document-intelligence`                                    | Long-running analysis with its poller                                                             |
| Vision model           | `openai` (Azure OpenAI)                                                   | Chat completions with image parts                                                                 |
| PDF                    | `pdfjs-dist`                                                              | In a child process; text layer, AcroForm fields, page renders                                     |
| Images                 | `sharp`, `heic-decode`                                                    | Rotation, conversion, tiling, TIFF pages                                                          |
| Office                 | a streaming ZIP reader                                                    | Type detection from `[Content_Types].xml`, the DOCM rewrite                                       |
| Fallback rendering     | `markdown-it`                                                             | Transcript Markdown to HTML, with the service's literal `<table>` markup let through              |
| Logging and audit      | `pino`                                                                    | JSON lines to stdout                                                                              |

**Shared code with Periscope.** Authentication (both modes), URL signing, the store client, the Range responses and the audit log are copied from Periscope rather than shared as a package. The two servers evolve independently.

### 9.2 Code structure

```
src/
  index.ts                 CLI entry: transport selection, --env-file
  config/                  env schema
  auth/                    PRM endpoint, JWT validation, role checks; broker
  tools/                   the five MCP tools
  store/                   azureblob, filesystem; leases
  uploads/                 PUT endpoint, name rules, type detection, limits
  download/                GET endpoint, manifest, Range, headers
  signing/                 upload and download tokens, key derivation
  jobs/                    queue, leases, scheduler (fair share), state, retries, cancellation
  reading/
    fast.ts                Document Intelligence layout → Markdown pages
    accurate/              PDF preparation (Document Intelligence + pdf.js child), merge,
                           page call (tiles, fences, prompt), fallback recipe, images
    services/              Document Intelligence and Azure OpenAI clients
  core/                    limits, audit, errors
terraform/                 reference deployment module
test/
  unit/                    config, signing, names, type detection, page splitting, tiles, prompt, fallback, manifest
  integration/             Azurite, mock services, end to end
```

---

## 10. Testing

- **Unit:**
  - configuration validation;
  - URL signing: tampering, expiry, an upload token used for a download and the reverse;
  - name rules and percent-decoding;
  - type detection for every accepted type, plus wrong extensions, truncated files, polyglots and macro-enabled packages named `.docx`;
  - splitting the transcript into pages, tiling, the prompt with its fences, the fallback recipe, the manifest and the page index.
- **Integration** against Azurite and mocks of Document Intelligence (long-running operations, `429` with `Retry-After`, refusals, failed and never-finishing analyses) and Azure OpenAI (finish reasons, content-filter rejections, timeouts):
  - end to end with the real process and tokens from a local issuer: `create_upload` → `curl` uploads → `submit` → `get_job` → `read_result` while running → manifest download → checksums, for both quality levels and every input type;
  - uploads: limits, `409` on concurrent `PUT`s of one name, `415`, expired tokens, nothing readable under `/u/`;
  - downloads: Range, page byte ranges, internal files never served;
  - takeover: a replica killed mid-job, a second one finishes it without redoing succeeded documents; graceful shutdown; fair share between a large and a small job;
  - cancellation, maximum job duration, retention expiry;
  - hostile files: an image decompression bomb, a ZIP bomb in an Office package, a PDF that hangs pdf.js (reader killed, transcript carries the document), a document over `LOUPE_MAX_PAGES`.
- **Live check** (opt-in, not in CI) against real Document Intelligence and Azure OpenAI resources from a local `.env`: a synthetic corpus with a born-digital PDF, a scan, a phone photo, a filled-in form with handwriting, a multi-page TIFF, a HEIC photo and DOCX/XLSX/PPTX files, read at both levels. Test documents are generated; no real documents go into the repository.

---

## 11. Open questions

**To verify at deployment**
1. Entra end to end in the chosen mode, as for Periscope.
2. The ingress limits for uploads of `LOUPE_MAX_FILE_BYTES`.
3. Throughput limits of the Document Intelligence and Azure OpenAI resources against the concurrency defaults.

**Decided**
- Quality levels `fast` and `accurate`.
- No isolation of jobs between users (§7.3).
- The vision model is configurable per deployment; the default is `gpt-5.6-luna`.
- Uploads are write-once and can be submitted any number of times.
