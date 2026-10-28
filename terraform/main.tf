locals {
  storage_name = substr(replace(lower("${var.name}store"), "/[^a-z0-9]/", ""), 0, 24)

  env = merge({
    LOUPE_TRANSPORT                      = "http"
    LOUPE_PUBLIC_URL                     = var.public_url
    LOUPE_AUTH                           = "entra"
    LOUPE_AUTH_TENANT_ID                 = data.azuread_client_config.current.tenant_id
    LOUPE_AUTH_CLIENT_ID                 = azuread_application.loupe.client_id
    LOUPE_STORE                          = "azureblob"
    LOUPE_STORE_ACCOUNT_URL              = azurerm_storage_account.store.primary_blob_endpoint
    LOUPE_STORE_CONTAINER                = azurerm_storage_container.store.name
    LOUPE_RETENTION                      = "P${var.retention_days}D"
    LOUPE_DOCUMENT_INTELLIGENCE_ENDPOINT = var.document_intelligence.endpoint
    LOUPE_OPENAI_ENDPOINT                = var.openai.endpoint
    LOUPE_VISION_MODEL                   = var.vision_model
    AZURE_CLIENT_ID                      = azurerm_user_assigned_identity.loupe.client_id
  }, var.settings)
}

resource "azurerm_user_assigned_identity" "loupe" {
  name                = "id-${var.name}"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
}

# Loupe's own store: uploads, job state and results.
resource "azurerm_storage_account" "store" {
  name                            = local.storage_name
  resource_group_name             = var.resource_group_name
  location                        = var.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  shared_access_key_enabled       = false
  allow_nested_items_to_be_public = false
  public_network_access_enabled   = var.store_public_network_access
  default_to_oauth_authentication = true
  tags                            = var.tags
}

resource "azurerm_storage_container" "store" {
  name                  = "store"
  storage_account_id    = azurerm_storage_account.store.id
  container_access_type = "private"
}

# The backstop behind Loupe's own deletion: one day after the retention.
resource "azurerm_storage_management_policy" "store" {
  storage_account_id = azurerm_storage_account.store.id

  rule {
    name    = "expire-store"
    enabled = true
    filters {
      blob_types   = ["blockBlob"]
      prefix_match = ["store/"]
    }
    actions {
      base_blob {
        delete_after_days_since_creation_greater_than = var.retention_days + 1
      }
    }
  }
}

resource "azurerm_role_assignment" "store" {
  scope                = azurerm_storage_container.store.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.loupe.principal_id
}

resource "azurerm_role_assignment" "document_intelligence" {
  scope                = var.document_intelligence.id
  role_definition_name = "Cognitive Services User"
  principal_id         = azurerm_user_assigned_identity.loupe.principal_id
}

resource "azurerm_role_assignment" "openai" {
  scope                = var.openai.id
  role_definition_name = "Cognitive Services OpenAI User"
  principal_id         = azurerm_user_assigned_identity.loupe.principal_id
}

# Key Vault Secrets User on the one secret, never on the whole vault.
resource "azurerm_role_assignment" "signing_key" {
  scope                = azurerm_key_vault_secret.signing_key.resource_versionless_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.loupe.principal_id
}

resource "azurerm_role_assignment" "registry" {
  count                = var.registry == null ? 0 : 1
  scope                = var.registry.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.loupe.principal_id
}

resource "random_password" "signing_key" {
  length  = 64
  special = false
}

resource "azurerm_key_vault_secret" "signing_key" {
  name         = "${var.name}-signing-key"
  key_vault_id = var.key_vault_id
  value        = random_password.signing_key.result
  content_type = "loupe signing key"
}

resource "azurerm_container_app" "loupe" {
  name                         = var.name
  resource_group_name          = var.resource_group_name
  container_app_environment_id = var.container_app_environment_id
  revision_mode                = "Single"
  tags                         = var.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.loupe.id]
  }

  dynamic "registry" {
    for_each = var.registry == null ? [] : [var.registry]
    content {
      server   = registry.value.server
      identity = azurerm_user_assigned_identity.loupe.id
    }
  }

  secret {
    name                = "signing-key"
    key_vault_secret_id = azurerm_key_vault_secret.signing_key.versionless_id
    identity            = azurerm_user_assigned_identity.loupe.id
  }

  ingress {
    external_enabled = var.ingress_external
    target_port      = 8080
    transport        = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    # Open jobs are leased by running replicas; never scale to zero.
    min_replicas = 1
    max_replicas = var.max_replicas

    container {
      name   = "loupe"
      image  = var.image
      cpu    = var.cpu
      memory = var.memory

      dynamic "env" {
        for_each = local.env
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name        = "LOUPE_SIGNING_KEY"
        secret_name = "signing-key"
      }

      liveness_probe {
        transport = "HTTP"
        path      = "/healthz"
        port      = 8080
      }

      readiness_probe {
        transport = "HTTP"
        path      = "/healthz"
        port      = 8080
      }
    }
  }

  depends_on = [azurerm_role_assignment.signing_key, azurerm_role_assignment.store]
}
