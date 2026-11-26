# 0004. Role reporting tree

- Issue: [#55](https://github.com/viktorermolov/workspace-mcp/issues/55)
- Date: 2026-11-26
- Status: Accepted

## Context

The Map page placed roles in a circle (hidden above 16 nodes) and did not show who reports to whom. The issue asked for a reporting tree, a "reports to" field on each role, solid lines for reporting and declared links, dashed lines for recorded tasks, comments and hand-offs, and node cards with open tasks and routines. Direction was approved as options 1A–5A in [the plan](https://github.com/viktorermolov/workspace-mcp/issues/55#issuecomment-7201109189), with [11 mandatory changes](https://github.com/viktorermolov/workspace-mcp/issues/55#issuecomment-7201170749).

## Options

1. **How to store "reports to".** A. A `role.parent_id` column (one parent, a forest of roots), canonical, like `task.parent_id`. B. Only `role_link` of type `reports_to`. C. Both as equal sources. Chosen: A.

2. **Existing `reports_to` links.** A. Do not auto-convert; they stay declared, labelled links. B. Copy a single outgoing `reports_to` into `parent_id`. Chosen: A.

3. **Dashed (observed) interactions.** A. Count `task.assigned` and `task.commented`, plus `task.created` and `task.claimed` when the author is not the task's role, over 30 days with a 2000-event cap. B. Assigned and commented only. C. Also documents and other entity edits. Chosen: A, with the counting rules below.

4. **Layout.** A. A forest, top-down, mobile first, no 16-node cap; scroll rather than hide. B. Keep the circle and overlay hierarchy. Chosen: A.

5. **Permissions from the tree.** A. The tree does not change who may edit what. B. A manager may edit descendants. Chosen: A.

## Decision

Options 1A, 2A, 3A, 4A and 5A, plus the following required details:

1. **Who may set `parent`.** Setting or changing `parent` through MCP, including on role creation, needs the owner or an `edit_any` role. The same path as the rules check: an `edit_others` warning and an audit in warn mode, `forbidden` in enforce. A role cannot re-parent itself. Other role fields keep the current owner-role rule. The owner UI and `POST /api/owner/roles` are unchanged in who may call them (the owner).

2. **Export/import of parent links.** Import of `task.parent_id` is fixed separately in #70, with a generic two-pass helper (`IMPORT_PARENT_SPECS`) that this change will reuse for `role.parent_id` once that PR is on master. This PR does not base on the #70 branch. Until that helper lands, a workspace whose role parents were created after their children can still fail import the same way tasks used to.

3. **Cycle and depth.** The ancestor walk runs server-side inside the existing `BEGIN IMMEDIATE` write transaction, scoped to `member_id`. A parent change is `invalid` if it would create a cycle, or if the ancestor depth of the new parent plus the height of the moved subtree would exceed 16 levels (so hanging one 10-level chain under another is rejected). The same depth-plus-height rule will apply to import of `role.parent_id` once the #70 helper is on master. `parent` is validated (exists, active, same workspace, no cycle, depth) only when its value actually changes, so a child whose existing parent is archived can still be saved (the role page always resubmits `parent`). A new parent must be an active role in the same workspace. Setting `parent` to `null` when it is already null, or omitting it, does not run the owner/`edit_any` check.

4. **Map cost.** `mapView` uses batched or grouped queries for counts, open tasks, routines, checkpoints and last activity. Migration 5 adds `event (member_id, action, id)` for the interactions query, and `role (parent_id)`. The 30-day window and the 2000-event cap stay; the response includes `interactions_truncated: true` when the cap is hit, and the page shows that.

5. **Dashed edges.** Creating a task with a role writes both `task.created` and `task.assigned`; only one hand-off is counted. Dashed edges are drawn only when `from` is the real owner (an owner session or owner connection, recorded as `actor_kind = 'owner'`) or an existing role. An agent whose `claimed_role` string is `"owner"` (kept as-is in warn mode) is not drawn as the owner, and unknown `claimed_role` values are not drawn. `task.claimed` counts only when a role claims a task already assigned to another role. A dashed edge is omitted when a solid line already exists in the same direction.

6. **One name for the field.** There is no `reports_to` synonym for `parent` on `save_role`. The UI label remains "Reports to".

7. **Legacy `reports_to` links.** They stay visible as solid, labelled declared links. When a role has a `reports_to` link but no `parent`, or one that differs from `parent`, the role page shows a hint and an optional "Use as parent" action. Nothing converts automatically. `docs/tools.md` states that `parent` is the reporting line and that the `reports_to` link type is kept but no longer offered for new links.

8. **Audit and feed.** A parent change writes `role.updated` with `changed: ["parent"]` and data `{ parent_from, parent_to }` as slugs, and a summary such as `reports to X (was Y)`. Agent reparents appear in the owner's Review feed. The `role.updated` webhook payload is additive only.

9. **Privacy.** Dashed interactions and node cards stay owner-only (`/api/owner/map`). `start` and `get` may expose `parent` but not interactions.

10. **Phone and e2e.** Tree layout on the phone project and at 390×844: no horizontal page overflow; the tree scrolls inside its own container; tap targets at least 44px. The parent-and-child e2e (tree, not circle) runs on both Playwright projects. The `n > 16` early return is removed, not raised.

11. **Migration.** Id 5, name `role_parent`, additive only: `ADD COLUMN parent_id TEXT REFERENCES role(id)` (NULL default) plus the indexes above, in the existing per-migration transaction. A populated 0.2.0 database migrates with `parent_id` NULL and existing `role_link` rows unchanged.

Optional extras included: purge of a parent lists child slugs in the `invalid` message; archived ancestors are marked "archived" in text, not only dimmed; each map node includes `depth` from the server.

## Why

A single `parent_id` gives an unambiguous forest and the same cycle check already used for tasks. Leaving old `reports_to` links alone avoids inventing a structure the owner never confirmed. Restricting parent changes to the owner or an `edit_any` role keeps a role from moving itself in or out of the owner's tree, without changing the rest of the 0.2.0 edit rules. Bounding map queries, the event window and the depth cap keeps the page usable once the 16-node cap is gone.
