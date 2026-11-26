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
- Every pull request must include `Fixes #N` in its description. A pull request without an issue is not accepted. Open the issue first, then the pull request.
- Describe what changes for a user, and how you tested it.
- A pull request is merged when CI is green and it has been reviewed. See [Releasing](#releasing) for the extra requirement on a release pull request, and for when nothing else may merge.


## Releasing

Releases are made by merging, only from `master`, with no tag to push by hand.

A release pull request is one that changes the version in `package.json` or `package-lock.json`, or that adds a `## [X.Y.Z]` section to `CHANGELOG.md`. It is merged only after Viktor's explicit yes, relayed by Арина, plus Dev Guardian's PASS and green CI. Every other pull request is merged after Dev Guardian's PASS and green CI.

1. In a release pull request, set `version` in `package.json` (and `package-lock.json`) to `X.Y.Z` and rename the `## [Unreleased]` section of `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`, with a new empty `## [Unreleased]` above it. For the first release, also update the pre-release wording in `README.md` (status), `SECURITY.md`, `docs/deployment.md` (published images) and `docs/runbook-raspberry-pi.md`. Merge it only under the rule above. That merge does not itself publish the release: the release is cut from the first `master` push that the release workflow processes while `package.json` names that unreleased version and `CHANGELOG.md` has a section for it.
2. After the first release only: GitHub creates the container package as private. Make it public in the package settings (Package settings → Change visibility), so `docker pull` works without signing in.

While `master` holds an unreleased version (the version in `package.json` has a `## [X.Y.Z]` changelog section and no published GitHub Release yet), do not merge any other pull request into `master`, documentation included, until that Release is published. Otherwise the release is cut from a later, unrelated commit.

On every push to `master`, the release workflow checks whether the version in `package.json` is released yet; if it is, it does nothing. If not, that commit is the release: it requires a non-empty `CHANGELOG.md` section for that version (a missing one fails the run rather than skipping the release), `package-lock.json` to match and the version to be absent from the registry and from git tags elsewhere, runs the full CI on that commit, builds and tests the images, signs them, then tags them, and creates the git tag `vX.Y.Z` on that commit and the GitHub Release from the changelog section. If a release fails before its images are tagged, fix the cause and merge again, or run the workflow manually on `master` (Actions → release → Run workflow); if it fails after that, re-run its failed jobs, which finishes the same signed image. `latest` moves only when the new version is the highest. A released version is never rebuilt or republished: to fix one, release a new version.

Tags matching `v*` are protected by a [repository ruleset](https://github.com/viktorermolov/workspace-mcp/rules/28173546): they can be created, but they cannot be moved or deleted.

## Issue standard

Every issue gets exactly two labels: one type (`bug`, `enhancement`, `documentation`, `question`, or `security`) and one priority (`priority: critical`, `priority: normal`, or `priority: low`). The `priority: ` prefix is required. When an issue is waiting on a decision from Арина or Viktor, also add `needs-decision` or `blocked`. Those status labels are in addition to the two main labels, not instead of them. Do not add other labels to new issues.

Use the issue forms when they apply. A documentation issue must include a `file:line` reference (for example `README.md:12`).

### When work is taken

- `priority: critical` — immediately, and it goes into a fast release
- `priority: normal` — in the next planned release (every 1–2 weeks)
- `priority: low` — when possible

### Closing an issue

- Duplicate: close with a link to the original.
- Cannot reproduce, or won't do / not planned: close with one line stating the reason.

### Security issues

This repository is public. Do not disclose details of a security issue until a fix exists. A public issue, if any, should have only a general title and a note that the details were sent separately. Send the details privately to Арина or Viktor, outside the public issue.

By contributing, you agree that your contributions are licensed under the project's license, the [GNU Affero General Public License v3.0 only](LICENSE).

