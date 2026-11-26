# 0002. Role checks on writes

- Issue: [#47](https://github.com/viktorermolov/workspace-mcp/issues/47)
- Date: 2026-11-26
- Status: Accepted

## Context

Every agent write records a role name supplied by the caller (`claimed_role`, or `role` on `claim_task` and `checkpoint`). The server did not check that name against the connection. Several bots can share one OAuth connection, especially on a platform that offers a single client. The owner asked for two things: each bot should use its own name when it edits, and a connection should be allowed to have more than one bot or role.

This record is for issue #47. The agent-binding half of [#48](https://github.com/viktorermolov/workspace-mcp/issues/48) is covered by the same allow-list (the binding lives on the connection, not as a column on the role). An optional owning role on a project (`owner_role_id`) is included so the “whose item” rule is complete for projects.

## Options

1. **One role per connection.** Bind exactly one role to each approved OAuth connection. Simple, but it would require a separate connection for every bot on a platform that only offers one client. Not chosen: the owner wanted each connection to be able to have several bots and roles.

2. **A secret key or token per role.** Each role would have a key that a bot presents to prove it may use that name. Dropped at the owner's request on 26 November 2026: too much complexity for this stage.

3. **A confirmed allow-list of roles per connection, and `claimed_role` on every write.** The owner lists, on the Connections page, which roles a connection may sign as. The server checks that the named role exists, is not archived, and is on that confirmed list. A role may edit items that belong to it; the owner can mark some roles as allowed to edit any item. New log entries record the connection, the acting role, and whose item was changed. After an upgrade, checks start in warning mode so existing clients keep working; the owner confirms each list and then turns on enforcement. A list suggested from that connection's own history is a draft and has no effect until it is confirmed. Using the old `role` argument as the author, when `claimed_role` is omitted, is accepted only as a deprecated synonym during the transition and will be removed later.

## Decision

Option 3.

## Why

It matches the owner's instruction: no extra keys, each bot uses its own name, and one connection may have several roles. The switch from warning mode to enforcement is a small, non-breaking transition until the owner is ready. The protection is against mistakes and confusion (a bot omitting its name, or using the wrong one), not against a hostile agent; that limitation is stated in [security.md](../security.md).
