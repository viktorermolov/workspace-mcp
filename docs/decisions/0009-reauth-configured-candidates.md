# 0009. Re-authorization matches only configured platforms

## Context

[0007](0007-reauth-same-client.md) continues a platform automatically when conditions (a)–(f) all hold, including (c): the workspace has exactly one active, non-revoked, non-merged platform that matches the incoming client by `sameClientType`. Migration 14 leaves an empty duplicate in place when the original was used after that duplicate was approved (`original_still_active`). Both platforms then match, so re-auth offers a choice whose default is a new platform, and a third platform can be created.

The question is which platforms count as matches for (c), and what happens to an empty same-type duplicate when the original is continued.

## Options

1. **Every active same-type platform counts.** Auto-continue only when there is exactly one such row. An empty duplicate next to a still-used original always becomes a choice. This is what 0.6.0 did, and it is how a third platform appears.

2. **Only configured platforms count** (platforms with agents or owner-confirmed roles). An empty same-type duplicate is not a match, so it does not turn auto-continue into a choice. When the one matching original is continued, a qualifying empty duplicate is archived in the same transaction. A duplicate that is configured in any way is never touched automatically. Chosen.

## Decision

Approved by Арина on 27 November 2026 at 10:44 AM PT (America/Los_Angeles), recorded on issue #178.

Only **configured** platforms count as matching candidates for automatic continuation. A platform is configured when it has at least one agent or an owner-confirmed role allow-list. Conditions (a), (b), (d), (e) and (f) in 0007 are unchanged. Name is never sufficient on its own.

An empty same-type duplicate is archived in the same transaction as the continuation only when every condition holds:

- 0 agents
- 0 roles
- no journal entries under it other than its own `connection.approved` (attribution includes `connection_id`, `entity_id`, and `event.agent` when that slug belongs to an agent on the platform)
- the same owner
- the client matches by `sameClientType`

The archive is journaled on the `connection_transfer` row (`archived_client_id`, kind `reauth`). The owner can roll it back from Platforms («Undo last client transfer»): the duplicate is un-archived, `approved_at` is set to now on both rows, and grants of the incoming client, the previously bound client, and the un-archived client are dropped.

A duplicate that is configured in any way (agents, roles, or any journal entry besides its own approval) is never touched automatically. The owner keeps an explicit choice, and «New platform» stays the default when there is not exactly one configured match.

The consent screen's banner, shown before Approve, says that the empty duplicate will be archived.

This decision does not itself merge an empty duplicate that already exists while the original is still in use. That repair is migration 15 (`repair-empty-active-duplicates`).

### Migration 15

Migration 14 leaves an empty same-type duplicate in place when the original was used after that duplicate was approved (`original_still_active`). Migration 15 archives that leftover when every condition holds:

- the same owner
- the client matches by `sameClientType`
- exactly one pair (one configured original and one empty duplicate)
- the duplicate has 0 agents, 0 roles, and no journal besides its own `connection.approved`
- the duplicate was created later than the original, and the original was used after the duplicate was approved

The original platform and its tokens are not changed: `current_client_id` and `approved_at` stay as they are. The duplicate's unused consent and grants are revoked so the archived client cannot obtain a token. An empty consent row is not configuration and does not block the archive. The archive is journaled on a `connection_transfer` row (`archived_client_id`, kind `migration`). The owner can roll it back from Platforms («Undo last client transfer»). A second run repairs nothing more.

A lone platform — including one that has an agent, and one that is empty — is not a duplicate and is left as it is. A platform that is configured in any way, or whose journal has anything besides approve, is never archived automatically. No `connection_client` binding table is added: only the original's accepted client stays in use.

## Why

Counting every active same-type row as a match made a leftover empty duplicate, which migration 14 correctly left in place, look like a second real platform. The owner was then offered a new platform as the default, and approving it created a third row. Only configured platforms are the ones the owner has equipped; an empty leftover should not block continuing the original, and when it is truly empty it can be archived in the same step, with a journal and an undo. Anything that already has agents, roles, or other journal entries might be a real platform, so it is left alone and the owner chooses.
