# Crime Brasil — Stack Summary & Bug Timeline

**Date**: March 10, 2026
**URL**: https://crimebrasil.com.br
**Repo**: `/home/valdo/crime-map`

---

## What the Website Is For

Crime Brasil is an interactive crime statistics map for Brazil. It aggregates public safety data from multiple state security departments (SSP/RS, ISP/RJ, SEJUSP/MG) and the national SINESP database, displaying crime heatmaps at three zoom levels: states, municipalities, and neighborhoods (bairros). Users can filter by crime type, demographics (age, sex, race), time period, and compare locations side-by-side. RS, RJ, and MG have detailed data; other states have basic SINESP aggregate counts.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | FastAPI (Python 3.11), SQLAlchemy ORM, SQLite (WAL mode, ~2 GB) |
| Frontend | Next.js 14, Leaflet.js maps, Tailwind CSS |
| Deploy | Docker Compose → Coolify on Hetzner VPS (auto-deploys on `git push`) |
| Email | Resend API (bug report notifications) |
| Captcha | hCaptcha |
| Geocoding | Nominatim (via geopy) |
| Scheduler | APScheduler (2 weekly background jobs) |

---

## System Elements

### Backend Endpoints

#### Heatmap (3 zoom levels)
| Endpoint | What it does |
|----------|-------------|
| `GET /api/heatmap/states` | State-level crime aggregation (zoom < 7) |
| `GET /api/heatmap/municipios` | Municipality heatmap — merges `crimes` table (RS detail) + `crimes_staging` (all states) |
| `GET /api/heatmap/bairros` | Bairro-level detail (zoom ≥ 11, RS/RJ/MG only) — polygon matching + cluster merge |

#### Filters & Options
| Endpoint | What it does |
|----------|-------------|
| `GET /api/filter-options` | Cross-filtered tipo/grupo/sexo/cor/bairro dropdowns with counts |
| `GET /api/available-states` | States with quality metadata (full/partial/basic) |
| `GET /api/state-filter-info` | Compatible crime types + max granularity for selected states |
| `GET /api/search` | Autocomplete for municipio/bairro names |
| `GET /api/years` | Available years |
| `GET /api/semesters` | Available semesters |

#### Statistics & Detail
| Endpoint | What it does |
|----------|-------------|
| `GET /api/stats` | Summary: total crimes, top types, top municipios |
| `GET /api/location-stats` | Detailed breakdown for a specific municipio+bairro click |
| `GET /api/state-stats` | State-level breakdown by municipio/bairro/type |
| `GET /api/data-sources` | Source metadata (URLs, record counts, timestamps) |
| `GET /api/data-availability` | Per-state/year coverage info |

#### Admin
| Endpoint | What it does |
|----------|-------------|
| `POST /api/admin/ingest-rs-history` | Ingest all RS historical ZIPs (2022-2026, ~500 MB) |
| `POST /api/admin/refresh-staging` | Delete cached files + re-download all sources + reload |
| `POST /api/admin/load-staging` | Load staging from cached files (no re-download) |
| `POST /api/admin/check-updates` | Trigger SSP data check manually |
| `POST /api/admin/geocode-bairros` | Batch geocode unmapped bairros |
| `POST /api/admin/validate-geocache` | Remove geocodes > 50km from municipality |
| `GET /api/admin/staging-stats` | Row counts by state/source |

#### User Features
| Endpoint | What it does |
|----------|-------------|
| `POST /api/bug-reports` | Submit bug report with hCaptcha verification |
| `GET /api/admin/bug-reports` | List all reports |

### Backend Services (`backend/services/`)

| File | What it does |
|------|-------------|
| `data_ingestion.py` | RS-specific: download SSP ZIPs → extract CSV → parse → insert into `crimes` table with geocoding |
| `staging_loader.py` | Multi-source ETL: download from 5 sources (SINESP UF/Municipal/VDE, RJ ISP, MG) → parse XLSX/CSV → insert into `crimes_staging` |
| `scheduler.py` | APScheduler: `auto_ingest_job` (RS/SP SSP check, 7-day interval) + `staging_refresh_job` (all sources, 7-day interval offset 3 days) |
| `crime_categories.py` | Cross-state category mapping. `STATE_QUALITY` dict, `get_compatible_types()` for multi-state filtering, `PARTIAL_STATES = {"MG"}` |
| `geocoder.py` | Nominatim wrapper with rate limiting, bairro batch geocoding, 50km distance validation |
| `population.py` | Static population lookup from `backend/lookup/population.json`. Per-100K rate calculations |
| `update_checker.py` | Scrapes SSP/RS website for new ZIP file URLs |

