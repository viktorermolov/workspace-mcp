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
- **Step 1 changes no check.** The data moves first (migration 8 creates agents from the roles the owner confirmed for each connection), so an upgrade cannot lock out a working bot. The checks follow in step 2, and calls that do not name an agent keep working with a warning.
- **Nothing to re-enter.** Viktor asked for the change to be carried out without manual work, so the migration fills agents in, named after their role; renaming them is optional. After review (#138) it uses only owner-confirmed roles: a role a connection merely claimed in a call must not become a grant, so a connection with no confirmed list gets no agent and the owner adds it by hand.
- **Agents in a zip export (changed after review, #146).** First they were left out, because they point at a connection and connections are never exported; a task then lost its addressee. Now an agent is exported with its roles and without its platform, and after an import the owner attaches it to a platform again. An agent with no platform can do nothing.
- **The interface work comes last** (step 4), because what the map and the pages show depends on agents existing.

### How the work is carried out

Viktor asked Claude to implement all four steps from start to finish and said that for this work the pull requests are merged by Claude on green CI, without waiting for Dev Guardian's PASS; he will send the Grok team to review everything afterwards. This is his exception for this piece of work, not a change to [CONTRIBUTING](../../CONTRIBUTING.md). Releases are not part of the exception: no release pull request is opened, and changes stay under `[Unreleased]` until Viktor says yes.

### What a reviewer should check

- Migration 8 on a copy of the live database: the agents it creates match what each platform really does, and `connection_role` is unchanged.
- Step 2: a call that names an agent from another platform, or a role the agent may not take, is refused once enforcement is on and only warned about before that; a call that names no agent still works.
- That no MCP tool can create, change or remove an agent.
- Existing test expectations that changed are only the counts and lists of migrations.

## What was delivered

All four steps are on `master` under `[Unreleased]`. Nothing has been released; the release is Viktor's decision.

| Step | What | Issue | Pull request |
| --- | --- | --- | --- |
| 0 | This record and the change to the brief | #106, #111 | #108, #112 |
| 1 | Agents as a record: migration 8, owner screens, `start` lists agents | #107 | #109 |
| 2 | Agents name themselves: `agent` on `start` and on writes, checks, the agent in the log, versions, comments and checkpoints (migration 9) | #110 | #113 |
| 2 | Smaller responses: compact JSON, archived roles by slug, no empty event fields | #114 | #115 |
| 3 | A task can be addressed to one agent; own checkpoint first (migration 10) | #116 | #117 |
| 3 | Owner comments reach the agent: waiting task comments in `start`, comments on routines | #118 | #119 |
| 4 | Change feed grouped by item; sidebar in three groups | #120 | #121 |
| 4 | Map: platforms with their agents, agents on roles | #122 | #123 |
| 4 | Rules and role instructions listed with projects and documents | #126 | #127 |
| 4 | Role page reads first, with tasks, routines and routine comments | #128 | #129 |
| 4 | Agent page | #130 | #131 |
| 4 | Project and task pages read first | #132 | #133 |
| 4 | Map lists each role once; "Works with" on the role page | #134 | #135 |

A defect reported from the live instance during this work was fixed on the way: a document opened from Projects showed its Markdown source (#124, #125).

### Where the result differs from the plan

- **Owner comments on tasks did not become review comments.** A task already has a comment thread the owner can write in, so a second kind of comment on the same page would have been the duplication this work set out to remove. Instead `start` tells the role which of its tasks have an unanswered owner comment. Routines had no comments at all, so they did get review comments (whole item, no line range, nothing to re-anchor).
- **The reporting tree was kept.** It had just been redesigned (#103) and its browser tests hold. The duplication on the Map was removed from the other side: the second copy of every role (the card grid) is gone, and what only those cards showed moved to the role page.
- **`start` was trimmed less than first proposed.** Archived roles are still listed, by slug only, because an earlier decision relies on agents seeing that a slug is taken. Events are not filtered by relevance, only stripped of empty fields; filtering would change what "changes since your previous start" means and is left for a separate decision.
- **Two lists, one rule (changed after review, #140).** As first delivered, a named agent was checked only against its own roles on writes, while `start` accepted either list, so the owner's confirmation of a platform's list stopped mattering for named agents. Viktor chose: the platform's confirmed list is the ceiling, and an agent's list only narrows it. An agent can be given only roles confirmed for its platform, a role taken off the platform is taken off its agents, and `start`, writes and task addressing use the same check. A call that names no agent is checked against the platform's list, as before. The alternative, keeping only the agent list, was rejected because every bot would then have to name itself once enforcement is on, including on platforms with one agent.

### Existing tests that changed

- The list of migrations and the count of pending migrations in four tests, three times (migrations 8, 9 and 10).
- `test/mcp.test.ts`: `start` lists archived roles in `archived_role_slugs` instead of `archived_roles`.
- `e2e/workspace.spec.ts`: two flows that opened a role or a task and used the form at once now press **Edit** first, and two assertions that looked at the removed Map cards now check the same facts on the tree card and on the role page.

No test was removed or skipped.

### Not done

- The interface still says "connection" and "role" in most places; only the Map and the new pages speak of platforms and agents.
- `rev` is still a number that agents can mix up with `version`.
- The agent's own instruction stays with the role; an agent has no text of its own.
