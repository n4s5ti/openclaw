# Chrome DevTools Physical Verification Protocol

## Purpose

Physical verification means the agent navigates to the actual page, interacts with real UI elements, and observes real behavior. This is NOT screenshot-only verification.

## When to Use

| Story Type | Verification Method |
|-----------|-------------------|
| UI/frontend | Full Chrome DevTools protocol below |
| API endpoint | Direct endpoint hit + response check |
| Backend-only | Test suite + log inspection |
| CLI tool | Run the command, check output |

## Protocol: UI/Frontend Stories

### 1. Navigate

```
mcp__chrome-devtools__navigate_page(url="<relevant page URL>")
```

Wait for page to fully load. Check for immediate console errors.

### 2. Interact

For each action in the user story, physically perform it:

```
mcp__chrome-devtools__click(selector="<button/link>")
mcp__chrome-devtools__fill(selector="<input>", value="<test data>")
mcp__chrome-devtools__press_key(key="Enter")
```

Touch EVERY part of the user story, not just the patched area. If the story is "user sends chat and gets response":
- Type a message in the input
- Click send
- Wait for response to appear
- Verify response content makes sense

### 3. Observe

After each interaction:

```
mcp__chrome-devtools__list_console_messages()
  → Filter for errors and warnings
  → ANY error = verification FAIL

mcp__chrome-devtools__list_network_requests()
  → Check for 4xx/5xx responses
  → Check for failed/aborted requests
  → ANY failure = verification FAIL
```

### 4. Probe Boundaries

Test edge cases relevant to the story:

- **Empty state**: What happens with no data?
- **Error state**: What happens when the backend is down?
- **Loading state**: Is there a loading indicator?
- **Rapid actions**: Click twice quickly — does it break?

```
mcp__chrome-devtools__evaluate_script(expression="<DOM state check>")
```

### 5. Capture Evidence

```
mcp__chrome-devtools__take_screenshot()
```

Save screenshot path to journal as visual evidence.

### 6. Verdict

**PASS**: Entire story flow works end-to-end with:
- Zero console errors
- Zero network failures
- All UI elements responsive
- Correct data displayed

**FAIL**: ANY of the following:
- Console error (even unrelated-looking ones — they may cascade)
- Network 4xx/5xx
- Broken UI state (missing elements, wrong data, frozen interaction)
- Unexpected behavior vs. story description

On FAIL: the specific error becomes the new search target → GOTO Step 1 of the main loop.

## Protocol: API Endpoint Stories

### 1. Hit the Endpoint

```
mcp__chrome-devtools__evaluate_script(expression="
  fetch('/api/endpoint', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({test: true}) })
    .then(r => r.json())
    .then(d => console.log('API_TEST:', JSON.stringify(d)))
    .catch(e => console.error('API_TEST_FAIL:', e.message))
")
```

Or use bash:
```bash
curl -s http://localhost:PORT/api/endpoint | jq .
```

### 2. Check Response

- Status code 200/201 expected
- Response body matches contract
- No error fields in response

### 3. Check Server Logs

Look for errors, warnings, or unexpected behavior in the terminal/log output.

## Protocol: Backend-Only Stories

### 1. Run Tests

```bash
pytest tests/test_<relevant>.py -v
# or
pnpm test -- --grep "<relevant pattern>"
```

### 2. Check for Regressions

Run the broader test suite for the module, not just the specific test:

```bash
pytest tests/ -v --tb=short
```

### 3. Manual Endpoint Probe

If the backend exposes any HTTP endpoint, hit it directly and verify response.

## Common Pitfalls

1. **Don't trust absence of errors** — actively trigger the story flow, don't just load the page
2. **Don't ignore "unrelated" console errors** — they often cascade from the real break
3. **Don't verify only the patched path** — verify the ENTIRE story flow
4. **Don't skip network request checks** — silent 500s are the most common hidden break
5. **Don't assume loading states are temporary** — if something is stuck loading, that's a fail
