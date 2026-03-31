# Search-Fix Loop: Detailed Algorithm

## Loop Entry

The loop starts after Step 0 (story identification) produces a list of user stories. Each story scopes a set of symbols to audit.

## Decision Tree

```
FOR each story in stories:
  suspects = gitnexus query "<keyword>" filtered to story scope

  FOR each suspect in suspects:
    ┌─ SEARCH: gitnexus context <suspect>
    │
    ├─ healthy? → SKIP, next suspect
    │
    ├─ broken/unwired/fragile/orphan?
    │   │
    │   ├─ MEASURE: gitnexus impact <suspect> --direction upstream
    │   │   State the 5-point BRFD litmus (see SKILL.md)
    │   │
    │   ├─ FIX: smallest stable boundary
    │   │   1. Write failing test (TDD)
    │   │   2. Fix producer → consumer → polish
    │   │   3. Keep edit minimal
    │   │
    │   ├─ DETECT DRIFT: gitnexus detect-changes --scope all
    │   │   │
    │   │   ├─ New break found?
    │   │   │   → Push current suspect to stack
    │   │   │   → New break becomes current suspect
    │   │   │   → GOTO SEARCH (cascade)
    │   │   │
    │   │   └─ No new breaks?
    │   │       → VERIFY (Step 5)
    │   │
    │   ├─ VERIFY: Chrome DevTools or test suite
    │   │   │
    │   │   ├─ Error found during verification?
    │   │   │   → New error becomes current suspect
    │   │   │   → GOTO SEARCH
    │   │   │
    │   │   └─ Clean?
    │   │       → JOURNAL (Step 6)
    │   │       → Pop stack if cascade, re-verify parent
    │   │       → Next suspect
    │   │
    │   └─ orphan?
    │       → Journal as dead code candidate
    │       → Do NOT delete without user confirmation
    │       → Next suspect
    │
    └─ END suspects → story is CLEAN

  END stories → keyword domain is CLEAN → EXIT
```

## Cascade Stack

When a fix creates a cascade, the loop uses an implicit stack:

```
Stack: [original_suspect]
Fix original → new break B found
Stack: [original_suspect, B]
Fix B → new break C found
Stack: [original_suspect, B, C]
Fix C → clean
Pop C, re-verify B → clean
Pop B, re-verify original → clean
Stack: []
```

The journal records the full cascade chain for traceability.

## Story Scoping

Not every symbol returned by `gitnexus query` belongs to every story. Scope suspects to the current story:

1. Look at the execution flow the story describes
2. Use `gitnexus context` to find symbols on that flow
3. Only audit symbols that participate in THIS story's flow
4. Cross-cutting symbols (shared utilities) get audited once, in the first story that touches them

## Fix Sizing Rules

| Blast Radius | Fix Approach |
|-------------|-------------|
| LOW (0-3 callers) | Fix directly, validate with tests |
| MEDIUM (4-10 callers) | Fix producer first, test each caller individually |
| HIGH (11+ callers) | Consider interface preservation — fix behind the contract |
| CRITICAL (shared boundary) | Discuss with user before editing |

## When to Stop

The loop exits when:
1. All stories have been iterated
2. All suspects in each story are classified as healthy or journaled
3. No pending cascades on the stack
4. Final `detect-changes --scope all` shows no new critical findings in the keyword domain

## When NOT to Fix

- **Orphan code**: Journal it, don't delete without user confirmation
- **Design debt**: Journal as fragile, propose refactor separately
- **Out-of-scope breaks**: If a cascade leads outside the keyword domain, journal it and stop following — it belongs to a different triage run
