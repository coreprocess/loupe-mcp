# Loupe MCP

Loupe is an MCP server that reads documents for AI agents. It turns PDFs, scans, photos and
Office files into text, at one of two quality levels:

- **`fast`:** Azure Document Intelligence layout, Markdown per page.
- **`accurate`:** Document Intelligence, the PDF text layer, form fields and the page image,
  reconciled per page by a vision model into HTML, with photos and drawings described.

Agents upload files from their sandbox with `curl` to a signed URL, submit them as a batch job,
and read the text per page in context or download it.

Status: concept. See [docs/CONCEPT.md](docs/CONCEPT.md).

## License

[MIT](LICENSE)
