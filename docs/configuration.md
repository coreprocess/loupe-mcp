# Configuration reference

All configuration comes from environment variables. For local use, `--env-file <path>` loads one or more dotenv files. Loupe refuses to start, naming the variable, if anything required is missing or a value is invalid.

## Server and authentication

| Variable | Default | Description |
|---|---|---|
| `LOUPE_TRANSPORT` | `stdio` | `stdio` (local MCP over stdin/stdout) or `http` (Streamable HTTP for deployments) |
| `LOUPE_HOST` | `0.0.0.0` (http), `127.0.0.1` (stdio) | Bind address of the HTTP listener |
| `LOUPE_PORT` | `8080` (http), random (stdio) | HTTP port. In stdio mode the listener serves only uploads and downloads. |
| `LOUPE_PUBLIC_URL` | derived from host and port | Public base URL, e.g. `https://loupe.example.com`. The MCP endpoint is `<base>/mcp`, uploads are `<base>/u/…`, downloads `<base>/r/…`. Required for http with Entra auth. |
| `LOUPE_AUTH` | `entra` (http), `none` (stdio) | `entra`: Entra issues the tokens (needs the host on a verified domain). `entra-broker`: Loupe is the authorization server and signs users in at Entra (any host). `none` is only allowed with stdio or a localhost bind, and then rejects requests whose Host or Origin is not localhost or the public URL's host (DNS rebinding) |
| `LOUPE_AUTH_TENANT_ID` | | Entra tenant ID (required for `entra` and `entra-broker`) |
| `LOUPE_AUTH_CLIENT_ID` | | Client ID of the Loupe app registration: the expected token audience (`entra`) or the client Loupe signs in as (`entra-broker`) |
| `LOUPE_AUTH_CLIENT_ASSERTION_FILE` | `AZURE_FEDERATED_TOKEN_FILE` | `entra-broker`: file with the federated token Loupe presents to Entra (AKS workload identity provides it) |
| `LOUPE_AUTH_ASSERTION_IDENTITY` | | `entra-broker`: client ID of a user-assigned managed identity; its token is presented to Entra (Container Apps, App Service). The app registration trusts the identity as federated credential |
| `LOUPE_AUTH_CLIENT_SECRET` | | `entra-broker`: client secret instead of a federated token |
| `LOUPE_AUTH_REDIRECT_URIS` | `https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback` | `entra-broker`: HTTPS redirect URIs MCP clients may register; loopback (`http://localhost`, `127.0.0.1`, `[::1]`, any port) is always allowed |
| `LOUPE_AUTH_ACCESS_TOKEN_TTL` | `PT1H` | `entra-broker`: access token lifetime; roles are re-read from Entra at every refresh |
| `LOUPE_AUTH_SESSION_TTL` | `P30D` | `entra-broker`: refresh token lifetime, after which users sign in again |
| `LOUPE_AUTH_REQUIRED_ROLE` | `Loupe.User` | The one app role: it grants every tool |
| `LOUPE_AUTH_SCOPE` | `Loupe.Access` | `entra`: name of the delegated scope; clients request `<public url>/mcp/<scope>` |
| `LOUPE_AUTH_ISSUER` | `https://login.microsoftonline.com/<tenant>/v2.0` | Entra issuer; `entra-broker` reads its endpoints from the issuer's discovery document (override for sovereign clouds or tests) |
| `LOUPE_AUTH_JWKS_URI` | `https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys` | Signing keys (override for sovereign clouds or tests) |
| `LOUPE_AUTH_AUTHORIZATION_SERVER` | the issuer | `entra`: authorization server announced in the protected resource metadata |
| `LOUPE_SIGNING_KEY` | random per process | Root key (≥ 32 bytes) for upload and download URLs, and for the OAuth tokens of `entra-broker`. Required when replicas share an Azure store and for `entra-broker`. Rotating it revokes all URLs and signs everybody out. |
| `LOUPE_URL_TTL` | `PT1H` | Lifetime of signed upload and download URLs; the tools always issue fresh ones |
| `LOUPE_AUDIT_LOG` | `stdout` (http), `stderr` (stdio) | `stdout`, `stderr` or a file path (JSON lines) |
| `LOUPE_LOG_LEVEL` | `info` | Operational log level |
| `AZURE_CLIENT_ID` | | Client ID of a user-assigned managed identity for `DefaultAzureCredential` (store and AI services) |
| `LOUPE_VERSION` | set by the image build | Version reported by `--version` and to MCP clients; the release pipeline sets it from the tag |

