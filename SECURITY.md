# Security policy

## Supported versions

Workspace MCP has no release yet. Until 1.0, security fixes go into the latest release and `master` only.

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue:

1. Open the repository's **Security** tab and choose **Report a vulnerability** (GitHub private vulnerability reporting).
2. Describe the issue, the affected version or commit, and how to reproduce it. A proof of concept against your own instance is welcome; please do not test against instances you do not own.

If private reporting is not available, open an issue that asks for a private contact and contains no details of the vulnerability.

You should get a first answer within a week. Once a fix is released, the advisory is published with credit to the reporter, unless you prefer otherwise.

## Scope

In scope: the service in this repository (MCP endpoint, OAuth server, owner web interface and API, webhooks, GitHub mirror, backups, export and import) and the container image built from it.

Out of scope: vulnerabilities that need control of the host or container, misconfiguration contrary to the documentation (for example `TRUST_PROXY=true` with the port reachable directly), and the behaviour of AI platforms or models that read workspace content.

The security model and threat model are described in [docs/security.md](docs/security.md).