### Backend Key Functions (`backend/main.py`)

| Function | What it does |
|----------|-------------|
| `normalize_name()` | NFD accent strip + uppercase — used everywhere for matching |
| `_normalize_bairro_for_matching()` | Strips "BAIRRO" prefix, expands abbreviations (M VELHO→MATHIAS VELHO), prefix-matches truncated names |
| `_phonetic_br()` | Z↔S phonetic normalization for Brazilian spelling variants |
| `_is_street_or_place()` | Detects street names in bairro field, remaps via PIP |
| `_load_bairro_polygons()` | Reads GeoJSON → builds `BAIRRO_POLYGON_INDEX` by municipality |
| `_point_in_polygon()` | Ray-casting PIP test |
| `_find_containing_polygon()` | Matches crime lat/lng to bairro polygon |
| `apply_filters()` | Builds SQLAlchemy query with all filter params |
| `semester_months()` | S1=[1-6], S2=[7-12] period mapping |

### Frontend Components

| File | What it does |
|------|-------------|
| `frontend/src/app/page.tsx` | Main page: state selection, filters (tipo/grupo/sexo/cor/age), year/period picker, modals, detail panels, comparison mode |
| `frontend/src/components/CrimeMap.tsx` | Leaflet map: 3 zoom levels (states/municipios/bairros), choropleth/dot modes, quantile color mapping, click→DetailPanel |
| `frontend/src/components/DetailPanel.tsx` | Draggable side panel: crime type breakdown, population stats, loading skeleton, multi-panel stacking |
| `frontend/src/lib/api.ts` | API client: fetch functions for all endpoints, AbortController for autocomplete |

### Scripts (`backend/scripts/`)

| File | What it does |
|------|-------------|
| `fetch_bairro_boundaries.py` | Fetches bairro polygons from OSM Overpass API in 4 phases: (1) admin_level=10 relations, (2) geometry batches, (3) place=suburb/neighbourhood ways+relations, (4) node-only points → approximate circles. Supplements with IBGE 2010 data. Outputs GeoJSON to frontend + backend. |

### Database Tables

| Table | What it stores |
|-------|---------------|
| `crimes` | RS individual records: demographics (age, sex, race), location (municipio, bairro, lat/lng), crime type, date |
| `crimes_staging` | Multi-state aggregated counts: state, municipio, crime_type, year, month, occurrences, victims |
| `geocode_cache` | Cached Nominatim results: municipio+bairro → lat/lng |
| `data_sources` | Ingested file tracking: filename, URL, record count, status |
| `bug_reports` | User-submitted bug reports |

### GeoJSON Files

| File | What it contains |
|------|-----------------|
| `frontend/public/geo/br-states.geojson` | 27 state boundaries |
| `frontend/public/geo/{rs,rj,mg}-municipios.geojson` | Municipality boundaries per state |
| `frontend/public/geo/{rs,rj,mg}-bairros.geojson` | Bairro boundaries (also copied to `backend/bairro-geo/` for Docker) |

### Data Sources

| Source | States | Quality | Notes |
|--------|--------|---------|-------|
| SSP/RS | RS | full | Individual records with demographics, bairro-level |
| ISP/RJ | RJ | full | Municipality CSV, detailed crime columns |
| SEJUSP/MG | MG | partial | Violent crimes only |
| SINESP VDE | All 27 | basic | Annual XLSX per year (2015-current) |
| SINESP Municipal | All 27 | basic | Municipality-level victim counts |
| SINESP UF | All 27 | basic | State-level with ocorrências + vítimas sheets |

---

## Data Pipeline

```
Source websites (SSP/RS ZIPs, ISP/RJ CSVs, MG CSVs, SINESP XLSXs)
    │
    ├── RS path: data_ingestion.py → download ZIP → extract CSV
    │   → parse individual records (demographics, location, type)
    │   → geocode bairros (Nominatim + cache)
    │   → INSERT into `crimes` table
    │
    └── Multi-state path: staging_loader.py → download all sources
        → parse XLSX/CSV (handle encoding, separators, date formats)
        → normalize municipio names, map crime types
        → dedup (RJ: prefer ISP over SINESP VDE)
        → INSERT into `crimes_staging` table

    ↓

Backend API (main.py)
    → Loads BAIRRO_POLYGON_INDEX from GeoJSON at startup
    → Queries both tables based on selected states
    → Bairro heatmap: name matching + PIP + cluster merge
    → Municipio heatmap: merge RS detail + staging aggregates
    → Filter cascading: compatible types for multi-state selection

    ↓

Frontend (Next.js + Leaflet)
    → Fetches heatmap data based on zoom level
    → Renders choropleth/dots on Leaflet map
    → DetailPanel for click-through statistics
    → Filter UI updates via cascading API calls
```

