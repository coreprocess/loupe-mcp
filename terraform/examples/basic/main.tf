# Example: one Loupe deployment, placed in an existing Container Apps environment and using an
# existing Document Intelligence resource and an Azure OpenAI resource with a vision model deployment.

provider "azurerm" {
  features {}
}

provider "azuread" {}

variable "resource_group_name" { type = string }
variable "container_app_environment_id" { type = string }
variable "key_vault_id" { type = string }
variable "document_intelligence_id" { type = string }
variable "openai_id" { type = string }
variable "user_group_object_id" { type = string }

module "loupe" {
  source = "../.."

  name                         = "loupe-tst"
  resource_group_name          = var.resource_group_name
  location                     = "westeurope"
  container_app_environment_id = var.container_app_environment_id
  key_vault_id                 = var.key_vault_id
  public_url                   = "https://loupe.example.com"

  document_intelligence = {
    id       = var.document_intelligence_id
    endpoint = "https://documents-example.cognitiveservices.azure.com"
  }
  openai = {
    id       = var.openai_id
    endpoint = "https://openai-example.openai.azure.com"
  }
  vision_model = "gpt-5.6-luna"

  users = [var.user_group_object_id]
}

output "mcp_url" { value = module.loupe.mcp_url }
output "client_id" { value = module.loupe.client_id }
output "fqdn" { value = module.loupe.fqdn }
