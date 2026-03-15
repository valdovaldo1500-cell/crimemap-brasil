# Crime Brasil — Bug Report & Risk Registry

Updated: 2026-03-15
Coverage: All bugs fixed (2026-03-12 through 2026-03-15) + risks identified.

---

## Section 0: Bugs Fixed (2026-03-15) — Cross-table filtering, compare, share URL

### Bug #4: Duplicate tipo display names — AMEACA vs ameaca (fixed 2026-03-15)
**Commit:** 4d8147e
**Symptom:** Filter sidebar showed duplicate entries for 5 crime types (AMEACA/ameaca, ESTUPRO/estupro, ESTELIONATO/estelionato, FEMINICIDIO/feminicidio, SEQUESTRO RELAMPAGO/sequestro_relampago). Selecting one variant didn't match the other table's data.
**Root cause:** RS `crimes` table stores tipos as uppercase ("AMEACA"), RJ `crimes_staging` stores as lowercase ("ameaca"). The `filter-options` dedup compared raw strings (`row.crime_type not in existing_values`) — case-sensitive, so both passed.
**Fix:** (1) Normalized dedup in `filter-options` — compares `normalize_name(tipo.replace("_"," "))` before merging, sums counts for duplicates. (2) Added `_staging_tipo_filter()` helper for case-insensitive tipo matching across all 7 staging query locations.
**Regression tests:** `TestCrossTableTipoFiltering` (5 tests), E2E `filter-options has no duplicate tipo display names`

### Bug #5: Share URL is just `https://crimebrasil.com.br/` (fixed 2026-03-15)
**Commit:** 4d8147e
**Symptom:** Sharing a link like `/cidade/rj/cabo-frio` stayed on the static SEO page — never redirected to the map or opened the detail panel.
**Root cause:** `MapRedirect.tsx` only redirected when filter params (`per`, `view`, `tipos`, etc.) were in the URL. Bare share URLs with no filter params were blocked by `if (!hasMapParams) return;`.
**Fix:** Removed the `hasMapParams` gate — MapRedirect now always redirects SEO URLs to the map view with the correct `?panel=&state=&municipio=` params.
**Regression test:** E2E `share URL includes location path when detail panel opens`

### Bug #6: Compare pane opens behind detail panel (fixed 2026-03-15)
**Commit:** 4d8147e
**Symptom:** New compare panes appeared behind existing detail panels, invisible to the user.
**Root cause:** Compare panes used `zIndex: 1002 + groupIdx`, detail panels used `zIndex: 2000 + stackIndex`. Compare was always lower.
**Fix:** Changed compare pane z-index base from 1002 to 3000.
**Regression test:** E2E `compare pane z-index higher than detail panel z-index`

### Bug #7: Compare panes disappear when exiting compare mode (fixed 2026-03-15)
**Commit:** 4d8147e
**Symptom:** Toggling compare mode off destroyed all completed comparison panes. Users lost their comparison work.
**Root cause:** Toggle handler called `clearComparison()` which sets `setCompareGroups([])`. Should only clear the in-progress building state.
**Fix:** Changed toggle handler to call `resetBuilding()` instead of `clearComparison()`. Completed compare groups persist until user clicks ✕.

### Bug #8: RJ duplicate municipality dots — Barra do Piraí / Barra do Pirai (fixed 2026-03-15)
**Commit:** 152a42d (earlier in same session)
**Symptom:** Two dots for the same RJ city due to accent variants in staging data.
**Root cause:** Staging results within the same state weren't deduplicated by normalized name. Only cross-table dedup (staging vs crimes) existed.
**Fix:** Added intra-staging dedup by `normalize_name(municipio)` with weight merging in `heatmap_municipios`.
**Regression test:** `TestCrossTableAccuracy::test_no_duplicate_municipality_dots_rj`

---

## Section 1: Bugs Fixed (2026-03-12 through 2026-03-14)

