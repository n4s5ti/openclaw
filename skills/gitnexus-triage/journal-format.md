# Triage Journal Format

## Location

Write to `.omc/notepad.md` (OMC notepad) or `progress.txt` in the project root.

## Header (once per triage run)

```markdown
## gitnexus-triage "<keyword>" — YYYY-MM-DD

### Stories Identified
1. <story description>
2. <story description>
3. <story description>
...
```

## Fix Entry (per fix)

```markdown
### Fix #N: <short description> (Story M)
- **found:** <how it was discovered — gitnexus query/context output>
- **symbol:** <SymbolName> @ <file:line>
- **classification:** broken | unwired | fragile | orphan
- **blast radius:** LOW | MEDIUM | HIGH | CRITICAL (<N> upstream callers)
- **brfd litmus:**
  1. Symbol: <what>
  2. Why broken: <reason>
  3. Upstream: <callers>
  4. Runtime proof: <path>
  5. Not touching: <scope boundary>
- **fix:** <1-2 sentence summary of the change>
- **test:** <test added, or "existing test covered">
- **cascade:** <did fixing it break something else? what?>
- **verification:** PASS | FAIL
  - method: chrome-devtools | pytest | curl | manual
  - evidence: <screenshot path, test output summary, or response code>
- **status:** CLEAN | CASCADE → Fix #X
```

## Story Completion Entry

```markdown
### Story M: <story description>
- **suspects audited:** N
- **fixes applied:** N
- **cascades followed:** N
- **final verification:** PASS — <method + evidence>
- **status:** CLEAN
```

## Run Summary (at end)

```markdown
### Summary
- **stories:** N identified, N clean, N remaining
- **fixes:** N applied
- **cascades:** N followed
- **orphans found:** N (logged, not deleted)
- **fragile symbols:** N (logged for future refactor)
- **domain status:** CLEAN | PARTIAL (N stories remaining)
```

## Example

```markdown
## gitnexus-triage "orchestrator" — 2026-03-10

### Stories Identified
1. User sends chat → gets agent response
2. User sees active agents and their status
3. User loads chat history
4. Orchestrator survives subprocess crash
5. WebSocket streams events

### Fix #1: GraphClient subprocess crash (Story 4)
- **found:** gitnexus query "orchestrator" → GraphClient.start, 0 error handling
- **symbol:** GraphClient.start @ apps/orchestrator/modules/graph_client.py:78
- **classification:** broken
- **blast radius:** HIGH (14 upstream callers)
- **brfd litmus:**
  1. Symbol: GraphClient.start
  2. Why broken: no error handling, subprocess crash kills orchestrator
  3. Upstream: OrchestratorService, AgentManager, 12 others
  4. Runtime proof: kill neo4j, check orchestrator stays alive
  5. Not touching: GraphClient.query, GraphClient.close
- **fix:** Added try/except with auto-restart and exponential backoff (lines 78-95)
- **test:** test_graph_client_restart_on_crash added
- **cascade:** OrchestratorService.initialize broke (import path change) → Fix #2
- **verification:** PASS
  - method: pytest
  - evidence: 14/14 tests passing, endpoint returned 200 after neo4j restart
- **status:** CLEAN

### Fix #2: Import path cascade from Fix #1 (Story 4)
- **found:** gitnexus detect-changes after Fix #1
- **symbol:** OrchestratorService.initialize @ apps/orchestrator/modules/orchestrator_service.py:23
- **classification:** broken (cascade)
- **blast radius:** MEDIUM (6 upstream callers)
- **brfd litmus:**
  1. Symbol: OrchestratorService.initialize
  2. Why broken: import path changed by Fix #1
  3. Upstream: main.py, 5 test files
  4. Runtime proof: orchestrator startup
  5. Not touching: OrchestratorService.handle_message
- **fix:** Updated import from graph_client (line 23)
- **test:** existing test covered
- **cascade:** none
- **verification:** PASS
  - method: pytest + curl
  - evidence: all tests green, /api/orchestrator returned 200
- **status:** CLEAN

### Story 4: Orchestrator survives subprocess crash
- **suspects audited:** 8
- **fixes applied:** 2
- **cascades followed:** 1
- **final verification:** PASS — pytest full suite + manual neo4j kill test
- **status:** CLEAN

### Summary
- **stories:** 5 identified, 1 clean, 4 remaining
- **fixes:** 2 applied
- **cascades:** 1 followed
- **orphans found:** 0
- **fragile symbols:** 3 (logged for future refactor)
- **domain status:** PARTIAL (4 stories remaining)
```
