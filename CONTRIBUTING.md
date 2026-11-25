# Contributing

Thanks for your interest. Bug reports, documentation fixes and pull requests are welcome. For a larger change, please open an issue first, so we can agree on the approach before you spend time on it.

## Scope

Workspace MCP stores, shows and notifies. It deliberately does not run agents, call LLMs, store files or secrets, support multiple users with permissions, or offer a public REST API. Proposals in those directions are likely to be declined; see "What it does not do" in the [README](README.md).

## Development setup

You need Node.js 26 or newer. Docker is only needed to build and test the image.

```sh
npm ci
npm run build:ui
cp .env.example .env    # for local runs, set PUBLIC_URL=http://localhost:8080 and a SECRET_KEY
set -a; . ./.env; set +a
npm start               # http://localhost:8080, the setup code is printed to the log
```

Passkeys work on `http://localhost`. For interface work, run `npm run dev:ui` next to the service: Vite serves the interface with hot reload and forwards the API to port 8080.

## Checks

Run these before you open a pull request. CI runs them too, with the end-to-end tests and the image build on amd64 and arm64.

```sh
npm run typecheck
npm test
npm run build:ui
scripts/check-tree.sh                 # no secrets, databases or .env in tracked files
npx playwright install chromium && npm run test:e2e   # interface flows with a virtual passkey
docker build -t workspace-mcp:local . && scripts/container-smoke.sh workspace-mcp:local
```

## Guidelines

- **Tests check real behaviour.** Add or update tests with every change. Never weaken or skip an existing test to make a change pass.
- **Migrations.** Never edit a migration in `src/db/schema.ts` that has been released; add a new one.
- **Every change is logged.** A write in `src/domain` must update data, versions, the search index and the log in one transaction.
- **Security boundaries.** Nothing that manages connections, webhooks, secrets or the owner account, and no permanent deletion, may be reachable through MCP. Read [docs/security.md](docs/security.md) before changing authentication, outbound requests or the owner API.
- **Dependencies.** Prefer the platform and the existing dependencies. Do not add hand-written cryptography or token handling.
- **Documentation.** Update the docs in the same pull request when behaviour, configuration or tools change.
- **No personal data.** This repository is public. Use example values (`workspace.example.com`, made-up names) in tests, fixtures and docs, never real data or real tokens.
- **Language.** Code, comments, commits, issues and documentation are in English.

## Pull requests

- Branch from `master` and open a pull request. Every change goes through a pull request; `master` is never pushed to directly.
- Describe what changes for a user, and how you tested it.
- A pull request is merged when CI is green and it has been reviewed.

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
