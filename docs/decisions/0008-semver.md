# 0008. Semantic versioning

## Context

The package version is 0.x. The README said that while the version is below 1.0, a minor version may change things without keeping compatibility. That is a common 0.x practice, but it is not how this project had been versioning fixes (a fix is a patch). The remaining question is how a breaking change is numbered before 1.0, and when 1.0.0 itself is released.

## Options

1. **Keep the 0.x exception.** Until 1.0, a minor version (0.6 → 0.7) may break compatibility; a patch stays compatible. This matches the previous README text and a common reading of semver for pre-1.0 software.

2. **Follow the same three-way rule in 0.x as after 1.0.** A patch is a fix without new functionality. A minor is only for new functionality and stays compatible. A major is for a breaking change, including jumping from 0.x to 1.0 because something broke. This was the first decision on this record.

3. **Before 1.0, a breaking change is a minor.** A patch is a fix without new functionality. A minor is for new functionality and, before 1.0, also for a breaking change. 1.0.0 is released only on the owner's explicit decision, never as a side effect of a feature or of a breaking change. Chosen.

## Decision

The first form of this decision (option 2) was recorded on 27 November 2026. It was amended by Арина on 27 November 2026 at 11:42 AM PT (America/Los_Angeles), recorded on issue #181.

Versions follow [Semantic Versioning](https://semver.org/) with this meaning while the version is 0.x:

- A **patch** (for example 0.6.0 → 0.6.1) is a fix without new functionality, and stays compatible with the rest of its minor version.
- A **minor** (for example 0.6 → 0.7) is for new functionality, and before 1.0 also for a breaking change: configuration, MCP tools and their results, the owner API, the export format, or the database can change in ways that need the operator to do something. The changelog says what and how.
- **1.0.0** is released only on the owner's explicit decision. It is never a side effect of a feature or of a breaking change.

A fix PR does not bump the package version; the version is set in the release PR for that version, as with 0.5.0 and 0.6.0.

## Why

A fix stays a patch, and new functionality stays a minor, which is how releases have been numbered. Treating a pre-1.0 breaking change as a jump to 1.0 would have made 1.0 a side effect of a feature. Before 1.0, a breaking change therefore bumps the minor version on the 0.x line, and 1.0.0 waits for the owner to decide that the project is ready. Writing that rule down keeps the README, the changelog, and later release PRs aligned.
