variable "name" {
  description = "Base name for all resources, e.g. \"loupe-tst\"."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group for the identity, the store and the Container App."
  type        = string
}

variable "location" {
  description = "Azure region."
  type        = string
}

variable "tags" {
  description = "Tags applied to all Azure resources."
  type        = map(string)
  default     = {}
}

variable "container_app_environment_id" {
  description = "Existing Container Apps environment."
  type        = string
}

variable "image" {
  description = "Container image, pinned to a version or digest."
  type        = string
  default     = "ghcr.io/coreprocess/loupe-mcp:0.1.0"
}

variable "registry" {
  description = "Optional private registry the image is pulled from with the Loupe identity (e.g. after az acr import)."
  type = object({
    server = string # e.g. myregistry.azurecr.io
    id     = string # resource ID, for the AcrPull role assignment
  })
  default = null
}

variable "public_url" {
  description = "Public base URL on a verified domain, without trailing slash, e.g. \"https://loupe.example.com\". The MCP endpoint is <public_url>/mcp."
  type        = string

  validation {
    condition     = can(regex("^https://[^/]+$", var.public_url))
    error_message = "public_url must be https://<host> without path or trailing slash."
  }
}

variable "ingress_external" {
  description = "Expose the app on the environment's ingress (still internal if the environment uses an internal load balancer)."
  type        = bool
  default     = true
}

variable "cpu" {
  description = "CPU cores per replica; page rendering and image decoding are CPU-bound."
  type        = number
  default     = 2
}

variable "memory" {
  description = "Memory per replica; two pdf.js reader processes take up to 1 GiB each."
  type        = string
  default     = "4Gi"
}

variable "max_replicas" {
  type    = number
  default = 3
}

variable "document_intelligence" {
  description = "The Azure Document Intelligence resource: its ID (for the role assignment) and endpoint."
  type = object({
    id       = string
    endpoint = string
  })
}

variable "openai" {
  description = "The Azure OpenAI resource with the vision model deployment: its ID (for the role assignment) and endpoint."
  type = object({
    id       = string
    endpoint = string
  })
}

variable "vision_model" {
  description = "Deployment name of the vision model in the Azure OpenAI resource."
  type        = string
  default     = "gpt-5.6-luna"
}

variable "settings" {
  description = "Additional LOUPE_* settings, e.g. { LOUPE_ACCURATE_MAX_PAGES = \"50\" }."
  type        = map(string)
  default     = {}
}

variable "key_vault_id" {
  description = "Key Vault for the signing key. The Loupe identity gets Key Vault Secrets User on that secret, not on the vault."
  type        = string
}

variable "retention_days" {
  description = "Days uploads, jobs and results are kept (LOUPE_RETENTION); the lifecycle rule deletes one day later."
  type        = number
  default     = 2
}

variable "store_public_network_access" {
  description = "Allow public network access to the store account. Keep false and use a private endpoint where possible."
  type        = bool
  default     = false
}

variable "users" {
  description = "Object IDs of users or groups that get the app role Loupe.User."
  type        = list(string)
  default     = []
}

variable "create_connector_secret" {
  description = "Create a client secret for the claude.ai custom connector (confidential client)."
  type        = bool
  default     = true
}

variable "preauthorize_azure_cli" {
  description = "Pre-authorize the Azure CLI on the scope, so local clients can use `az account get-access-token`."
  type        = bool
  default     = false
}
