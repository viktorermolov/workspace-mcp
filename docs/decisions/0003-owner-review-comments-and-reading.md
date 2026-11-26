# 0003. Owner review comments and reading

- Issue: [#58](https://github.com/viktorermolov/workspace-mcp/issues/58)
- Date: 2026-11-26
- Status: Accepted

## Context

The owner reads working rules, other rules sets, role instructions, setup notes, project descriptions and documents in the web interface, but until now they were shown as plain `<pre>` text. There was no way to leave a review comment on a passage, for a bot to answer it, or to keep the comment attached when the text changes.

The approved plan is in [comment 7200656585](https://github.com/viktorermolov/workspace-mcp/issues/58#issuecomment-7200656585), with amendments in [comment 7200800859](https://github.com/viktorermolov/workspace-mcp/issues/58#issuecomment-7200800859) and Dev Guardian's approval and clarifications in [comment 7200818325](https://github.com/viktorermolov/workspace-mcp/issues/58#issuecomment-7200818325). This record covers both pull requests: A (Reading, no migration) and B (comments, one migration).

## Options

1. **Reading and comments in one pull request, with a new comment API and a third-party Markdown renderer.** Fast to ship as a single change, but it would mix a UI-only change with a migration, and a third-party renderer is harder to constrain (time, URL schemes, HTML).
2. **Two pull requests, both under [Unreleased], with a small in-house Markdown parser that emits only interface elements, and comments in the second pull request.** Chosen. The version stays at 0.2.0; 0.3.0 is a later release pull request that merges only after Viktor's "yes".
3. **Comments only, leaving reading as `<pre>`.** Rejected: the owner asked to read rendered Markdown, and comments need block-level line ranges on a rendered page.

## Decision

Option 2. The eight review points and the answers to the nine open questions are part of the decision, as are the four clarifications on the re-anchoring budget.

### Eight review points

1. This decision record (`docs/decisions/0003-owner-review-comments-and-reading.md`) lands in pull request A, and is listed with the other docs in that pull request.
2. History of `setup_notes` is an append-only table in the migration of pull request B, written in the same transaction as `saveRole`, made immutable by a trigger, and deletable only under `purge_guard`. The reading page will show that history with an explicit note that it starts at the upgrade. A comment on `setup_notes` points at a history row, not only at `text_hash`. The `version.entity_type` CHECK is left unchanged (adding a value would require rebuilding the `version` table). The comments migration uses id 6 (`review-comments`); id 5 is reserved for a separate change.
3. Link allow-list: internal paths that start with `/` do not include the prefixes `//` or `/\`. The scheme is checked after HTML entities and percent-escapes are decoded, after whitespace and control characters are stripped, and without regard to case. Internal links use the in-app router and do not get `target="_blank"`. The same allow-list applies to the link used in place of an image, to reference definitions (`[x]: url`) and to autolinks (`<...>`).
4. The parser is in-house, on these terms: linear time, no regular expression that can backtrack; a nesting limit for lists, quotations and inline emphasis; on an error or a limit, fall back to the current `<pre>` (try/catch); render only to VNodes, with text only as children, never as markup. Searches for a closing delimiter are capped at 2,048 characters or the end of the line; constructs that do not close within that cap are rendered as plain text. `scripts/check-tree.sh` fails on `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `dangerouslySetInnerHTML` and `document.write` in `ui/`.
5. The test corpus includes every case listed in the amendments (javascript: in mixed case, with leading spaces, with tabs or newlines inside and with `&#106;` / `&#x09;`; `vbscript:` and `data:text/html`; `//evil.example` and `/\evil.example`; nested `[[a](javascript:…)](https://…)`, links in an image alt and reference definitions; raw `<script>`, `<img onerror>` and `<a href>` shown as text; entities such as `&lt;b&gt;` shown literally, without a second decode; a 200k-character document and pathological inputs of 10k `*`, `[` or `>`; a property-based test that no emitted `href` leaves the allow-list).
6. For `POST /reviews` the server checks that the version belongs to that target and field and that the line range is inside the text. It recomputes `quote`, `quote_hash` and the context itself from the stored text; client-supplied values are not trusted.
7. Re-anchoring runs inside `BEGIN IMMEDIATE` (texts up to 200k characters), with the budget in the clarifications below. A test with about 200 open comments on a 200k-character document checks the time.
8. `review.commented` is sent to every active role with `edit_any`. If there is no such role, no webhook is sent. Both cases are documented in `webhooks.md` and covered by tests.

### Answers to the nine open questions

1. Only the owner can close a comment (resolved). Bots, including roles with `edit_any`, cannot close one.
2. Bots do not create comments; they only reply.
3. An owner's reply on an answered comment reopens it.
4. Comments on rules are answered by roles with `edit_any`. A project's owning role sees comments on that project's rules sets in `start` and may reply, but only `edit_any` can mark them answered. If nobody has `edit_any`, the comment appears only in the general list.
5. An in-house VNode renderer, on the terms in points 3–5 above.
6. Dropped as a separate question: history of `setup_notes` is required by point 2.
7. `start` shows 10 comments plus a count, inside the existing compression ladder.
8. Yes, `review.commented`, as in point 8.
9. Two pull requests under `[Unreleased]`, with no version change. 0.3.0 is a separate release pull request that merges only after Viktor's "yes".

### Re-anchoring budget (clarifications)

These numbers were accepted in the approval and will be checked in pull request B:

1. One budget, not stacked: 500 ms in total, and the 200 ms `lineDiff` timeout counts toward it. Time is taken from a monotonic clock (`performance.now()`), and is checked before each comment, inside the exact-hit loop, and inside the fuzzy loop. When the deadline is reached, that comment and any remaining comments become `outdated`.
2. The fuzzy window is ±20 lines and at most about 8,000 characters. Only spans whose length is close to the quote (≤ 500 characters of slack) are compared. A single line may be 200k characters, so a line-only window would be too large. Exact-quote ranking uses the same window (and stops after a fixed number of hits); a unique occurrence elsewhere is still accepted. Offsets are mapped to line numbers from a line-start index built once per remapping, with a binary search — not by rescanning the text for each hit.
3. `maxEditLength` stays at 10,000. If the diff hits a limit, the exact-quote search (step 1) still runs; only the later steps fall back to `outdated`.
4. The timing test asserts well under 500 ms on CI amd64, about ≤ 250 ms. The Raspberry Pi is slower.

5. Timing tests also cover two pathological cases at 200k characters with 200 comments: a quote that repeats on every line, and a single long line. Both must stay under about 250 ms on CI amd64.

Forbidden status changes write a `role_check` row in `oauth_diag` (`warning` when warning mode still applies the change, `rejected` when it is refused). A rejected write rolls back its transaction, so the rejected row is inserted through `afterTransaction` after the rollback. That helper is also in #79 (not yet on master); this change includes a compatible copy so rejected review-status rows survive today.

### Optional points also accepted

Optimistic concurrency (`rev` or the expected status) on a status change by the owner and by a bot; `reply_review_comment` takes only `claimed_role`, not the deprecated synonym `role`; `event.data` and `changes_since_previous_start` carry a preview, not the full body; tests cover import order (`review_comment` after `version`, `review_reply` after `review_comment`) and purge (comments on a role, document or project are deleted before versions); on `/read` pages, archived items appear only when `include_archived` is on.

## Why

Splitting reading from comments lets the owner start reading rendered Markdown without waiting for a migration, and keeps the migration in one place. An in-house parser with an allow-list, a linear-time bound and a check against HTML insertion APIs is the only way to render Markdown in this interface without weakening the existing rule that stored text is data, not HTML. The re-anchoring budget is capped so a write that also remaps comments cannot hold the database lock for long; when the budget is exceeded, comments become `outdated` rather than blocking the save. Closing stays with the owner so a bot cannot dismiss a remark; `edit_any` answers rules comments because no rules set has an owning role.