### Bug #1: Duplicate BairroComponent entries (fixed 2026-03-14)
**Commit:** a2f9470
**Symptom:** DetailPanel showed duplicate rows for the same bairro (e.g. "Santa Tereza" appearing twice — once with ~1446 records, once with ~5). Users saw inflated row count but understated total for the smaller shard.
**Root cause:** Both cluster-merge and containment-merge passes could independently append a `BairroComponent` for the same display name, if two internal keys both resolved to the same canonical name.
**Fix:** Added dedup-by-name + weight-sum pass after both merge passes. If two components share a display name, their weights are summed into a single entry.
**Verification:**
```bash
curl -s "https://crimebrasil.com.br/api/heatmap/bairros?municipio=PORTO+ALEGRE&selected_states=RS&ultimos_meses=12" \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
for p in data:
    names = [c['name'] for c in p.get('components', [])]
    if len(names) != len(set(names)):
        print('DUPLICATE:', p['bairro'], names)
print('Checked', len(data), 'points — done')
"
```

---

### Bug #2: Heatmap weight ≠ location-stats total for containment-merged bairros (fixed 2026-03-14)
**Commit:** 0b6d48f
**Symptom:** Clicking a bairro in the DetailPanel showed a different total than what the heatmap dot implied. Specifically for bairros absorbed via polygon-containment merge.
**Root cause:** When bairro B was merged into bairro A via containment (B's polygon centroid is inside A's polygon), bairro B's raw DB name wasn't added to `extra_bairros` for location-stats queries. So location-stats only counted crimes from A, missing B's crimes.
**Fix:** Added `raw_bairro_names` field to `HeatmapPoint`. When a bairro is absorbed via containment merge, its raw DB name is appended to the absorbing point's `raw_bairro_names`.
**Verification:**
```bash
# Get a merged bairro point
curl -s "https://crimebrasil.com.br/api/heatmap/bairros?municipio=PORTO+ALEGRE&selected_states=RS&ultimos_meses=12" \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
for p in data[:5]:
    if p.get('raw_bairro_names'):
        print(p['bairro'], '->', p['raw_bairro_names'], '| weight:', p['weight'])
"
```

---

### Bug #3: Fuzzy/PIP-remapped bairro names not tracked in raw_bairro_names (fixed 2026-03-14)
**Commit:** 454a50a
**Symptom:** After fuzzy name matching or point-in-polygon reassignment, the original DB bairro names were lost. Location-stats queries using the canonical display name couldn't find the corresponding crimes in the DB.
**Root cause:** `raw_bairro_names` was only populated from direct matches, not from fuzzy/PIP-remapped entries.
**Fix:** Extended `raw_bairro_names` tracking to all code paths: fuzzy match merge loop, PIP reassignment pass, and polygon_matched_keys detection.
**Verification:**
```bash
# For POA: heatmap weight sum should ≈ location-stats total
python3 -c "
import urllib.request, json

def fetch(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)

BASE = 'https://crimebrasil.com.br'
heat = fetch(f'{BASE}/api/heatmap/bairros?municipio=PORTO+ALEGRE&selected_states=RS&ultimos_meses=12')
stats = fetch(f'{BASE}/api/location-stats?municipio=PORTO+ALEGRE&state=RS&ultimos_meses=12')
print(f'Heatmap sum: {sum(p[\"weight\"] for p in heat)}')
print(f'Stats total: {stats[\"total\"]}')
"
```

---

## Section 2: Risks Identified (Unverified — May Be Bugs)

### Risk #1: Staging total double-counts occurrences + victims for same event
**Location:** `main.py` → `state-stats`, `location-stats` staging fallback
**Severity:** High
**Description:** SINESP VDE data includes both `ocorrencias` and `vitimas` columns. If both are summed into `occurrences`, each incident is counted twice (once as occurrence, once as victim). RJ and MG were specifically fixed for this, but the fix may not cover all SINESP sources.
**Verification:**
```bash
# RJ: compare API total vs raw CSV sum (occurrencias column only)
curl -s "https://crimebrasil.com.br/api/state-stats?state=RJ&ultimos_meses=12" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('API total:', d['total'])"
```

---

