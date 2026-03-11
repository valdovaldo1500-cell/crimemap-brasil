# Crime Brasil - Project Guide

## Architecture
- **Backend**: FastAPI (Python 3.11+), SQLAlchemy ORM, SQLite database
- **Frontend**: Next.js 14, Leaflet maps, Tailwind CSS
- **Deployment**: Docker Compose (backend:8000, frontend:3001→3000)
- **Database**: SQLite at `backend/data/crimemap.db`

## Data Pipeline

Two parallel systems:

### 1. Detailed RS Data (`crimes` table)
- Source: SSP/RS ZIP files (Lei 15.610/2021 open data)
- Individual crime records with demographics (age, sex, race), location (municipio, bairro, lat/lng)
- Ingested via `services/data_ingestion.py` → geocoded via `services/geocoder.py`
- State column supports RS and SP

### 2. Multi-State Staging Data (`crimes_staging` table)
- Aggregated crime counts by municipio/state/year/month
- Sources:
  | Source | States | Quality | Format | Key Columns |
  |--------|--------|---------|--------|-------------|
  | SSP/RS | RS | full | ZIP/CSV | Individual records with demographics |
  | ISP/RJ | RJ | full | CSV (`;` sep) | Municipality-level, unpivoted crime columns |
  | SEJUSP/MG | MG | partial | CSV (`;` sep) | Violent crimes only |
  | SINESP Municipal | All 27 | basic | XLSX | Municipality-level victim counts |
  | SINESP UF | All 27 | basic | XLSX | State-level with sheets for ocorrências/vítimas |
  | SINESP VDE | All 27 | basic | XLSX (per year) | 15 crime event types, yearly data |
- Loaded via `services/staging_loader.py` → `run_full_staging_load()`
- Dedup: RJ VDE rows removed in favor of ISP data

## Key Files

| File | Purpose |
|------|---------|
| `backend/main.py` | FastAPI app, all API endpoints, GeoJSON loading, startup/shutdown |
| `backend/database.py` | SQLAlchemy models: Crime, CrimeStaging, GeocodeCache, BugReport, DataSource |
| `backend/services/staging_loader.py` | Multi-source ETL: download, parse, load staging data |
| `backend/services/scheduler.py` | APScheduler: 2 weekly jobs (SSP check + staging refresh) |
| `backend/services/data_ingestion.py` | RS-specific SSP data download and geocoding |
| `backend/services/crime_categories.py` | Cross-state category mapping, compatibility logic |
| `backend/services/population.py` | Population lookup (municipality, state, bairro) |
| `backend/services/geocoder.py` | Geocoding service, bairro batch geocoding |
| `backend/services/update_checker.py` | Check SSP for new file URLs |
| `frontend/src/app/page.tsx` | Main page: filters, state selection, year/period, modals |
| `frontend/src/components/CrimeMap.tsx` | Leaflet map: 3 zoom levels, choropleth/dots, sources popup |
| `frontend/src/lib/api.ts` | API client functions |

## Scheduler

APScheduler runs 2 background jobs:
- `auto_ingest` — checks RS/SP SSP for new ZIP files every 7 days
- `staging_refresh` — deletes cached staging files and re-downloads all sources every 7 days (offset 3 days from auto_ingest)

Started in `main.py` startup event, stopped in shutdown.

## Admin Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/load-staging` | POST | Trigger full staging load (uses cached files) |
| `/api/admin/refresh-staging` | POST | Delete cached files + re-download + re-load staging |
| `/api/admin/check-updates` | POST | Manually trigger SSP data check + ingestion |
| `/api/admin/ingest-rs-history` | POST | Ingest all RS historical data (2022-2026). Use `?force=true` to re-ingest files already marked as ingested |
| `/api/admin/geocode-bairros` | POST | Batch geocode bairros missing from cache |
| `/api/admin/validate-geocache` | POST | Delete geocache entries > 50km from municipality |
| `/api/admin/staging-stats` | GET | Row counts grouped by state and source |
| `/api/admin/state-data-quality` | GET | Per-source, per-state quality diagnostics |
| `/api/admin/geocoding-status` | GET | Geocoding coverage statistics |
| `/api/admin/bug-reports` | GET | List all bug reports |

## Public API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/heatmap/municipios` | Municipality-level heatmap (merges crimes + staging) |
| `GET /api/heatmap/bairros` | Bairro-level heatmap (RS only) |
| `GET /api/heatmap/states` | State-level aggregation |
| `GET /api/filter-options` | Cross-filtered options for tipo/grupo/sexo/cor |
| `GET /api/stats` | Summary statistics |
| `GET /api/available-states` | States with quality metadata |
| `GET /api/state-filter-info` | Compatible types, max granularity, active filter |
| `GET /api/data-sources` | Source metadata with URLs, record counts, timestamps |
| `GET /api/search` | Autocomplete for municipalities and bairros |
| `GET /api/location-stats` | Detailed breakdown for a location |
| `GET /api/state-stats` | Detailed breakdown for a state |
| `POST /api/bug-report` | Submit bug report with captcha |

