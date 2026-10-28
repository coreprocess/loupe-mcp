# Deployment on Azure

Loupe runs as one deployment that several projects share. This guide uses the Terraform module in [`terraform/`](../terraform/) and Azure Container Apps. The same image runs anywhere that provides the environment variables.

## 1. Prerequisites

- A Container Apps environment. Loupe reaches no private data sources, only its store, Azure Document Intelligence, Azure OpenAI and Entra ID, so any environment works, including one that belongs to another application.
- An **Azure Document Intelligence** resource, and an **Azure OpenAI** resource with a deployment of the vision model (default name `gpt-5.6-luna`). Both may be shared with other applications; their region or data zone decides where documents are processed.
- A **verified custom domain** for the Container App, e.g. `https://loupe.example.com`, either on the Container App's own ingress (with a managed certificate) or on a gateway in front. Requirements:
  - no response buffering (`/mcp` uses server-sent events);
  - request size and duration must admit an upload of `LOUPE_MAX_FILE_BYTES` (128 MiB by default);
  - idle timeouts of about 10 seconds are fine.
- A Key Vault for the signing key.
- Permission to create Entra app registrations, and an Entra group for the people who may use Loupe.

## 2. Terraform

```hcl
module "loupe" {
  source = "github.com/coreprocess/loupe-mcp//terraform?ref=v0.1.0"

  name                         = "loupe-tst"
  resource_group_name          = "rg-shared-tst"
  location                     = "westeurope"
  container_app_environment_id = azurerm_container_app_environment.main.id
  key_vault_id                 = azurerm_key_vault.main.id
  public_url                   = "https://loupe.example.com"

  document_intelligence = { id = azurerm_cognitive_account.documents.id, endpoint = azurerm_cognitive_account.documents.endpoint }
  openai                = { id = azurerm_cognitive_account.openai.id, endpoint = azurerm_cognitive_account.openai.endpoint }
  vision_model          = "gpt-5.6-luna"

  users = [azuread_group.loupe_users.object_id]
}
```

The module creates:

- **A user-assigned identity for Loupe**, with *Cognitive Services User* on the Document Intelligence resource and *Cognitive Services OpenAI User* on the Azure OpenAI resource. No API keys are needed.
- **A private storage account** for the store, with a container that the identity gets *Storage Blob Data Contributor* on (that container only), and a lifecycle rule one day after the retention as the backstop behind Loupe's own deletion.
- **The Entra app registration** described in step 3.
- **The signing key** in Key Vault, readable by the identity (that secret only).
- **The Container App**, with at least one replica, so open jobs keep running. More replicas share the jobs through the queue.

Point the custom domain at the `fqdn` output. Further settings (`LOUPE_ACCURATE_MAX_PAGES`, concurrency, limits) go into `settings`.

## 3. Entra ID

Choose the mode by the host name:

- **`LOUPE_AUTH=entra`** if the Loupe host is on a domain verified in your tenant. Entra issues the tokens. The Terraform module uses this mode.
- **`LOUPE_AUTH=entra-broker`** otherwise. No Claude client can change the `resource` parameter that Entra matches against the Application ID URI, so Loupe runs the OAuth flow itself and signs users in at Entra.

### Direct mode (`entra`)

The module applies this configuration. If you configure Entra by hand, the order and exactness matter:

1. **Set the access token version to 2 first.** Apps on v1 tokens cannot use custom HTTPS identifier URIs.
2. **Set the Application ID URI to exactly the MCP URL:** `https://loupe.example.com/mcp`, with no trailing slash, on a verified domain.
3. **Expose the scope `Loupe.Access`.** Clients request `https://loupe.example.com/mcp/Loupe.Access`.
4. **Add the app role** `Loupe.User`, the only one. Set *assignment required* on the enterprise application and assign groups.
5. **Add redirect URIs:**
   - `https://claude.ai/api/mcp/auth_callback` (web, for the claude.ai connector)
   - `http://localhost` and `http://127.0.0.1` (mobile and desktop, for Claude Code)
6. **Grant admin consent** for the scope.

### Broker mode (`entra-broker`)

1. **Add a web redirect URI** `https://loupe.example.com/oauth/callback`. No Application ID URI and no exposed scope are needed.
2. **Add the app role** `Loupe.User`, set *assignment required* and assign groups.
3. **Add a credential**, preferably a federated identity credential for Loupe's managed identity (issuer `https://login.microsoftonline.com/<tenant>/v2.0`, subject = the identity's principal ID, audience `api://AzureADTokenExchange`), and set `LOUPE_AUTH_ASSERTION_IDENTITY` to the identity's client ID. Alternatively set `LOUPE_AUTH_CLIENT_SECRET`.
4. **Grant admin consent** for `openid profile offline_access`.

Set `LOUPE_AUTH=entra-broker`, `LOUPE_AUTH_TENANT_ID`, `LOUPE_AUTH_CLIENT_ID`, `LOUPE_PUBLIC_URL` and `LOUPE_SIGNING_KEY`.

## 4. Connect Claude

**claude.ai custom connector (recommended).** An organization admin adds a custom connector with:

- the URL `https://loupe.example.com/mcp`
- the client ID (Terraform output `client_id`)
- the client secret (output `connector_client_secret`)

Each user signs in once. The connector is then available in Claude Code on the web, in scheduled cloud tasks, and in local Claude Code when logged in with the claude.ai account.

**Claude Code without the connector:**

```bash
claude mcp add --transport http --client-id <client-id> --callback-port 8765 loupe https://loupe.example.com/mcp
```

**In broker mode** clients register themselves: `claude mcp add --transport http loupe https://loupe.example.com/mcp`.

**Uploads and downloads from cloud sessions.** Connector traffic needs no network allowlist, but `curl` from the cloud sandbox does: add the Loupe hostname to the cloud environment's allowed domains (custom network access).

## 5. Operations

- **Audit log.** JSON lines on stdout (`stream: "audit"`): every tool call, upload (name, bytes, SHA-256, detected type, client IP), document read, URL issuance and download. Document content and transcripts are never logged.
- **Retention.** Uploads, jobs and results expire after `LOUPE_RETENTION` (default 2 days); Loupe deletes them every 10 minutes, and the lifecycle rule one day later is the backstop.
- **Access logs.** Upload and download URLs carry a bearer token in the path (`/u/<token>/…`, `/r/<token>/…`). Do not let an ingress, gateway or proxy log those paths; Loupe audits every upload and download itself.
- **Health.** `GET /healthz`.
- **Throughput.** `LOUPE_ANALYSIS_CONCURRENCY` and `LOUPE_VISION_CONCURRENCY` are per replica; keep their sum over all replicas within the rate limits of the Document Intelligence resource and the vision model deployment. Throttling is retried for up to 10 minutes per call.
