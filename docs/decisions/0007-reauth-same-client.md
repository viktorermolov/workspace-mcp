# 0007. Re-authorization of the same client

- Issue: [#174](https://github.com/viktorermolov/workspace-mcp/issues/174)
- Date: 2026-11-27
- Status: Accepted

## Context

A platform is a `connection` row, historically keyed by the OAuth `client_id`. Agents, the confirmed allow-list, and start cursors hang off that key. Approving a connection reused the row only when the incoming `client_id` was already the primary key. Dynamic client registration issues a new `client_id` every time the same product reconnects, so a second approval created a second, empty platform. The live Grok connector in production followed this path: the original platform (`BfLCn…`) kept the agents and the confirmed allow-list, a later empty platform (`CtvfJ…`) held the working token, and an older revoked client (`zNRY…`) was left aside.

The same class of mistake can happen on any workspace, and several products share a callback URL, so a repair and a re-auth rule that keyed only on the client name or only on the redirect URI would bind the wrong platform.

## Options

1. **Delete the empty platform and ask the owner to recreate agents on the live one.** Rejected: the live token would still point at an empty platform, and the owner would have to re-enter agents and roles. Manual recreation is not an option.
2. **Merge by name, or by redirect URI alone, automatically on every consent.** Rejected: production OAuth clients often share a callback (Grok, Muse, Manus), and the client name is attacker-controlled on unauthenticated DCR. Name must never be an identity on its own.
3. **Keep a stable platform id, bind the accepted OAuth client as `current_client_id`, archive a one-to-one duplicate in a migration, and on later re-auth automatically continue only when a strict client-type match leaves exactly one candidate; otherwise the owner chooses.** Chosen.

## Decision

### Stable platform, bound client

- `connection.client_id` stays the stable platform id. Agents, allow-list, events and cursors keep referring to it.
- `connection.current_client_id` is the OAuth client whose tokens are accepted. A unique index applies where it is not null.
- `connection.merged_into_client_id` archives a duplicate: the row is also revoked, and `current_client_id` is cleared so it cannot occupy the unique index or be revived.
- `checkAccess`, revoke, unused-client expiry and client deletion honor the bound client. After a bind, a token for the old client id is rejected. The unknown-client path of `checkAccess` must not drop grants of any row's `current_client_id`.
- `approveConnection` never clears `revoked_at` or `merged_into_client_id` on an archived row.

### Migration 14 (`repair-reauth-duplicate-connections`)

The same release repairs existing duplicates. `migrateWithBackup` already writes a pre-migration backup first. Rollback of the migration itself remains `cli restore` of that backup.

The matcher is general and one-to-one. It does not hard-code production client ids: the live workspace is a case of the rule, and pinning those ids would leave every other workspace unrepaired. Per owner, candidates are `connection` rows only (never a bare `oauthClient`).

For each owner, a **duplicate** is an active, not-merged platform with no agents and no confirmed allow-list. An **original** is an active, not-merged platform with agents or a confirmed allow-list. The two must share the same normalized redirect-URI set (trailing slash and host case ignored). Revoked platforms are ignored. An unapproved DCR registration is not a candidate. Name is never used as a fallback; a client without redirect URIs is skipped.

Repair runs only when there is exactly one original and exactly one duplicate in that group, the duplicate was created after the original, and the original was not used after the duplicate was approved (`last_activity_at` is null or ≤ the duplicate's `approved_at`). Otherwise the group is skipped and the reason, the match flag, and the candidate ids are logged. Two empty platforms next to one original are skipped (`ambiguous`). The original still being used is skipped (`original_still_active`).

On a match:

- The original's `current_client_id` becomes the duplicate's client id, so the token already in use keeps working.
- `approved_at` is not changed. Bumping it would invalidate the live token.
- The duplicate is archived (`revoked_at`, `merged_into_client_id`, `current_client_id` cleared). It is not deleted: the event log is append-only, and history stays readable through the alias.
- Agents and the confirmed allow-list stay on the original and are not copied from the empty duplicate (the new client receives the original's agents and confirmed roles).
- Grants of the original's previous OAuth client are dropped; the duplicate's tokens are kept.
- Start cursors: a key is copied from the duplicate only when the original lacks it; `last_event_id` is never raised.
- The transfer is journaled (`kind = 'migration'`).

The repair runs as a frozen `run(db)` in the same transaction as the SQL, after the columns exist. It does not call evolving domain helpers (`dropGrants`, `recordEvent`). The runner writes log lines only after COMMIT, and never logs tokens.

### Re-authorization on the consent screen

Consent already requires the owner's passkey session.

Automatic continuation, with no extra click, happens only when every condition holds:

(a) Consent is given in the owner's session with a passkey.
(b) The incoming client is the same client type as the platform's currently bound client: the same registration method (DCR or CIMD), the same set of redirect URIs, the same `token_endpoint_auth_method`, and the same client name. For CIMD the `client_id` URL must also be equal. Name is never sufficient on its own.
(c) The workspace has exactly one active, non-revoked, non-merged platform that matches. Which platforms count as matches is recorded in [0009](0009-reauth-configured-candidates.md): only configured platforms (agents or owner-confirmed roles).
(d) The consent screen always shows «Continues platform X: N agents, roles…». When an empty same-type duplicate will be archived, the banner says so before Approve (0009). Approve continues that platform; the owner is not asked to pick.
(e) The previous client's tokens are revoked in the same transaction that binds the new client and bumps `approved_at`, before the authorization code is exchanged.
(f) The transfer is journaled. It grants no new permissions (agents and the allow-list stay as they were). Rollback is owner-only.

In every other case the consent screen offers an explicit choice: «Continue platform X: N agents, roles…» for each active non-revoked platform, and «New platform». The default is a new platform. A revoked platform is not a candidate. Missing or unknown `continue_client_id` is refused; the client must send the choice.

CIMD clients that reconnect with the same URL already hit the existing row; the auto path mainly covers a new DCR `client_id` of an otherwise identical client.

### Owner rollback

A `connection_transfer` row records `from_client_id`, `to_client_id`, `previous_approved_at`, kind (`reauth` or `migration`), and an optional archived client. The same owner action undoes a re-auth bind or a merge performed by migration 14: it restores `current_client_id`, sets `approved_at` to now on the restored platform and on an un-archived duplicate so tokens issued before the undo are refused, and drops access and refresh tokens of both clients. When the transfer recorded an archived client (a migration merge, or a re-auth that archived an empty duplicate per 0009), it also un-archives that duplicate and drops its grants. Deleted refresh tokens cannot be recreated; each client gets new tokens only through a fresh consent.

An exception applies when `from_client_id` equals `to_client_id` (the platform's accepted client did not change), as recorded by migration 15 (`kind` `migration` with `archived_client_id`). Undo then only un-archives the duplicate and keeps that client's consent and grants revoked; it does not issue tokens, does not delete the original's refresh tokens, and does not change the original's `approved_at` or `current_client_id`. Tokens issued for the original stay valid. A real client switch (`from_client_id` ≠ `to_client_id`) still follows the behaviour above.

The owner rolls back from the Platforms screen («Undo last client transfer»), which calls `POST /api/owner/connections/:id/rollback-transfer`. That is the existing owner-only web surface (passkey session, CSRF). A CLI command was not added: `cli` is an offline tool and requires the service to be stopped, which is the wrong place to undo a live connector's client binding. Rolling the migration 14 schema itself back (the new columns) remains a restore of the pre-migration backup.

## Why

The platform the owner named and equipped with agents is the stable object; the OAuth client id is a credential that can rotate. A unique bound client lets `checkAccess` follow the live token without rewriting history. Strict one-to-one repair, a handover check, and "never name alone" keep the migration from merging two real platforms or from touching a platform that is still in use. Automatic re-auth is limited to the case where the incoming client is observationally the same product and only one such platform exists; anything weaker would need a click anyway, so the consent screen asks.

## How this was reached

The Builder plan (issue comment on #174) recommended `current_client_id`, archive rather than delete, no `approved_at` bump in the migration, URI-first matching, a frozen `run(db)`, and this decision file. Dev Guardian approved that plan with mandatory changes (one-to-one, handover check, unique `current_client_id`, honor the bound client, logs after commit, cursor copy rules, no name-only match). The owner then required the production duplicate (`CtvfJ…`) to be merged into the original (`BfLCn…`) by that general rule, with the new client receiving the original's agents and roles, and defined automatic continuation as the default only when (a)–(f) all hold, otherwise an explicit choice, with owner-only rollback of a journaled transfer.
