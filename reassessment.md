# Stopping Claude Code's regression spiral in geospatial apps

**The Playwright MCP combined with block-at-commit hooks and a test-driven CLAUDE.md is the most effective stack for preventing Claude Code from introducing regressions in complex web applications.** The "fix one, break another" pattern you're experiencing is the most commonly reported issue with Claude Code on complex projects — it stems from context decay after compaction, overly broad modifications, and the absence of automated guardrails that force the agent to verify its work. The solution is a layered defense: an MCP for browser verification, pre-commit hooks that block commits until the full test suite passes, property-based tests for your geo logic, and architectural patterns that isolate your most regression-prone modules.

---

## The Playwright MCP is the clear winner for browser testing

Seven browser-testing MCPs exist for Claude Code, but **Microsoft's official Playwright MCP** (`@playwright/mcp`) stands out as the right choice for your geospatial app. It installs in a single command, supports headless mode for CI, works across Chromium, Firefox, and WebKit, and is explicitly recommended by Anthropic's own documentation.

```bash
claude mcp add playwright -- npx @playwright/mcp@latest
```

The MCP provides `browser_navigate`, `browser_take_screenshot`, `browser_click`, `browser_evaluate` (for running JavaScript against your Leaflet map instance), and `browser_snapshot` (structured accessibility tree). For your map-heavy app, `browser_evaluate` is critical — it lets Claude call Leaflet APIs directly (e.g., `map.setZoom(15)`, `map.getBounds()`, inspecting cluster state) since canvas-rendered map elements don't appear in the accessibility tree.

**Google's Chrome DevTools MCP** (`chrome-devtools-mcp`) is the strongest complement. It provides full DevTools access including network monitoring, console logs with source-mapped stack traces, and Core Web Vitals performance tracing. One developer called it "the most valuable MCP server I've ever used" for the self-debugging loop it enables. The recommended pairing: **Playwright MCP for E2E testing, Chrome DevTools MCP for debugging regressions**.

The other MCPs are less suitable for your case. **Browserbase MCP** is cloud-based and designed for enterprise/stealth scenarios — overkill for local development testing. The **official Puppeteer MCP is deprecated** (moved to `servers-archived`). The **browser-use MCP** requires a separate LLM API key and adds unnecessary latency through its AI interpretation layer. **Claude in Chrome** (Anthropic's first-party extension) works well for quick visual checks during development but can't run headless, ruling it out for CI.

## Why headless screenshot analysis alone fails for maps

Your experience with headless screenshots not working well is expected. Map-based UIs present three specific challenges that make naive screenshot comparison unreliable: **non-deterministic tile loading** (tiles arrive asynchronously from OpenStreetMap servers, creating different pixel outputs between runs), **canvas rendering variability** (canvas/WebGL output differs across OS, GPU, and browser versions), and **animation artifacts** (Leaflet's zoom and fade animations create transitional states).

The fix is a three-part strategy. First, **mock your tile server** to eliminate network variability. Playwright's `page.route()` can intercept all tile requests and serve a consistent local image:

```javascript
await page.route('**/tile.openstreetmap.org/**', route => {
    route.fulfill({ path: './test-fixtures/blank-tile.png' });
});
```

Second, **disable Leaflet animations** in your test configuration (`L.Map({ zoomAnimation: false, fadeAnimation: false })`) and use Playwright's `animations: 'disabled'` option. Third, **mask the tile layer and test overlays separately**. The Houseful/Zoopla engineering team (a real estate platform with similar map-heavy UI) explicitly masks embedded maps in their visual tests: they value "trust in our pipelines over needing to capture this piece of the page." Your polygons, markers, and clusters rendered on the overlay pane can be screenshotted independently via `page.locator('.leaflet-overlay-pane').screenshot()` with tight thresholds (**maxDiffPixels: 50–100**), while full-map screenshots need much looser settings (**maxDiffPixelRatio: 0.10–0.15**).

For the most reliable visual regression on dynamic map content, **Applitools Eyes** offers AI-powered "Layout" match levels that check structural layout while ignoring tile content changes — the best commercial option for map UIs specifically. For free alternatives, Playwright's built-in `toHaveScreenshot()` with tile mocking is the practical choice.

## Block-at-commit hooks are the single most impactful change

The core pattern causing your regressions is that Claude Code makes changes and commits them without running the full test suite. **A PreToolUse hook that intercepts `git commit` and blocks it until all tests pass forces Claude into a test-and-fix loop** — this is the technique used by Shrivu Shankar at Abnormal AI, who processes billions of Claude tokens monthly in production.

Add this to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "if echo \"$CLAUDE_TOOL_INPUT\" | jq -r '.command' | grep -q '^git commit'; then cd backend && pytest tests/ -v --tb=line && cd ../frontend && npx vitest run; fi",
            "timeout": 300
          }
        ]
      }
    ]
  }
}
```

Critical detail: **do not use block-at-write hooks** (intercepting file edits). Blocking an agent mid-plan confuses it and produces worse results. Let Claude finish its implementation, then gate the commit. Additionally, add a **SessionStart hook** that re-injects testing reminders after context compaction — this directly addresses the context-decay problem where Claude "forgets" testing requirements after long sessions:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [{
          "type": "command",
          "command": "echo 'REMINDER: Run full test suite before committing. Never modify existing tests without approval.'"
        }]
      }
    ]
  }
}
```

