# 0005. Role labels on mirrored GitHub issues

- Issue: [#75](https://github.com/viktorermolov/workspace-mcp/issues/75)
- Date: 2026-11-26
- Status: Accepted

## Context

The GitHub issues section showed "no role" for mirrored issues such as #55, #58, #69 and #70. The only way to set the local role label was the selector in the owner's web interface. MCP had no tool for it. The owner asked (26 November 2026, 11:15 PT, via Арина) why no one was assigned.

After 0.2.0 (#47 / #61), every agent write must name `claimed_role`. In enforce mode the role must exist, not be archived, and be on the connection's confirmed allow-list; in warning mode (the default after an upgrade) the write still succeeds with a warning. `edit_any` lets a role edit items that belong to others. The role on a mirrored issue is a label, not an owning role: `assertCanEdit` against `github_issue.role_id` would let anyone change an unlabelled issue, and would stop a role such as Dev Guardian from assigning Builder without `edit_any`.

The product has no "DevTeam" grouping of repositories: only individually selected `github_repo` rows. Sync is a one-way, read-only mirror; `upsertIssue` did not touch `role_id`, so new issues arrived unlabelled. Zip export never includes secrets, connections or the encrypted GitHub token (`github_config`). After this change it does include the local mirror rows (`github_repo` with `default_role_id`, `github_repo_assigner`, and `github_issue` with `role_id`) so a zip import can restore labels and repository settings alongside a role reporting-line `parent_id`; the owner reconnects the token after import. A SQLite backup still copies the whole database, including the token.

## Options

1. **Where to store the default and the right to assign.** (A) On each mirrored `github_repo`: optional `default_role_id` and a list of assigner roles, configured by the owner. (B) Hard-code DevTeam / Builder / Dev Guardian. (C) Glob patterns such as `org/*`. Chosen: **A**. (B) is forbidden by the issue; (C) invents a grouping the product does not have.

2. **Who may change an issue's label.** (A) A separate check (`assertCanSetIssueRole`): the owner; a role with `edit_any`; or a role on that repository's assigner list. The current label does not affect the right. (B) Reuse `assertCanEdit` against `issue.role_id`. Chosen: **A**.

3. **Where the mapping is configured.** (A) Owner UI and owner API only (the GitHub screen). (B) MCP tools for the settings. Chosen: **A**. The default can be set when a repository is added, so the first sync applies it.

## Decision

Options 1A, 2A and 3A. MCP tool `set_issue_role`; owner-configured default role and assigner list per mirrored repository; migration 7 (`github-issue-roles`); this record. Ordinary pull request, entries under `[Unreleased]`, part of 0.3.0. Nothing is written to GitHub.

Existing issues are not backfilled by the migration or by setting a default later. After 0.3.0 is released, Dev Guardian will set Builder on the open DevTeam issues with the new tool.

## Why

It matches the request: agents can assign a role, the owner configures which role a new issue from a given repository gets and which roles may assign labels there, and the #47/#61 rules apply unchanged. Treating the issue role as a label, not as ownership, is what lets an assigner (for example Dev Guardian) set Builder.

## Answers and rules recorded at approval

1. **Identifying an issue.** `id`, or `repo` (`owner/name`) plus `number`. Exactly one method; passing both is `invalid`.
2. **Events when a default is applied.** No event per INSERT. If a sync of a repository applies the default to N>0 new issues, one system event for that repository (`github.issue_default_role`). If N=0, no event. Manual `issue.role_set` records the old and new role (slug and id; `null` if it was cleared or there was none). An unchanged value succeeds with no new event.
3. **Which role may be assigned.** Any active (non-archived) role in the workspace, or a clear. Not only the caller's own role, so that Dev Guardian can set Builder. Archived target roles are rejected.
4. **Several assigners.** Yes, many-to-many.
5. **Globs / a whole org.** No. Only a specific mirrored repository. The owner sets the default and the assigners on each DevTeam repository separately.
6. **Repeat call with the same role.** Success, no new event.
7. **Insufficient rights in warning mode.** Same as #47: a warning, and the write proceeds; in enforce, `forbidden`. This tool is not stricter than other writes. After an upgrade, until the owner turns on enforcement, any connected agent can change a label (with a warning, recorded in the log). Warning code: `issue_role_forbidden`.

Further rules:

- The label `github_issue.role_id` does not grant or remove rights (labelling an issue with a role that has `edit_any` does not extend the actor's or that role's access).
- Links are stored by `role.id`. Renaming a slug does not break the default or the assigner list; the tool resolves a slug at call time.
- An archived default is not applied to new INSERTs; existing labels are left as they are. An archived role in the assigner list does not grant the right. The owner API accepts only an active role as default or assigner.
- Purging a role clears `default_role_id`, deletes assigner rows, and clears `github_issue.role_id` as before. Foreign keys (`ON DELETE SET NULL` / `CASCADE`) are a backstop; purge also clears these explicitly, in the same style as `owner_role_id`.
- Zip export includes the local GitHub mirror rows (`github_repo` with `default_role_id`, `github_repo_assigner`, and `github_issue` with its role label) so they round-trip with a role `parent_id`. The encrypted token in `github_config` is never exported; reconnect GitHub after a zip import. A SQLite backup still restores the token as well.
- Migration 7 is additive only (nullable `default_role_id`, table `github_repo_assigner`). A populated 0.2.0 database keeps existing `github_issue.role_id` values; there is no backfill.
- Only the owner can change the default role and the assigner list. MCP cannot; a role with `edit_any` and an assigner cannot either. An assigner of repository A cannot change issues of repository B.
- Being an assigner does not bypass the connection allow-list: `resolveAgentActor` runs first, then `assertCanSetIssueRole`.
- The default, set when a repository is added, is applied on the first sync to every INSERT, including already-closed issues of that new mirror. Issues already in the database are not filled in if the default is set later.
