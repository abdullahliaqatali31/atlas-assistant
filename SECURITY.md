# Security

Please report vulnerabilities privately through a GitHub security advisory on this repository ("Report a vulnerability" under Security), not in a public issue. We aim to reply within a week.

## What Atlas protects

- **Actions.** Every tool call passes the policy gate (`packages/policy`) outside the model. Sending, paying, deleting and changing things outside Atlas ask the owner unless the owner made a rule. Content from webpages, email, messages, files and MCP servers is treated as data and can never raise a permission.
- **Keys.** API keys live in Windows Credential Manager. They are never written to `setup.json`, the database, logs, backups or the page; the runtime scrubs them from errors.
- **The web interface.** The gateway listens on `127.0.0.1` unless the owner allows other devices. Every browser is paired by a one-time code or ticket and then holds an HttpOnly cookie; host and origin headers are checked; owner-only calls are refused for other devices.
- **Voice ID** is a convenience, never a lock: voices can be cloned, so it never approves an action by itself. Voice prints are encrypted at rest.
- **Downloads.** Local models are fetched over HTTPS only when the owner turns the feature on; the Voice ID model is checked against a pinned SHA-256, the others come from Hugging Face by fixed model name. `SKILL.md` skills are checked before install and their scripts are never run.

## Areas of particular interest

Policy gate bypasses, prompt injection that leads to an action, credential exposure, pairing or origin bypass on the web interface, and MCP server isolation.

Never include real API keys or personal data in issues, logs or test fixtures.