## Your CLAUDE.md needs explicit anti-regression rules

The CLAUDE.md file is what experienced users call "the agent's constitution." For your project, it should include module dependency mappings that tell Claude which test files to run when modifying specific modules. This prevents the pattern where Claude fixes `polygon_matcher.py` without checking whether it broke zoom rendering:

```markdown
## Anti-Regression Rules
- Before changing polygon_matcher.py: run pytest tests/test_polygon_matching.py 
  tests/test_cluster_logic.py tests/test_zoom_rendering.py -v
- Before changing normalizer.py: run pytest tests/test_normalizer.py 
  tests/test_detail_panel.py -v
- Before changing any filter logic: run the full frontend test suite
- If tests fail after your change, REVERT and rethink — do NOT fix tests
- If a fix requires changes to more than 3 files, STOP and present a plan first
```

Equally important: **instruct Claude to use `/plan` mode for any change touching more than 3 files**, and use `/clear` between unrelated tasks to prevent context contamination. The "Document & Clear" pattern — having Claude dump its plan to a markdown file, clearing context, then starting fresh with that file as input — dramatically reduces the cascading-change problem.

## Each regression-prone area needs a specific testing approach

Your six regression hotspots each call for different testing strategies, and the most important architectural principle is **extracting all geo logic into pure functions** that can be tested without React, Leaflet, or HTTP:

**Polygon/geocoding matching** needs property-based testing. Python's Hypothesis library generates thousands of random coordinate pairs and verifies invariants like "any point inside a known polygon must match that polygon's bairro." This catches edge cases (boundary points, multipolygons, antimeridian) that hand-written tests miss. On the frontend, `fast-check` does the same for JavaScript geo functions.

**Bairro name normalization** is best served by **table-driven tests** with a golden file containing every known variant-to-canonical mapping. This file becomes a contract — if Claude changes the normalization logic, the golden file catches any regression immediately. Add a Hypothesis test that verifies the normalizer never crashes on arbitrary string input.

**Cluster-merge logic** should use snapshot/golden testing with known datasets. Save the expected cluster output for a fixed set of input points at zoom levels 3, 6, 10, 13, 16, and 18. Property-based tests verify invariants: total point count is preserved across clustering, higher zoom always produces equal or more clusters, identical positions always merge.

**Zoom-level-dependent rendering** uses parameterized Playwright tests that programmatically set zoom via `page.evaluate(() => map.setZoom(level))` and assert the correct DOM state — clusters visible at low zoom, individual markers at high zoom.

**Filter interactions** benefit from combinatorial testing with `fast-check`. Generate random filter combinations and verify invariants: result is always a subset of input, filters are commutative (applying filter A then B produces the same result as B then A), clearing all filters returns the full dataset.

**Detail panel data consistency** requires a contract test that fetches the same property from both the list endpoint and the detail endpoint and asserts matching values for price, bairro, address, and coordinates.

## Contract testing between Next.js and FastAPI prevents silent breakage

FastAPI auto-generates an OpenAPI spec from your Pydantic models. This spec is your contract. The recommended pipeline generates TypeScript types from it automatically:

```bash
python scripts/generate_openapi_schema.py
npx openapi-typescript openapi.json -o src/types/api.d.ts
```

In CI, check that the generated types match what's committed — if Claude changes a Pydantic model without updating the frontend types, the build breaks. For runtime validation, use **Zod schemas** on the frontend that mirror the Pydantic models. For automated API contract fuzzing, **Schemathesis** generates test cases from your OpenAPI spec and validates every response matches the schema. This single tool would catch many of your detail-panel consistency bugs.

## Recommended architecture separates testable logic from rendering

The architecture pattern that most reduces AI-agent regressions is strict separation of pure business logic from UI code:

```
frontend/src/
  utils/geo/          # Pure functions: pointInPolygon, clusterPoints, simplifyPolygon
  utils/filters/      # Pure functions: applyFilters, filterPredicates
  utils/normalization/ # Pure functions: normalizeBairro
  hooks/              # Thin React wrappers that call pure functions
  components/         # UI only — delegates all logic to hooks/utils
```

All files in `utils/` must have zero React imports and zero side effects. This makes them trivially testable with Vitest in milliseconds. Your CLAUDE.md should enforce module boundaries: "Utils must NOT import from components or hooks." This constraint prevents Claude from accidentally coupling geo logic to rendering code, which is exactly how cascading regressions propagate.

On the backend, use the same principle: thin API routes that call service functions, with all business logic in `services/`. Services can be tested with pytest without HTTP overhead.

## Conclusion

The regression spiral isn't a fundamental limitation of AI coding agents — it's a tooling and workflow problem with concrete solutions. **Install the Playwright MCP for browser verification**, but recognize that the MCP alone won't prevent regressions. The highest-impact changes are structural: block-at-commit hooks that make it physically impossible to commit failing code, a CLAUDE.md with explicit module dependency maps and anti-regression rules, and a test architecture that matches each regression-prone area to its most effective testing technique. Property-based testing with Hypothesis and fast-check will catch the geo edge cases that hand-written tests miss. OpenAPI contract testing will prevent frontend-backend drift. And golden file tests will pin the exact behavior of your normalization and clustering logic so any unintended change is immediately visible. Start with the hooks and CLAUDE.md — they require the least code and produce the most immediate improvement.
