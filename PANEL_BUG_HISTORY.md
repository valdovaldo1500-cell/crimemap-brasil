# DetailPanel Bug History

A verbose record of every panel bug reported, all fix attempts, what was tested, and what was found.

---

## Background: What is DetailPanel?

`DetailPanel.tsx` is a draggable, resizable floating panel that replaced Leaflet popups for showing crime statistics. It was introduced around 2026-03-06 as part of the multi-state feature. It supports:
- Multiple panels open simultaneously (stacked)
- Drag-to-reposition
- Resize from bottom-right corner
- Loading skeleton state
- Crime type breakdown list

The panel interacts with `page.tsx` via the `onDetailOpen` callback and a `detailPanels` state array.

---

## Bug Report #1: Panels disappear when dragging (first report)

**Date reported**: 2026-03-12 (session 1 of context)

**User description**: "With multiple panels open, dragging a panel causes panels to disappear."

### Root Cause Analysis

The `onDetailOpen` callback in `page.tsx` was wrapped in `useCallback`. When a state was clicked, it called `onDetailOpen` twice with the same display name: once with `loading: true` (to show skeleton immediately), then again with the real data.

The matching logic used `data.displayName` as the panel ID to decide "update existing" vs "create new". On the first click, it created a new panel. On the second click (with real data), it found the panel by displayName and updated it in-place. **This worked correctly.**

However, when multiple panels were open and the user dragged one, the drag caused a re-render. The `onDetailOpen` callback was being recreated on each render because its `useCallback` dependencies included `detailPanels` (to do the stale-closure check). Recreating the callback caused the Leaflet event listeners (bound once in a `useEffect`) to still hold references to the **old** callback — stale closure problem.

Additionally, the actual disappearance was caused by a different issue: `onDetailOpen` was closing over `detailPanels` state. When the second call (with real data) ran:
```javascript
const existingIdx = prev.findIndex(p => p.id === panelId);
if (existingIdx >= 0) { return prev.map(...); }
else { return [...prev, newPanel]; }  // ← used stale `prev`
```
The async fetch callback captured the `prev` from *before* the first click updated state, so `setDetailPanels(prev => [...prev, newPanel])` would replace all panels with just the new one.

### Fix Applied: `actionId` two-phase pattern

**Commit**: `b362d75` (2026-03-12 20:08) — "Open new panel on repeated state clicks instead of replacing existing"

Each click generates a unique `actionId = Date.now() + Math.random()`. Both calls (loading + data) share the same `actionId`. The `onDetailOpen` callback matches on `actionId` (not displayName) to find the panel to update.

```javascript
// CrimeMap.tsx click handler:
const actionId = `${Date.now()}-${Math.random()}`;
onDetailOpenRef.current({ actionId, displayName, loading: true });
// ... fetch ...
onDetailOpenRef.current({ actionId, displayName, loading: false, total: ... });
```

The callback now uses a `onDetailOpenRef` (ref, not function prop) so Leaflet handlers always call the latest version without re-binding.

**Commit**: `a3da891` — "Fix panel disappearing on drag by adding actionId to all call sites" — added `actionId` to the previously missed unselected-state click handler.

**Commit**: `395348a` — "Fix TypeScript type error: add actionId to onDetailOpen callback type" — the `actionId` field was added to call sites but not to the TypeScript interface, causing `npm run build` to fail silently on Coolify for 14+ hours. The deployed container was stuck at commit `f81a668` until this was caught.

### Verification

Playwright test: opened two panels, dragged one, confirmed both remained open. Console logs confirmed `panelsBefore: 2, panelsAfter: 2, bug2Fixed: true`.

---

## Bug Report #2: Clicking RS again replaces panel instead of opening new one (first report)

