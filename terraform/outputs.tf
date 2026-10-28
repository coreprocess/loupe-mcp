output "mcp_url" {
  description = "MCP endpoint (also the Application ID URI)."
  value       = local.mcp_url
}

output "scope" {
  description = "Fully qualified scope clients request."
  value       = "${local.mcp_url}/Loupe.Access"
}

output "client_id" {
  description = "Client ID of the app registration (token audience; client ID for claude.ai and Claude Code)."
  value       = azuread_application.loupe.client_id
}

output "connector_client_secret" {
  description = "Client secret for the claude.ai custom connector."
  value       = var.create_connector_secret ? azuread_application_password.connector[0].value : null
  sensitive   = true
}

output "fqdn" {
  description = "FQDN of the Container App's ingress; point the custom domain or gateway at it."
  value       = azurerm_container_app.loupe.ingress[0].fqdn
}

output "identity_principal_id" {
  description = "Principal ID of the Loupe identity, for additional role assignments."
  value       = azurerm_user_assigned_identity.loupe.principal_id
}

output "identity_client_id" {
  value = azurerm_user_assigned_identity.loupe.client_id
}

output "store_account_id" {
  value = azurerm_storage_account.store.id
}
