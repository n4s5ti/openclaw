---
name: gitnexus-triage
description: Targeted search-fix loop for bug hunting with BRFD gating and Chrome DevTools physical verification
trigger_phrases: ["triage", "audit", "sweep", "health check", "find broken", "gitnexus-triage"]
---

# GitNexus Triage: Targeted Search-Fix Loop

Hunt bugs by keyword domain. For each keyword: identify user stories → find broken symbols → BRFD-gated fix → Chrome DevTools physical verification → journal → repeat until clean.

## Invocation

```
/gitnexus-triage "<keyword>"
/gitnexus-triage "<keyword>" --ralph    # wrap in Ralph persistence
```

## Preconditions

- GitNexus CLI usable: `pnpm run gitnexus -- status`
- If stale: `pnpm run gitnexus -- analyze`
- Chrome DevTools MCP available for UI/API stories

## The Loop

### STEP 0: STORY IDENTIFICATION (once per keyword)

Before scanning code, ask: **"What should a user be able to DO in this keyword's domain?"**

```
pnpm run gitnexus -- query "<keyword>"
pnpm run gitnexus -- context <key symbols found>
```

Identify user stories from the execution flows. Example for `"orchestrator"`:
1. User sends chat → gets agent response
2. User sees active agents and their status
3. User loads previous chat history
4. Orchestrator survives subprocess crashes
5. WebSocket streams events to connected clients

Write stories to journal as the audit checklist. Each story scopes which symbols/flows to audit.

### LOOP (per story, per suspect):

#### STEP 1: SEARCH

```
pnpm run gitnexus -- query "<keyword>" # within current story scope
pnpm run gitnexus -- context <suspect symbol>
```

Classify the suspect using the health table below. If **healthy**: next suspect. If no suspects left: story clean.

#### STEP 2: MEASURE (BRFD 5-Point Litmus)

```
pnpm run gitnexus -- impact <suspect> --direction upstream
```

Before ANY edit, state these five points:

1. **What symbol** is suspect
2. **Why** this might be broken
3. **What upstream callers** depend on it
4. **What runtime path** proves it healthy
5. **What I'm intentionally not touching** yet

Decision rule:
- `LOW` blast radius: proceed normally
- `HIGH`/`CRITICAL`: narrow the change, validate more aggressively

#### STEP 3: FIX (smallest stable boundary)

1. Write failing test for the break (TDD when possible)
2. Fix producer/contract first, then consumer, then polish
3. Keep edit minimal — BRFD principle

Order: fix the data source → fix the consumer → fix the presentation.

#### STEP 4: DETECT DRIFT

```
pnpm run gitnexus -- detect-changes --scope all
```

- Did the fix break something new?
- **YES** → new break becomes next STEP 1 target (follow the cascade)
- **NO** → proceed to verification

#### STEP 5: PHYSICAL VERIFICATION

Read `chrome-verification.md` for the full protocol.

**UI/API stories:** Navigate, interact, check console + network, probe boundaries.
**Backend-only:** Run test suite, hit endpoints directly, check logs.

At FIRST sign of ANY error → GOTO STEP 1 with the new error as search target.

#### STEP 6: JOURNAL

Read `journal-format.md` for the template. Append to `.omc/notepad.md` or `progress.txt`:

- What was found (symbol, file, line)
- Classification (broken/unwired/fragile)
- Blast radius (from impact)
- What was fixed (diff summary)
- Verification result (pass/fail + evidence)
- Cascade effects

→ NEXT SUSPECT in current story, or NEXT STORY if current is clean
→ EXIT when all stories for keyword are verified clean

## Symbol Health Classification

| Verdict | Meaning | Detection |
|---------|---------|-----------|
| **broken** | Missing deps, unreachable callees | `context` shows callees that don't resolve |
| **unwired** | Exists but nothing calls it (not an entry point) | `context` shows 0 incoming, not step-1 in any process |
| **fragile** | Works but high risk | `impact` HIGH + no test coverage |
| **orphan** | Dead code | No callers, no callees, no process membership |
| **healthy** | All checks pass | Callers exist, callees reachable, blast radius proportional |

**Entry point detection:** Symbol is step-1 in a GitNexus process, OR in an entry-point file (`route.ts`, `main.py`, `index.ts`, `server.py`), OR exported from a module boundary.

## Cascade Handling

When fixing symbol A breaks symbol B:

```
Fix A → detect-changes → B is now broken
  → B becomes next STEP 1 target
    → Fix B → detect-changes → C is now broken
      → Fix C → detect-changes → CLEAN
    → Back to verifying A's story (re-run Step 5)
```

Follow cascades without depth limit. The journal tracks the chain so the agent (or next agent after compaction) knows what happened.

## Ralph Integration (Optional)

When invoked with `--ralph`:
- One Ralph story per keyword: "Clean the `<keyword>` domain"
- Acceptance criterion: "All user stories verified clean via Chrome DevTools + gitnexus detect-changes"
- Ralph handles persistence across sessions and architect verification at end
- Without `--ralph`: loop + journal is the entire workflow, no overhead

## Sub-Workflows

| File | Purpose |
|------|---------|
| `search-fix-loop.md` | Detailed loop algorithm with decision trees |
| `chrome-verification.md` | Physical verification protocol using Chrome DevTools |
| `journal-format.md` | Journal entry template and examples |