**Date reported**: 2026-03-12 (same session as Bug #1)

**User description**: "Clicking RS again after changing to 'ano' > 2025 replaces the last 12 months panel."

### Root Cause Analysis

The `onDetailOpen` callback matched panels by `displayName`. "Rio Grande do Sul (RS)" is always the same displayName regardless of which year you're viewing. So clicking RS in "2025" mode found the existing "últimos 12 meses" panel (which also had displayName "Rio Grande do Sul (RS)") and updated it in-place instead of creating a new one.

### Fix Applied

The `actionId` pattern fixed this too. Since each click generates a new `actionId`, and the matching now uses `actionId` (not `displayName`), clicking RS a second time generates a fresh `actionId` that matches no existing panel → a new panel is created.

**Commit**: `b362d75` — same commit as Bug #1 fix.

### Verification

Playwright test: opened panel in "últimos 12 meses" mode, switched to year 2026 (via year filter), clicked RS again, confirmed two panels opened. Console logs: `prev.length=1 existingIdx=-1` → new panel added.

---

## Bug Report #3: Re-fetch useEffect runs on period changes (related to Bug #2)

**Date noticed**: 2026-03-12 (discovered during Bug #2 debugging)

When the user changes the year filter, `periodLabel` changes (e.g., from "últimos 12 meses" to "2024"). A `useEffect` in `page.tsx` watches `[filters, periodLabel]` and re-fetches all open panels to keep them up-to-date with the current filter context.

**This re-fetch is intentional** — if the user has a panel open for Porto Alegre and changes the crime type filter, the panel should update. But it caused an unintended side effect: panels opened in a different time period (e.g., "últimos 12 meses") also got updated, changing both their data AND their `periodLabel` to the new period.

The initial fix in `efbad65` added period-dedup logic to prevent creating new panels for the same period when the re-fetch ran. But that was insufficient — the panel itself was still being updated even when the user intended it as a historical snapshot.

### Fix Applied (this session, 2026-03-13)

In the re-fetch `forEach`, added an early return for panels whose `periodLabel` doesn't match the current `periodLabel`:

```javascript
panels.forEach(async (panel) => {
  // Skip panels that were opened for a different time period — they are "snapshots"
  if (panel.periodLabel && panel.periodLabel !== periodLabel) return;
  // ... rest of re-fetch logic
});
```

This means: panels opened in "últimos 12 meses" are frozen in that context. Switching to year 2024 opens a new panel; the "últimos 12 meses" panel remains unchanged.

**Commit**: (pending this session)

---

## Bug Report #4: X button on panels does not close them

**Date reported**: 2026-03-12 (end of session, discovered during comprehensive site testing)

**User description**: "clicking on the x in the panels do not close them"

### Root Cause Analysis

The drag handle div has an `onMouseDown` handler `onDragStart` that calls `e.preventDefault()`:

```tsx
const onDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
  e.preventDefault();  // ← THE CULPRIT
  const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
  // ...
  setDragging(true);
}, [pos]);
```

The HTML event sequence for a click is: `mousedown` → `mouseup` → `click`. Calling `preventDefault()` on `mousedown` suppresses the synthetic `click` event that browsers fire afterward — this is a well-known browser behavior.

The close button (X) is a child of the drag handle div:
```tsx
<div onMouseDown={onDragStart}>    {/* drag handle — calls e.preventDefault() */}
  <span>Title</span>
  <button onClick={onClose}>✕</button>   {/* ← click NEVER fires */}
</div>
```

When the user clicks the X button:
1. `mousedown` fires on the button
2. Event bubbles up to the drag handle div
3. `onDragStart` fires → calls `e.preventDefault()`
4. `mouseup` fires (no problem)
5. `click` is **suppressed** by the earlier `preventDefault()`
6. `onClick={onClose}` never fires

The `e.preventDefault()` in `onDragStart` is necessary to prevent text selection during dragging. The fix must not remove it.

### Fix Applied

Added `onMouseDown={e => e.stopPropagation()}` to the close button. This stops the `mousedown` event from reaching the drag handle div entirely, so `onDragStart` never runs for button clicks, so `preventDefault()` is never called, so the `click` event fires normally.

```tsx
<button
  onClick={onClose}
  onMouseDown={e => e.stopPropagation()}   {/* ← NEW */}
  className="..."
  aria-label="Fechar painel"
>
```

**Commit**: (pending this session)

### Why `stopPropagation` and not removing `preventDefault`?

`e.preventDefault()` on `mousedown` is what prevents text selection while dragging (without it, text on the page gets highlighted while the user drags the panel). Removing it would break dragging UX. `stopPropagation` on the button keeps the drag handle from even seeing the `mousedown` when the user clicks the X.

---

## Bug Report #5: Year-change updates existing panel instead of opening new one (second report of same class)

**Date reported**: 2026-03-13 (new session after context compaction)

**User description**: "in last 12 months, click on RS then click on 2024, panel changes to 2024 data instead of opening a new one."

This is related to Bug #2 but a different mechanism. The `actionId` fix (Bug #2 fix) correctly creates a NEW panel when RS is clicked a second time. But then the re-fetch `useEffect` (Bug #3) runs on the `periodLabel` change and updates the original "últimos 12 meses" panel in-place:

```javascript
useEffect(() => {
  // fires when filters or periodLabel changes
  panels.forEach(async (panel) => {
    // Updates ALL open panels, including ones from other time periods
    if (panel.state && !panel.municipio) {
      const stats = await fetchStateStats({ ...filters });
      setDetailPanels(prev => prev.map(p =>
        p.id === panel.id ? { ...p, total: stats.total, periodLabel } : p
        //                                               ^^^^^^^^^^^ overwrites old period
      ));
    }
  });
}, [filters, periodLabel]);
```

So the sequence was:
1. "últimos 12 meses" → click RS → Panel A opens with `periodLabel: "últimos 12 meses"`
2. Change year to 2024 → `periodLabel` changes to `"2024"`
3. Re-fetch useEffect fires → finds Panel A → updates it with new data + `periodLabel: "2024"`
4. Panel A now shows 2024 data — it looks like it was replaced

The fix (added in this session) skips panels whose stored `periodLabel` doesn't match the current `periodLabel`, treating them as snapshots.

---

## Tangential Issues Found During Panel Debugging

### TypeScript build failure blocking deploy (2026-03-12)

When `actionId` was added to CrimeMap.tsx call sites, it was not added to the TypeScript interface for the `onDetailOpen` prop type in CrimeMap.tsx line 19. `npm run build` failed with:
```
Type error: Object literal may only specify known properties,
and 'actionId' does not exist in type '{ displayName: string; municipio: string; ... }'
```

Coolify's build failed silently. The running container was still on commit `f81a668` (pre-fix). The build error was not surfaced clearly — Coolify showed "deployed" but the container hadn't changed. This went unnoticed for ~14 hours.

**Fix**: Added `actionId?: string` to the type definition. Commit `395348a`.

**Lesson**: Always check running container hash after pushing, not just deployment status.

### Mobile legend overlap (2026-03-13)

During comprehensive site testing, found that "Baixo" and "Médio" legend items were hidden behind the "Comparar" button at 375px (iPhone SE viewport). The Comparar button was at `top-[60px]` which placed it at ~119px from viewport top (59px header + 60px offset), colliding with the top legend items.

**Fix**: Changed `top-[60px]` to `top-[80px]` on mobile only (`md:top-[116px]` unchanged). Commit `471150a`.

### Debug logging left in production (2026-03-12)

Commit `e529b22` added verbose `console.log` statements to `onDetailOpen` for Playwright debugging. These should be cleaned up eventually (not critical, not user-visible, but noisy in browser devtools).

---

## Summary of All Panel-Related Commits

| Commit | Date | Description |
|--------|------|-------------|
| `ba82fcd` | ~2026-03-06 | First DetailPanel.tsx (replaces Leaflet popups) |
| `73a9eae` | 2026-03-06 | Add loading skeleton to DetailPanel |
| `d84bff4` | 2026-03-06 | Show DetailPanel with stats when clicking a state |
| `0d5929f` | ~2026-03-07 | Multi-panel stacking, icon buttons |
| `8b312c2` | ~2026-03-07 | FAIL-4: DetailPanel re-fetches when filters change |
| `2df831b` | ~2026-03-08 | DetailPanel improvements |
| `2e18192` | 2026-03-11 | DetailPanel respects rate mode toggle |
| `856663b` | 2026-03-11 | Shift panel left to clear zoom buttons |
| `efbad65` | 2026-03-12 | BUG-11 + BUG-9 + panel period-dedup |
| `b362d75` | 2026-03-12 | Open new panel on repeated state clicks (actionId) |
| `a3da891` | 2026-03-12 | Fix panel disappearing on drag (actionId all sites) |
| `e529b22` | 2026-03-12 | Add debug logging to onDetailOpen |
| `395348a` | 2026-03-12 | Fix TypeScript type: add actionId to interface |
| `471150a` | 2026-03-13 | Fix mobile legend overlap (Comparar button) |
| *(current)* | 2026-03-13 | Fix X button (stopPropagation) + year snapshot fix |