---

## How Debugging Works

### Investigation Flow
1. **Reproduce**: Check the live API endpoint directly (`curl https://crimebrasil.com.br/api/...`) to confirm the bug exists in production
2. **Isolate**: Query the SQLite database to check if the data is correct at the DB level, or if the bug is in the API/frontend
3. **Trace**: For bairro matching issues, run the matching logic locally with debug prints to see which normalization step fails
4. **Fix**: Edit code, test locally with `python3 -c "..."` one-liners or curl commands
5. **Deploy**: `git push origin main` → Coolify auto-deploys in ~2-3 min
6. **Verify**: `curl` the production API to confirm the fix, check specific data points

### Common Debug Patterns
- **Bairro matching**: Compare `name_normalized` from crime records vs `name_normalized` in GeoJSON features — mismatches indicate normalization gaps
- **Count mismatches**: Check if both `crimes` and `crimes_staging` tables are being queried, and if dedup is working
- **Deploy issues**: `ssh root@188.34.199.27 "docker ps | grep backend"` to check container status
- **GeoJSON issues**: Parse the geojson locally with `python3 -c "import json; ..."` to check feature properties
- **Filter issues**: Hit `/api/filter-options` with specific params and inspect the response vs what the frontend sends

### Key Gotchas
- `BAIRRO_POLYGON_INDEX` loaded at startup — if GeoJSON is empty/missing, all bairro matching silently fails
- Coolify volume mount: `frontend/public/geo/` files are NOT preserved after build → bairro GeoJSON baked into `backend/bairro-geo/`
- Cluster merge (0.3km threshold) can absorb polygon-matched bairros into "Bairro desconhecido" if not guarded
- MG is a partial state — triggers auto-filter when combined with other states

---

## Bug & Patch Timeline (March 9-10, 2026)

Legend:
- **BUG**: Bug fix
- **FEAT**: New feature
- **ENH**: Enhancement to existing feature
- **RE-FIX**: Fix for something previously thought fixed (user had to re-report)
- **DEPLOY-FIX**: Fix caused by deployment/infrastructure issue

### March 9, 2026

