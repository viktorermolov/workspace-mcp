# 0010. A task of a role with several agents names its agent

- Issue: [#181](https://github.com/viktorermolov/workspace-mcp/issues/181)
- Date: 2026-11-27
- Status: Accepted
- Target: 0.7.0

## Context

A role can be taken by several agents, on one platform or on several. Until 0.6.x, `save_task` accepted `for_agent` as optional, and a task without it, or with `null`, was addressed to nobody: any agent of the role could take it. The owner requires every task handover to name both the role and the agent, and the platform to enforce it. Nothing did for a role with more than one agent.

Older connectors hold the tool list from before agents existed and may not send `for_agent` at all. The change must not depend on anyone reconnecting a connector.

## Options

1. **Keep `for_agent` optional.** Rejected: a handover to a role with several agents can still name nobody.
2. **Require `for_agent` on every create.** Rejected: it breaks every older connector, including for roles that have only one agent, where the answer is obvious.
3. **Require it only when the role has two or more agents.** A role with one agent gets that agent; a role with none stays unaddressed; "any agent of the role" is named on purpose with `for_agent: "*"`. Chosen.

## Decision

The check lives in `saveTask`, so MCP and the owner API (and with it the task form) follow the same rule. The tool schema keeps `for_agent` optional; there is no schema migration and no data migration.

**Candidates** of a role are the agents for which `agentMayTake` holds (the role is on the agent's list, not archived, and confirmed for its platform) and whose platform is not revoked. An agent without a platform cannot take a role and is not counted. Slugs in messages are sorted.

The rule applies when a task is **created**, and when an update **changes its role or its address** (`for_agent`), including routing by a coordinator role (#148). Other edits of an existing task (status, result, title and so on) do not re-check it. An update that passes `for_agent: null` for a task that already has no agent, with the role unchanged, is not a change.

- `for_agent` names an agent: as before, the agent must exist, the task must have a role, and the agent must be able to take it.
- `for_agent: "*"`: any agent of the role; the task is stored with no agent. The task must have a role, otherwise `invalid`.
- `for_agent` left out, empty or `null`:
  - no role, or a role with no candidates: the task has no agent, as before;
  - exactly one candidate: the task is addressed to that agent;
  - two or more candidates: `invalid`, nothing is created or changed, `rev` stays the same. The message names the role and the candidates, for example `role "developer" has more than one agent (ada, hal); pass for_agent with one of these slugs, or for_agent "*" for any of them. Nothing was created.` (`Nothing was changed.` on an update). `details` carries `role` and `candidates`.

On an update, the permission checks of #180 run first (who may change an addressed or claimed task), then this rule. A coordinator still only routes, and when it routes a task of a role with several agents it passes an agent or `"*"`.

Existing tasks with no agent are not rewritten. When a role gains a second agent, its old unaddressed tasks stay as they are and can be edited; the owner or a coordinator can address them with `save_task` (`for_agent`).

## Compatibility

Before 1.0, a breaking change bumps the minor version (0008), so this ships in **0.7.0**. It is a change of behaviour on an existing field: a `save_task` that creates or re-addresses a task of a role with several agents without an agent used to succeed and is now refused. The guarantees for existing clients:

- The tool schema does not change in a breaking way: `for_agent` stays optional, so an older client's calls still validate.
- An older connector whose tools have no `for_agent` keeps working without a reconnect: for a role with one agent the task is addressed to that agent, and for a role with no agents it is left unaddressed, as before.
- For a role with several agents, an older connector gets the same error as every other caller, naming the role and the agents. A task of such a role is never left unaddressed in silence.
- Existing tasks are not changed by the upgrade.

## Why

A handover has to name the agent when more than one could take the task; a silent "anyone" on a role with several agents is what the owner ruled out. Addressing a role's only agent automatically keeps every older connector working for the common case, without asking anyone to reconnect. `"*"` keeps "any agent of the role" available, but only as a deliberate choice.

## What a reviewer should check

- Create without `for_agent` (also `null`, `""`) on a role with 2+ agents: refused, exact message, no row.
- Create with an agent of the role: succeeds. Unknown agent, or one that cannot take the role: refused as before.
- Role with one agent: addressed to it. Role with no agents, or no role: no agent.
- `"*"` on a role with 2+ agents: stored with no agent; `"*"` on a task with no role: refused, row and `rev` unchanged.
- Moving a task to a role with 2+ agents without `for_agent`: refused, row and `rev` unchanged; to a role with one agent: addressed to it.
- Status or result changes on an existing unaddressed task of a role with 2+ agents: allowed, still unaddressed; the task form sending `for_agent: null` unchanged is not a change.
- Coordinator routing to `null` or `""` on a role with 2+ agents: refused; to an agent or `"*"`: allowed; other changes still refused (#180).
- A role gaining a second agent: old rows unchanged; a new create without an agent refused.
- An agent on a revoked platform is not counted.
- A call without `for_agent` from a connector with no agent: one agent auto-addresses, 2+ gets the error, and nothing asks anyone to reconnect.
- The owner API is held to the same rule.
