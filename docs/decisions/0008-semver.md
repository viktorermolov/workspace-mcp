# 0008. Semantic versioning

## Context

The package version is 0.x. The README said that while the version is below 1.0, a minor version may change things without keeping compatibility. That is a common 0.x practice, but it is not how this project versions releases: a fix has been published as a patch, and a breaking change is treated as a major step, not as an ordinary minor.

The question is which rule the README, changelog, and later releases follow.

## Options

1. **Keep the 0.x exception.** Until 1.0, a minor version (0.6 → 0.7) may break compatibility; a patch stays compatible. This matches the previous README text and a common reading of semver for pre-1.0 software.

2. **Follow the same three-way rule in 0.x as after 1.0.** A patch is a fix without new functionality. A minor is only for new functionality and stays compatible. A major is for a breaking change. Chosen.

## Decision

Versions follow [Semantic Versioning](https://semver.org/) with this meaning, including while the version is 0.x:

- A **patch** (for example 0.6.0 → 0.6.1) is a fix without new functionality, and stays compatible with the rest of its minor version.
- A **minor** (for example 0.6 → 0.7) is only for new functionality, and stays compatible.
- A **major** (for example 0.x → 1.0) is a breaking change: configuration, MCP tools and their results, the owner API, the export format, or the database can change in ways that need the operator to do something. The changelog says what and how.

A fix PR does not bump the package version; the version is set in the release PR for that version, as with 0.5.0 and 0.6.0.

## Why

The previous README rule would have let a minor release break compatibility by default, which is the opposite of how the owner versions the software: patches for fixes, minors only when something new is added, majors when something breaks. Writing that rule down keeps the README, the changelog, and later release PRs aligned, and stops a 0.x "minors may break" policy from being applied by habit.