| Time (UTC) | Commit | Type | Description |
|------------|--------|------|-------------|
| 08:38 | `5978255` | FEAT | Show established bairros (≥50 records) as dot markers instead of bucketing into "Bairro desconhecido" |
| 09:03 | `3eed70d` | BUG | Fix bairro polygons (16 bairros had empty `municipio` field → skipped by `_load_bairro_polygons()`) + map viewport height |
| 09:08 | `abfa82a` | BUG | Regenerate `bairro_centroids.json` with the 16 newly-fixed bairros |
| 09:52 | `af2d2f4` | BUG | Fix popup+panel double display when DetailPanel is active |
| 09:57 | `f11e46a` | DEPLOY-FIX | Include static JSON data files (population, centroids) in git — they were missing after deploy |
| 09:58 | `d7af1de` | DEPLOY-FIX | Fix `.gitignore` pattern that was excluding the static data JSON files |
| 10:04 | `b871f74` | DEPLOY-FIX | Move static lookup files to `backend/lookup/` (not volume-mounted) — volume mount was overwriting them on Coolify |
| 10:31 | `b37e339` | BUG | Remove domain text from toolbar + fix iPad Pro map viewport (`100vh` → `100dvh` for iOS Safari) |
| 10:41 | `b5133d8` | FEAT | Add "Designed by I.L.S." credit link + reorder view toggle buttons |
| 10:58 | `d84bff4` | FEAT | Show DetailPanel with stats when clicking a state (previously only municipio/bairro clicks opened it) |
| 14:14 | `73a9eae` | BUG | Add loading skeleton to DetailPanel while API data loads — **user reported** panel showed "0 ocorrências" for ~4 seconds before real data appeared |
| 15:28 | `0d5929f` | FEAT+BUG | Multi-panel stacking (panels stay open, offset on stack), icon buttons, filter-options data integrity fix |
| 15:28 | `c9eadb5` | cleanup | Remove test-results artifacts, add to `.gitignore` |
| 16:17 | `abad3ee` | FEAT | Replace math captcha with hCaptcha + add Resend email notifications for bug reports — **user reported** bug form wasn't actually sending emails |
| 17:05 | `5b499ee` | BUG | Fix crime types filter: don't over-filter when single state selected — `get_compatible_types()` was applying multi-state intersection logic even for single-state selection |
| 17:11 | `3f6582e` | BUG | Fix bairro display names: always update to polygon canonical name (not the crime record's potentially-truncated version) |
| 17:52 | `bed2c00` | BUG | Don't show loading skeleton for "Bairro desconhecido" detail panel (it loads instantly from local data, skeleton was misleading) |
| 18:32 | `043004f` | ENH | Improve bairro name matching: article stripping ("DO"/"DA"/"DOS"/"DAS"), phonetic normalization, fuzzy prefix matching — **user reported** Canoas bairros (Fátima, NOSSA SENHORA DAS GR, M VELHO) not matching |
| 19:04 | `e1c9f8e` | RE-FIX | Fix bairro matching bugs: BOM FIM/BONFIM ambiguity, D' expansion (D'AREIA→DE AREIA), suffix threshold, reverse prefix matching — continued Canoas bairro issues |
| 19:35 | `3558489` | RE-FIX | Fix bairro matching: JARDIM prefix strip, reverse suffix matching, more abbreviation expansions — still finding edge cases in Canoas/other cities |
| 19:40 | `1531fee` | ENH | Lower reverse-prefix minimum length 7→6 for bairro matching |
| 19:43 | `c178d55` | BUG | Fix phonetic matching order + JABOTICABAL abbreviation handling |
| 20:04 | `ef9f0c7` | ENH | General bairro matching improvements (no city-specific fixes — making rules generic) |
| 20:10 | `032c6bc` | ENH | Add article-stripped matching + lower prefix threshold to 6 |
| 20:21 | `bb8c4fb` | BUG | Fix D'-apostrophe polygon matching (e.g., PASSO D'AREIA) + guard logic improvements |
| 20:45 | `3629f32` | RE-FIX | **Critical**: Fix cluster-merge absorbing polygon-matched bairros into "Bairro desconhecido" — the 0.3km merge pass was incorrectly merging bairros that had already been matched to polygons. This was a known gotcha that resurfaced. |
| 20:55 | `7285d53` | ENH | Add D+vowel contraction matching for missing apostrophe+space cases (DA→D'A, DE→D'E etc.) |
| 21:07 | `e61bdfc` | ENH | Add short-first-word suffix rule for abbreviated bairro names |
| 23:06 | `daf5c8f` | RE-FIX | Fix bairro detail panel showing different count than heatmap marker — **user reported** clicking a bairro showed a different number than the heatmap tooltip. Location-stats endpoint was using different query logic than heatmap endpoint. |
| 23:07 | `36f1b9d` | ENH | Add phonetic Z↔S normalization with prefix matching for bairro names |

### March 10, 2026

| Time (UTC) | Commit | Type | Description |
|------------|--------|------|-------------|
| 10:34 | `cb6ee4e` | BUG | Add fuzzy municipality name matching for bairro polygon lookups — some municipalities in crime data had slightly different names than in GeoJSON (e.g., accent differences) |
| 11:49 | `dcea94b` | ENH | Add PARQUE and NUCLEO to bairro prefix-stripping list (found during city-by-city audit) |
| 12:11 | `08394a9` | FEAT | Expand RS bairro GeoJSON: add Phase 3 to `fetch_bairro_boundaries.py` — query OSM `place=suburb/neighbourhood` ways and relations (not just admin_level=10). Added 613 new polygon features. |
| 12:52 | `ff6e5cd` | FEAT | Phase 4: OSM node bairros with approximate circular polygons — **user reported** Florescente and Planalto (Viamão) appear on Google Maps but not on our map. They exist in OSM only as point nodes. Generates 16-sided ~400m radius circles. RS total: 3,392 → 4,810 features. |
| 13:14 | `89d4fab` | RE-FIX | Fix: use tiny radius (50m) for node-approx bairros inside existing polygons — **user reported** "bairros on top of each other" in Viamão after Phase 4 deploy. Nodes inside existing polygon bairros now get 50m dots (just for name matching) instead of 400m circles that visually overlapped parent polygons. |