### Risk #2: `ultimos_meses` hardcoded to 12 in initial `filter-options` fetch
**Location:** `frontend/src/app/page.tsx` line ~299
**Severity:** High
**Description:** The initial `filter-options` fetch (on page load before user changes the period filter) may hardcode `ultimos_meses=12` regardless of the URL parameter. If a user loads the page with `?ultimos_meses=3`, the sidebar may show crime types present in 12m but absent in 3m.
**Verification:**
```bash
# Compare counts:
curl -s "https://crimebrasil.com.br/api/filter-options?selected_states=RS&ultimos_meses=3" | python3 -c "import json,sys; d=json.load(sys.stdin); print('3m tipos:', len(d.get('tipo', [])))"
curl -s "https://crimebrasil.com.br/api/filter-options?selected_states=RS&ultimos_meses=12" | python3 -c "import json,sys; d=json.load(sys.stdin); print('12m tipos:', len(d.get('tipo', [])))"
```

---

### Risk #3: Population null → division by zero in rate calculation
**Location:** `main.py` `location-stats` endpoint, `frontend/src/components/DetailPanel.tsx`
**Severity:** High
**Description:** If `population` is `null` or `0`, dividing `total / population * 100000` produces `Infinity` or `NaN`. The backend may guard against this, but the frontend rate display may not.
**Verification:**
```bash
# Test with a small bairro likely missing population data
curl -s "https://crimebrasil.com.br/api/location-stats?state=RS&municipio=PORTO+ALEGRE&bairro=IPANEMA" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('pop:', d.get('population'), 'rate:', d.get('rate'))"
```

---

### Risk #4: `normalize_text()` SQLite UDF missing on fresh deploy
**Location:** `main.py` UDF registration at startup
**Severity:** High
**Description:** `normalize_text()` is a Python UDF registered with SQLite at startup. If the registration fails silently or is skipped, queries using it will crash with `no such function: normalize_text`. This would cause location-stats to return 500 errors.
**Verification:**
```bash
curl -s "https://crimebrasil.com.br/api/location-stats?municipio=PORTO+ALEGRE&state=RS" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('status: ok, total:', d.get('total'))"
```

---

### Risk #5: Accent dedup failure — SAO LEOPOLDO / SÃO LEOPOLDO duplicate dots
**Location:** `main.py` → `heatmap_municipios` dedup logic
**Severity:** High
**Description:** `crimes` table stores municipality names without accents ("SAO LEOPOLDO"), while `crimes_staging` (SINESP source) preserves accents ("SÃO LEOPOLDO"). If dedup compares strings literally, both appear as separate dots on the map.
**Status:** Fix added 2026-03-10 (`normalize_name()` applied before dedup). Regression test in `test_contract.py::TestAccentNormalizedDedup`.
**Verification:**
```bash
curl -s "https://crimebrasil.com.br/api/heatmap/municipios?selected_states=RS&ultimos_meses=12" \
  | python3 -c "
import json, sys, unicodedata
data = json.load(sys.stdin)
def norm(s): return ''.join(c for c in unicodedata.normalize('NFD', s.upper()) if unicodedata.category(c) != 'Mn')
seen = {}
for p in data:
    m = p.get('municipio', '')
    n = norm(m)
    seen.setdefault(n, []).append(m)
dups = {k: v for k, v in seen.items() if len(v) > 1}
print('Duplicates:', dups or 'none')
"
```

---

### Risk #6: `.limit(10)` breakdown undercount — total derived from limited query
**Location:** `main.py` `location-stats` and `state-stats` staging fallback
**Severity:** High
**Description:** If `total` is computed as `sum(breakdown)` from a `.limit(10)` query, cities with >10 crime types will show a total lower than actual. Contract: `total >= sum(breakdown)` always.
**Status:** Fixed 2026-03-10. Regression tests in `test_contract.py::TestTotalGteBreakdownSum`.
**Verification:**
```bash
curl -s "https://crimebrasil.com.br/api/location-stats?municipio=RIO+DE+JANEIRO&state=RJ" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
total = d.get('total', 0)
breakdown_sum = sum(ct['count'] for ct in d.get('crime_types', []))
print(f'total={total}, breakdown_sum={breakdown_sum}, ok={total >= breakdown_sum}')
"
```

---

### Risk #7: PIP remapping silently reassigns bairros due to geocoding error
**Location:** `main.py` → `heatmap_bairros` PIP pass
**Severity:** Medium
**Description:** Point-in-polygon (PIP) reassignment uses lat/lng from `geocode_cache`. If a bairro is geocoded to the wrong location (e.g. geocoder returns city centroid instead of bairro centroid), PIP may silently reassign it to a neighboring bairro.
**Verification:**
```bash
# Check PANTANO bairros are NOT in POA
curl -s "https://crimebrasil.com.br/api/heatmap/bairros?municipio=PORTO+ALEGRE&selected_states=RS&ultimos_meses=12" \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
bad = [p['bairro'] for p in data if 'PANTANO' in p.get('bairro', '').upper()]
print('PANTANO in POA:', bad or 'none (good)')
"
```

