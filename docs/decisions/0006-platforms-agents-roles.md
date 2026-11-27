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