---

## Bugs the User Had to Re-Report or Escalate

### 1. Crime types filter not loading
- **First report**: User said "tipos de crime never loads" (Canoas)
- **First fix**: `5b499ee` (17:05) — fixed `get_compatible_types()` for single-state selection
- **User re-reported**: "tipos de crime still not loading" with screenshot
- **Root cause**: The first fix addressed multi-state logic but a separate code path was still applying over-filtering

### 2. Bairro name matching (iterative — 10+ commits)
- **User report**: Canoas bairros "Bairro Fátima" (2,711), "NOSSA SENHORA DAS GR" (truncated), "M VELHO" (abbreviation), "MOINHOS DE VENTO", "SAO CRISTOVAO" all landing in unknown
- **First fix**: `043004f` (18:32) — article stripping + phonetic normalization
- **Still broken**: Multiple edge cases kept surfacing → 8 more commits over 5 hours
- **User escalated**: "make sure you are NOT implementing custom fixes for specific locations/states/cities. fixes must be able to be applied across the board"
- **Final state**: General-purpose matching rules (prefix strip, abbreviation expansion, phonetic normalization, reverse prefix matching)

### 3. Cluster-merge absorbing polygon-matched bairros
- **Known gotcha**: Documented in MEMORY.md from earlier work
- **Resurfaced**: During bairro matching improvements, the cluster-merge pass (0.3km threshold) started absorbing bairros that had been correctly polygon-matched into "Bairro desconhecido"
- **Fix**: `3629f32` (20:45) — skip cluster-merge for polygon-matched bairros

### 4. Detail panel count mismatch
- **User report**: "some bairros have a stats number, then after clicking to see more details show a different total number"
- **Fix**: `daf5c8f` (23:06) — `/api/location-stats` was using different query logic than `/api/heatmap/bairros`

### 5. Missing bairro polygons (Florescente/Planalto)
- **User report**: "how come google maps shows polygons for all of the bairros in the unknown category and you cannot even find its geocentre?"
- **Investigation**: These exist in OSM only as `place=neighbourhood` point nodes — no polygon geometry
- **Fix Phase 3**: `08394a9` (12:11) — query OSM for `place=suburb/neighbourhood` ways+relations
- **Still missing**: Florescente/Planalto are nodes, not ways → needed Phase 4
- **Fix Phase 4**: `ff6e5cd` (12:52) — generate approximate circular polygons from nodes

### 6. Overlapping bairros after Phase 4
- **User report**: "in viamao there are a bunch of bairros on top of each other, for example: universal"
- **Cause**: Phase 4 added 169 node-approx circles in Viamão, many overlapping with the 30 existing large polygon districts
- **Fix**: `89d4fab` (13:14) — nodes inside existing polygons get 50m radius (tiny dot) instead of 400m

### 7. Static data files missing after deploy (3 commits)
- **Symptom**: Rate toggle broken (population data missing), bairro centroids missing
- **Cause 1**: Files not in git → `f11e46a` (09:57)
- **Cause 2**: `.gitignore` excluding them → `d7af1de` (09:58)
- **Cause 3**: Volume mount overwriting the directory → `b871f74` (10:04) — moved to `backend/lookup/`

---

## Infrastructure Notes

### Deploy Workflow
```
Edit locally → git push origin main → Coolify auto-deploys (~2-3 min) → verify via API
```

### Key Commands
```bash
# Deploy
git push origin main

# After fresh deploy: ingest RS historical data
curl -X POST "https://crimebrasil.com.br/api/admin/ingest-rs-history?force=true"

# Refresh staging data (RJ, MG, SINESP)
curl -X POST https://crimebrasil.com.br/api/admin/refresh-staging

# Check staging stats
curl -s https://crimebrasil.com.br/api/admin/staging-stats | python3 -m json.tool

# Check backend container
ssh root@188.34.199.27 "docker ps | grep backend"

# Regenerate bairro GeoJSON
python3 backend/scripts/fetch_bairro_boundaries.py rs
```

### Critical Post-Deploy Step
After fresh deploy, RS historical data must be ingested:
```bash
curl -X POST "https://crimebrasil.com.br/api/admin/ingest-rs-history?force=true"
```
Without this, only the latest RS year has bairro detail — older years show SINESP-only (~16K vs 500K+ records).
