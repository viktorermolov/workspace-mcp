# 0001. Titled rules sets

## Context

Working rules were a single untitled row per owner (`member_id` was the primary key). `update_rules` replaced that one text, and `start` / `get(type: "rules")` returned only it. There was no way to keep a named or project-scoped set beside the production rules, so test rules could not sit next to them.

Issue: https://github.com/viktorermolov/workspace-mcp/issues/49

## Options

1. **How `start` presents rules when a project is given.** Project rules could replace the global working rules, or they could be returned in addition to them.
2. **How testing works.** A separate "active" test set (a flag or a dedicated slot that agents would switch to) versus ordinary sets attached to a test project, for example `[TEST]`.
3. **Identity.** Sets could be keyed by a unique `slug`, or slugs could be allowed to collide (with identity only by id or title).
4. **Shape and compatibility.** A multi-row model (id, unique slug, title, optional project) versus keeping a single global row; and whether existing `get` / `update_rules` / `start` calls without new arguments must keep working, without a package version bump.

## Decision

Approved by Арина on 26 November 2026 at 9:49 AM PT (America/Los_Angeles), recorded on the issue:

1. `start` returns the global working rules, and when a project is given also that project's rules. Project rules supplement the global rules; they do not replace them.
2. There is no separate "active" test set. Testing goes through a `[TEST]` project (attach a set to that project and pass it to `start`).
3. A rules set's `slug` is unique per member.

The implementation is the multi-row model: each set has an `id`, a unique `slug`, a `title`, and an optional `project`. The existing default set is migrated to slug `working-rules`, title `Working rules`, and remains the unique default (always global). Existing `get`, `update_rules` and `start` calls that omit the new arguments still return or update that default set. The package version is not bumped; this is not a release PR.

## Why

Supplementing rather than replacing keeps shared working rules in effect for every project, while still letting a project (including a test project) add its own. Routing tests through a `[TEST]` project avoids a second "which set is active?" mechanism that agents would have to learn and that could silently swap production rules. Unique slugs match how roles and projects are already identified, so `get` and `update_rules` can take a slug or an id. Backward-compatible defaults mean current clients and the owner UI keep working without a version bump.