## Store

| Variable | Default | Description |
|---|---|---|
| `LOUPE_STORE` | `azureblob` (http), `filesystem` (stdio) | Where uploads, job state and results are kept |
| `LOUPE_STORE_ACCOUNT_URL` | | Storage account for `azureblob`, accessed with the managed identity |
| `LOUPE_STORE_CONNECTION_STRING` | | Alternative to the account URL (e.g. Azurite) |
| `LOUPE_STORE_CONTAINER` | `store` | Blob container; the deployment creates it, Loupe does not |
| `LOUPE_STORE_DIR` | `./.loupe/store` | Directory for `filesystem` |
| `LOUPE_RETENTION` | `P2D` | How long uploads, jobs and results are kept, counted from their creation. Must exceed `LOUPE_MAX_JOB_DURATION` plus `LOUPE_URL_TTL`. |

## Azure AI services

| Variable | Default | Description |
|---|---|---|
| `LOUPE_DOCUMENT_INTELLIGENCE_ENDPOINT` | (required) | Endpoint of the Azure Document Intelligence resource, e.g. `https://documents-example.cognitiveservices.azure.com` |
| `LOUPE_DOCUMENT_INTELLIGENCE_KEY` | | API key; without it Loupe signs in with its managed identity (*Cognitive Services User*) |
| `LOUPE_OPENAI_ENDPOINT` | (required) | Endpoint of the Azure OpenAI resource, e.g. `https://openai-example.openai.azure.com` |
| `LOUPE_OPENAI_KEY` | | API key; without it Loupe signs in with its managed identity (*Cognitive Services OpenAI User*) |
| `LOUPE_VISION_MODEL` | `gpt-5.6-luna` | Deployment name of the vision model used by `accurate` |
| `LOUPE_VISION_REASONING_EFFORT` | `medium` | `minimal`, `low`, `medium` or `high` |

## Limits and concurrency

| Variable | Default | Description |
|---|---|---|
| `LOUPE_MAX_FILE_BYTES` | `134217728` (128 MiB) | Largest file an upload takes |
| `LOUPE_UPLOAD_MAX_FILES` | `1000` | Most files in one upload |
| `LOUPE_UPLOAD_MAX_BYTES` | `10737418240` (10 GiB) | Most bytes in one upload |
| `LOUPE_MAX_PAGES` | `2000` | Most selected pages of one document; a longer document fails with `too_many_pages` |
| `LOUPE_ACCURATE_MAX_PAGES` | `100` | Pages per document the vision model transcribes; later pages are read as in `fast` and marked `layout` |
| `LOUPE_MAX_JOB_DURATION` | `PT12H` | A job's documents still open after this fail with `timeout` |
| `LOUPE_ANALYSIS_CONCURRENCY` | `4` | Documents read at once per replica, each with one Document Intelligence analysis at a time |
| `LOUPE_VISION_CONCURRENCY` | `8` | Vision-model page calls in flight per replica |
| `LOUPE_MAX_ACTIVE_JOBS` | `8` | Jobs one replica leases at once |
| `LOUPE_READ_MAX_BYTES` | `65536` | Maximum size of a `read_result` window |

## Tool parameters

| Tool | Parameter | Description |
|---|---|---|
| `create_upload` | `uploadId` | Optional: a fresh URL for an existing upload |
| `submit` | `uploadId` | The upload to read |
| | `quality` | `fast` or `accurate` |
| | `files` | Optional: file names within the upload; default all |
| | `language` | Optional: document language as a BCP 47 tag (`de`, `en-GB`); a hint for OCR and the vision model |
| | `pages` | Optional: page selection for every document, e.g. `1-3,7` |
| `get_job` | `jobId`, `wait` | `wait`: seconds to wait for a change, at most 10 |
| `read_result` | `jobId`, `document`, `pageStart`, `pageCount` | `document` is the file name; `pageStart` the first page number; `pageCount` the most pages |
| `cancel_job` | `jobId` | |
