---
name: gitnexus
description: Code intelligence via GitNexus knowledge graph — exploring, debugging, impact analysis, and refactoring
---

# GitNexus Blast Radius First Development Workflow

Practical workflow for using GitNexus before and during code changes in any repo.

## Purpose

Use GitNexus to do three things before editing:

1. Find the real symbol or execution path to change
2. Measure the blast radius before touching it
3. Check whether the final change scope matches intent

This is the working procedure I have been following on the graph and GitNexus migration work.

## Preconditions

- GitNexus CLI must be usable from this repo:
  - `pnpm run gitnexus -- status`
- If the index is stale:
  - `pnpm run gitnexus -- analyze`
- If CLI output looks wrong or targets are not found:
  - confirm the symbol name
  - retry with a broader query first

## Standard Edit Workflow

### 1. Understand the request in code terms

Translate the user request into:

- the likely symbol to edit
- the likely caller path
- the runtime surface to validate after the change

Examples:

- graph stale-state bug -> `useGraphSync`, `useGraphConnection`, `/api/graph`
- graph rendering issue -> `Neo4jGraph`
- observatory composition issue -> `ObservatoryPage`

### 2. Locate the right symbol

If the symbol is already obvious, go directly to impact.

If not, use:

- `pnpm run gitnexus -- query "<concept or symptom>"`
- `pnpm run gitnexus -- context <symbol>`

Use `query` first when the bug is described as behavior rather than a known function name.
Use `context` when you already know the suspect symbol and need callers/callees/processes.

### 3. Run impact before editing

For every function/class/method I plan to edit:

- `pnpm run gitnexus -- impact <symbol> --direction upstream`

What I look for:

- risk level
- direct callers
- affected processes
- whether the symbol sits on a shared hook or route boundary

Decision rule:

- `LOW`: proceed normally
- `HIGH` or `CRITICAL`: narrow the change, avoid broad refactors, and validate more aggressively

### 4. Inspect only the necessary files

After impact, read:

- the target file
- immediate caller files if impact shows them
- any API/consumer boundary involved in the change

This keeps the change local and avoids speculative edits.

### 5. Edit the smallest stable boundary

Preferred order:

1. fix the producer/contract
2. then the consumer
3. then visual polish

Examples from V0-Observatory repo:

- fix `/api/graph` before patching page-side graph synthesis
- fix `useGraphSync` error handling before tweaking banners
- fix edge-type normalization in the API before tuning renderer styles

### 6. Validate immediately after each patch

Use the smallest validation that proves the behavior:

- `pnpm exec eslint <touched files>`
- direct route calls with `node -e "fetch(...)"` for API work
- targeted test runs for existing tests
- Chrome validation for graph UI/physics/interaction work

Do not wait until the end of a long series of edits to validate basic assumptions.

### 7. Run detect-changes before closing

Always run:

- `pnpm run gitnexus -- detect-changes --scope all`

Interpretation in V0-Observatory repo:

- repo-wide `critical` is often noisy because the tree is already broadly dirty
- still use it to verify that your touched files are the ones you expected
- combine it with `git diff -- <touched files>` when the repo-wide scope is too noisy

## Workflow by Task Type

### Bug Fix

1. `query` on symptom if needed
2. `context` on suspect symbol if needed
3. `impact` on the symbol to edit
4. patch the narrowest boundary
5. validate the exact failing behavior
6. `detect-changes`

### Refactor

1. `context` on the symbol
2. `impact` on the symbol
3. if renaming, use GitNexus rename workflow first
4. update all d=1 dependents
5. validate behavior
6. `detect-changes`

### API Contract Change

1. `impact` on route/helper/hook symbols
2. patch the server contract first
3. patch the consuming hook/page second
4. validate with direct route calls
5. validate in UI only after contract is correct
6. `detect-changes`

### UI / Graph Rendering Change

1. `impact` on `Neo4jGraph` or page composition symbol
2. inspect upstream data producer first
3. fix missing data or bad normalization before renderer-only tweaks
4. validate in Chrome
5. `detect-changes`

## Practical Command Set

Use these first:

```bash
pnpm run gitnexus -- status
pnpm run gitnexus -- query "<concept>"
pnpm run gitnexus -- context <symbol>
pnpm run gitnexus -- impact <symbol> --direction upstream
pnpm run gitnexus -- detect-changes --scope all
```

## What “Plan Out the Changes” Means Here

Before editing, I should be able to say:

- what symbol is changing
- why that symbol is the correct boundary
- what upstream callers are affected
- what runtime path will prove the fix
- what I am intentionally not changing

If I cannot state those five points, the change is not planned well enough yet.


## GitNexus Code Intelligence ROUTER

Router skill for GitNexus knowledge graph workflows. Match your task to a workflow below, then read that file.

### Route Table

| Intent | Keywords | Read |
|--------|----------|------|
| **Explore** | "how does X work", "project structure", "where is", "show components" | `exploring.md` |
| **Debug** | "why is X failing", "trace error", "who calls", "returns 500" | `debugging.md` |
| **Impact** | "what breaks if", "blast radius", "safe to change", "who uses" | `impact-analysis.md` |
| **Refactor** | "rename", "extract module", "split service", "move to new file" | `refactoring.md` |

### Quick Start (all workflows)

```
1. READ gitnexus://repo/{name}/context    → Check index freshness
2. Pick workflow from route table above    → Read the corresponding .md file
3. Follow that workflow's checklist
```

> If index is stale → run `npx gitnexus analyze` in terminal first.

#### Shared Tools Reference

| Tool | Purpose |
|------|---------|
| `gitnexus_query` | Find execution flows related to a concept |
| `gitnexus_context` | 360-degree view of a symbol (callers, callees, processes) |
| `gitnexus_impact` | Blast radius — what breaks at depth 1/2/3 |
| `gitnexus_detect_changes` | Map git diff to affected execution flows |
| `gitnexus_rename` | Multi-file coordinated rename with confidence tags |
| `gitnexus_cypher` | Raw graph queries (read schema resource first) |
| `list_repos` | Discover indexed repositories |

##### Shared Resources

| Resource | Content | Tokens |
|----------|---------|--------|
| `gitnexus://repo/{name}/context` | Stats, staleness check | ~150 |
| `gitnexus://repo/{name}/clusters` | Functional areas with cohesion scores | ~300 |
| `gitnexus://repo/{name}/cluster/{name}` | Area members with file paths | ~500 |
| `gitnexus://repo/{name}/processes` | All execution flows | ~300 |
| `gitnexus://repo/{name}/process/{name}` | Step-by-step execution trace | ~200 |
| `gitnexus://repo/{name}/schema` | Graph schema for Cypher queries | ~200 |
