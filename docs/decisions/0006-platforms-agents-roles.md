# 0006. Platforms, agents and roles

- Issue: [#106](https://github.com/viktorermolov/workspace-mcp/issues/106)
- Date: 2026-11-26
- Status: Accepted

## Context

The service knew a connection and a role. The owner runs agents on several platforms and uses the web interface as the one place to see and steer them: each agent's instruction, tasks and routines, who works with whom, and comments on any of these. In that picture three things are distinct. One platform (Grok) hosts several named agents. A role such as "developer" is a function with an instruction that agents on different platforms can take, and a single agent on another platform can take "developer" for one task and "marketer" for the next. Without an agent record, the agent's name was written into the role name, a task could not be addressed to one of two agents with the same role, and the map could not show where an agent runs.

## Options

1. **Keep two records and a naming habit** ("Name — role"). No change, but it breaks as soon as one role is taken by two agents or one agent takes two roles.
2. **One current platform per role.** Simple, but it contradicts a role being a function several platforms can take.
3. **A third record, the agent:** a name, the platform it runs on, and the roles it may take.

## Decision

Option 3, approved by Viktor on 26 November 2026.

- **Platform** is the existing connection. Only the wording in the interface changes.
- **Agent**: `id`, `slug` (unique per workspace), `name`, the connection it runs on, and a list of roles it may take. Only the owner creates, changes or removes agents; MCP can read them and cannot change them.
- **Role** stays a function: instruction, setup notes, routines, tasks, reporting line.
- The server can verify only the platform. The agent name and role in a call are checked against the owner's lists; this guards against mistakes, not against a hostile agent (unchanged from [0002](0002-role-checks-on-writes.md)). No per-agent keys.

Delivery, each step leaving a working release:

1. **Agents as a record** (#107): migration, owner screens, export and import, `start` lists agents. Existing connection role lists become one agent per connection and role, so nothing has to be re-entered. Checks on writes are unchanged.
2. **Agents name themselves**: an `agent` argument on `start` and on writes, checked against the platform and the agent's roles; the log, versions and checkpoints record the agent. Calls without it keep working with a warning. `start` is trimmed in the same step (no archived roles, no log of unrelated events).
3. **Addressing**: a task may name one agent besides its role; `start` shows the agent its own checkpoint first; owner comments also cover tasks and routines.
4. **Interface**: the map shows platforms, their agents and their roles; an agent page and a role page; the change feed is grouped by item; the menu has three groups.

## Why

The agent is the thing the owner names, watches and talks to, and the role is what is portable between platforms; keeping them in one record forced one of the two to be wrong. A single list (agents and their roles) replaces the flat role list per connection instead of adding a second mechanism. Starting with a record that changes no check lets the data move first and the rules follow.

## How this was reached

This section is for a reviewer who was not in the discussion. It records the path, including the proposals that were dropped, so the implementation can be checked against the reasoning. The discussion was between Viktor and Claude on 26 November 2026, after Viktor asked for a review of the project's design, code and decisions and said he was not satisfied with the design.

### What the review found

The code was judged sound: one transaction per change with its log entry and version, immutable history, conflict checks, OAuth and passkeys from a maintained library, outbound requests protected against internal addresses. The weak points were elsewhere:

- **Interface.** The Map showed every role twice (the tree, then the same roles as cards in a different order). The change feed was the raw log, so one new task produced two cards. Reading and editing the same item lived in separate sections. The menu had 16 flat entries.
- **`start`.** The response limit is 512 KiB, far more than an agent's context can hold, and a call without a role was mostly archived test roles and unrelated log events.
- **`rev` and `version`.** Two similar numbers that agents mix up.
- **Documentation drift.** README and architecture said 16 tools; there are 18.

### Proposals that were withdrawn, and why

Claude first read the product as a store for agents with a secondary web interface, and proposed three things that Viktor corrected:

1. *"The main user is the agent; the web interface is for rare checks."* Wrong. Viktor uses the web interface as the one place to see every agent's instruction, tasks and routines across platforms, because the platforms themselves make this hard to view. The interface is a primary part of the product.
2. *"Owner comments with re-anchoring were not worth building."* Wrong for the same reason: comments are how Viktor steers agents. He wants them on instructions, tasks and routines. Today they cover versioned text only; tasks have a separate, simpler comment and routines have none (step 3 below closes this).
3. *"Go back to a role being only a label and drop the checks."* Withdrawn once the real setup was clear: one platform (Grok) runs several agents, so a list of who may act as what on a platform has a real use.

Then two models of the role were tried and rejected before the final one:

4. *"A role is an agent on a platform, so a role has one current platform."* Rejected by Viktor's next example: "developer" can be taken by an agent on Grok and by an agent on Claude, a coordinator may give a task to either, and a single agent on another platform may take "developer" for one task and "marketer" for the next. A role is therefore a function with an instruction, and the many-to-many link between platforms and roles was right.
5. *"Keep two records and write the agent's name into the role name."* This is what the live workspace did ("<agent> — coordinator"). Viktor's statement that settled it: the agent is one thing on one platform, and coordinator is its role. Two records cannot express that without one of them being wrong, so the agent became a third record.

### Choices inside the decision

- **No per-agent keys.** Already considered and dropped in [0002](0002-role-checks-on-writes.md). The server can verify only the platform; the agent's name and role are checked against the owner's lists. This protects against mix-ups, which is the actual problem, and stays simple.
- **Agents are kept by the owner only.** They say who may act as what, so they sit with connections and enforcement, outside MCP.
- **Step 1 changes no check.** The data moves first (migration 8 creates agents from what each connection is listed for or has already written as), so an upgrade cannot lock out a working bot. The checks follow in step 2, and calls that do not name an agent keep working with a warning.
- **Nothing to re-enter.** Viktor asked for the change to be carried out without manual work, so the migration fills agents in, named after their role; renaming them is optional.
- **Agents are not in a zip export.** They point at a connection, and connections are never exported.
- **The interface work comes last** (step 4), because what the map and the pages show depends on agents existing.

### How the work is carried out

Viktor asked Claude to implement all four steps from start to finish and said that for this work the pull requests are merged by Claude on green CI, without waiting for Dev Guardian's PASS; he will send the Grok team to review everything afterwards. This is his exception for this piece of work, not a change to [CONTRIBUTING](../../CONTRIBUTING.md). Releases are not part of the exception: no release pull request is opened, and changes stay under `[Unreleased]` until Viktor says yes.

### What a reviewer should check

- Migration 8 on a copy of the live database: the agents it creates match what each platform really does, and `connection_role` is unchanged.
- Step 2: a call that names an agent from another platform, or a role the agent may not take, is refused once enforcement is on and only warned about before that; a call that names no agent still works.
- That no MCP tool can create, change or remove an agent.
- Existing test expectations that changed are only the counts and lists of migrations.