---

### Risk #8: MG single-state filter shows wrong types
**Location:** `backend/services/crime_categories.py` → `get_compatible_types()`
**Severity:** Medium
**Description:** `get_compatible_types()` restricts types to the intersection when 2+ states are selected AND at least one is non-full. For single-state MG, it should return all MG-native types. If the condition incorrectly triggers for single-state MG, users see fewer types than expected.
**Verification:**
```bash
# MG alone should show 5+ types including homicídio
curl -s "https://crimebrasil.com.br/api/filter-options?selected_states=MG" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); tipos = d.get('tipo', []); print(len(tipos), 'types:', [t if isinstance(t, str) else t.get('value') for t in tipos[:10]])"
```

---

### Risk #9: Year/month filter boundary asymmetry
**Location:** `main.py` — `crimes` table uses `BETWEEN '{ano}-01' AND '{ano}-12'`, staging uses compound OR
**Severity:** Medium
**Description:** Year filter is implemented differently for the two tables. If there's an off-by-one in the month boundary (e.g. December not included), RS and RJ/MG results will diverge for year-based queries.
**Verification:**
```bash
# Compare year vs ultimos_meses for RS
curl -s "https://crimebrasil.com.br/api/state-stats?state=RS&ano=2024" \
  | python3 -c "import json,sys; print('2024 total:', json.load(sys.stdin)['total'])"
```

---

### Risk #10: BAIRRO_POLYGON_INDEX empty on Coolify (volume mount)
**Location:** `main.py` startup — `BAIRRO_POLYGON_INDEX` loaded from `backend/bairro-geo/rs-bairros.geojson`
**Severity:** Medium
**Description:** On Coolify, docker-compose volume mounts may not preserve GeoJSON files. If `BAIRRO_POLYGON_INDEX` loads 0 polygons, all polygon matching silently fails — every bairro falls back to geocache centroid, increasing "Bairro desconhecido" rate and misclassifications.
**Status:** Fixed by baking files into `backend/bairro-geo/` (not volume-mounted). Monitor startup logs.
**Verification:**
```bash
# Check polygon count via geocoding-status endpoint
curl -s "https://crimebrasil.com.br/api/admin/geocoding-status" \
  | python3 -m json.tool | grep -i polygon

# Or: count named bairros in POA (should be 20+)
curl -s "https://crimebrasil.com.br/api/heatmap/bairros?municipio=PORTO+ALEGRE&selected_states=RS&ultimos_meses=12" \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
named = [p for p in data if p.get('bairro') and p['bairro'] not in ('Bairro desconhecido', '-')]
print(f'{len(named)}/{len(data)} named bairros (should be 20+)')
"
```

---

## Section 3: Test Coverage Summary

| Test Suite | Location | What it covers |
|------------|----------|----------------|
| `test_accuracy_comprehensive.py` | `backend/tests/` | API-level regressions for all 3 recent bugs + 10 identified risks |
| `accuracy.spec.ts` | `frontend/e2e/` | End-to-end validation of same behaviors via HTTP |
| `test_contract.py` | `backend/tests/` | Heatmap/location-stats parity, accent dedup, total≥breakdown |
| `bug-fixes.spec.ts` | `frontend/e2e/` | UI behavior regressions for 14 fixed bugs |
| `qa_full_accuracy.py` | project root | Source-file-vs-API accuracy (RS ZIPs, RJ CSV, MG CSV) |

### Run all tests
```bash
# Backend (in-process, local DB)
cd /home/valdo/crime-map/backend
python -m pytest tests/test_accuracy_comprehensive.py tests/test_contract.py -v --tb=short

# Frontend E2E (requires local server on :3001 and :8000)
export PATH="/home/valdo/.local/node-v20.11.1-linux-x64/bin:$PATH"
cd /home/valdo/crime-map/frontend
npx playwright test e2e/accuracy.spec.ts --reporter=line
```