## Common Tasks

### Fresh deployment / server migration checklist
After deploying to a new server or resetting the database, run these steps **in order**:

1. **Load staging data** (RJ, MG, SINESP — municipality-level aggregates):
   ```bash
   curl -X POST https://crimebrasil.com.br/api/admin/refresh-staging
   ```
2. **Ingest RS historical data** (bairro-level detail, 2022-2026, ~3M records):
   ```bash
   curl -X POST "https://crimebrasil.com.br/api/admin/ingest-rs-history?force=true"
   ```
   This downloads ~500MB of ZIP files from SSP/RS and takes 10-15 minutes.
   Without this step, only the latest RS year has bairro/municipality detail — older years fall back to SINESP staging (state/municipality level only, no bairros).
3. **Verify** all years have data:
   ```bash
   for yr in 2022 2023 2024 2025 2026; do
     echo -n "$yr: "
     curl -s "https://crimebrasil.com.br/api/heatmap/states?ano=$yr&selected_states=RS" \
       | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['weight'] if d else 'EMPTY')"
   done
   ```
   Each year should show 500K+ (not ~16K which means only SINESP staging).

### Add a new state with detailed data
1. Create ingestion logic in `services/data_ingestion.py` or new service
2. Add state to `crime_categories.py` STATE_QUALITY and type mappings
3. Add GeoJSON file to `frontend/public/geo/{state}-municipios.geojson`
4. Add state to `STATES_WITH_MUNICIPIO_GEO` in `CrimeMap.tsx`
5. Update population data in `services/population.py`

### Re-import all staging data
```bash
curl -X POST https://crimebrasil.com.br/api/admin/refresh-staging
# Monitor progress:
watch -n 5 'curl -s https://crimebrasil.com.br/api/admin/staging-stats | python3 -m json.tool'
```

### Run E2E tests
```bash
export PATH="/home/valdo/.local/node-v20.11.1-linux-x64/bin:$PATH"
cd frontend && npx playwright test e2e/bug-fixes.spec.ts --reporter=line
```

### Docker rebuild
```bash
docker compose up -d --build backend  # backend only
docker compose up -d --build frontend  # frontend only
docker compose up -d --build  # both
```

## GeoJSON Files

Located in `frontend/public/geo/`:
- `br-states.geojson` — all 27 Brazilian states (state-level view)
- `rs-municipios.geojson` — RS municipality boundaries
- `rj-municipios.geojson` — RJ municipality boundaries
- `mg-municipios.geojson` — MG municipality boundaries
- `rs-bairros.geojson` — RS neighborhood boundaries (bairro-level view)

Source: IBGE API for municipality/state boundaries.

## Frontend Behavior

- **Interactive states**: Only RS, RJ, MG are interactive (clickable, selectable, drill-down). Other 24 states appear greyed-out on the map but have no click handlers or data surfaced to users.
- **State selection**: sidebar shows only RS/RJ/MG; auto-filter for partial states (MG warning modal)
- **Three zoom levels**: states (zoom < 7), municipios (7-10), bairros (≥ 11, RS/RJ/MG only)
- **Rate mode**: /100K hab. uses fixed thresholds; Total uses quantile-based coloring
- **Cascading filters**: changing any filter re-fetches available options

## Anti-Regression Rules

### Before committing:
- Run `cd backend && python -m pytest tests/ -v` (blocked by pre-commit hook anyway)
- For bairro matching changes: run `pytest tests/test_bairro_matching.py -v`
- For filter logic changes: verify with `curl` against the live API after deploy

### Behavioral constraints:
- If a fix requires changes to more than 3 files, STOP and use /plan mode first
- If tests fail after your change, REVERT and rethink — do NOT modify existing tests
- Never add city-specific or state-specific matching rules — all fixes must be general-purpose
- After every deploy, verify the specific fix with curl + verify no regression on POA unknown%

### Module dependency map (what to test when you change what):
- `_normalize_bairro_for_matching()` → run test_bairro_matching.py
- `_phonetic_br()`, `normalize_name()` → run test_bairro_matching.py
- heatmap_bairros endpoint → check detail panel consistency (location-stats must match)
- filter-options endpoint → verify cascading filters still work for RS, RJ, MG
- fetch_bairro_boundaries.py → re-run for RS, check feature count, check POA unknown%
