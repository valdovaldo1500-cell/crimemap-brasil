# Crime Brasil — Autonomous Bug-Hunt Report

**Started**: 2026-03-11
**Scope**: Bairro Desconhecido audit (Phase 1) + City Detail Panel accuracy (Phase 2)

---

## Bug Log

### [BUG-001] NAME-MISMATCH | SANTA MARIA | BONFIM
- **Issue**: `_BAIRRO_ABBREVIATIONS` maps `BONFIM -> BOM FIM` unconditionally. Santa Maria has a polygon named `BONFIM` (not `BOM FIM`). The alias fires before the polygon check, converting `BONFIM` to `BOM FIM`, which is not in Santa Maria's polygon set → goes to Bairro desconhecido. Same issue in Bossoroca (BONFIM polygon only). Also causes 70 Porto Alegre `Bonfim` records to land on `BOM FIM` polygon instead of the distinct `BONFIM` polygon.
- **Evidence**: `rs-bairros.geojson` has `BONFIM` polygon for Santa Maria, Bossoroca, Porto Alegre. DB has 907 `Bonfim` + 20 `BONFIM` records for Santa Maria. Porto Alegre has both `BONFIM` and `BOM FIM` polygons (separate neighborhoods).
- **Fix needed**: Remove `'BONFIM': 'BOM FIM'` from `_BAIRRO_ABBREVIATIONS`. Instead, add conditional alias logic: in the poly-check section, try `BOM FIM` only if `BONFIM` is NOT in poly_names. This is the only alias that conflicts with an existing polygon name.
- **Status**: FIXED (removed global alias; added poly-conditional BONFIM→BOM FIM; updated golden test)

### [BUG-002] MISSING-ABBREV | PELOTAS, GRAVATAI | COHAB [NAME]
- **Issue**: `COHAB GUABIROBA`, `COHAB TABLADA`, `COHAB LINDOIA` (Pelotas) and similar patterns fail to match because `COHAB` is not in the prefix-strip list. The bare names (`GUABIROBA`, `TABLADA`, `LINDOIA`) ARE valid polygons in Pelotas. The strip_prefix list includes `VILA `, `JARDIM `, `PARQUE ` etc. but not `COHAB `.
- **Evidence**: Pelotas has `GUABIROBA`, `TABLADA`, `LINDOIA` polygons. DB has 781 `COHAB Guabiroba`, 277 `COHAB Tablada`, 24 `Cohab Lindóia` records all going to desconhecido. Gravatai has `COHAB A`, `COHAB B`, `COHAB C` as full polygon names → those already match directly and won't be affected by stripping.
- **Fix needed**: Add `'COHAB '` to the strip_prefix loop in `_normalize_bairro_for_matching()`. The strip is conditional on the bare name being in poly_names, so false positives are impossible.
- **Status**: FIXED (added COHAB to strip_prefix list)

### [BUG-003] MISSING-ABBREV | PELOTAS, GRAVATAI, CANELA | PARQUE DO/DA [NAME]
- **Issue**: `PARQUE DO OBELISCO` → strip `PARQUE ` → `DO OBELISCO` → `DO OBELISCO` not in polys (only `OBELISCO` is). The current strip logic only strips the prefix, leaving the article `DO`/`DA`/`DOS`/`DAS` which prevents the bare-name match.
- **Evidence**: Pelotas: `Parque do Obelisco` (528 records) → should map to `OBELISCO` polygon. Gravatai: `Parque do Itatiaia` (617 records) → should map to `ITATIAIA` polygon. Canela: `Parque das Hortensias` (28 records) → should map to `HORTENSIAS` polygon. Triunfo: `Vila do Estaleiro` (68 records) → should map to `ESTALEIRO` polygon.
- **Fix needed**: After stripping a prefix (e.g. `PARQUE `), also apply article-stripping to the result before the poly-check: `stripped = re.sub(r'^(DO|DA|DOS|DAS|DE)\s+', '', stripped)`.
- **Status**: FIXED (added _LEADING_ARTICLE_RE stripping after prefix removal)

### [BUG-004] NAME-MISMATCH | CAMPO BOM | VILA OPERARIA / OPERARIA
- **Issue**: DB has `VILA OPERARIA` and `OPERARIA` (feminine form) but Campo Bom polygon is `OPERARIO` (masculine). Strip `VILA ` → `OPERARIA` → not in polys (only `OPERARIO` exists).
- **Evidence**: Campo Bom has 105 `Vila Operaria` + 41 `OPERARIA` + 4 `Operaria` records. Polygon is `OPERARIO`. No RS city has a polygon named `OPERARIA`. Cities with `OPERARIO` polygon: Barao, Barracao, Campo Bom, Catuipe, Lagoa Vermelha, Novo Hamburgo, Sao Jose do Ouro, Tres Passos.
- **Fix needed**: Add `'OPERARIA': 'OPERARIO'` to `BAIRRO_ALIASES`. (Porto Alegre has `VILA OPERARIA` polygon, so VILA OPERARIA should NOT be aliased — handled by existing strip logic which would find exact match first.)
- **Status**: FIXED (added OPERARIA→OPERARIO to _BAIRRO_ABBREVIATIONS)

### [BUG-005] PANEL-ZERO-TOTAL | ALL RJ CITIES | location-stats
- **Issue**: `location-stats` endpoint returns `total=0` for ALL RJ and MG cities. The staging fallback query uses `CrimeStaging.municipio.in_(staging_names)` where `staging_names` contains uppercase names (e.g. `['RIO DE JANEIRO']`). But the DB stores mixed-case names (e.g. `'Rio de Janeiro'`). SQLite comparison is case-sensitive, so no records match.
- **Evidence**: DB has 305,875 rows for `municipio='Rio de Janeiro'` (mixed case) but 0 rows for `municipio='RIO DE JANEIRO'` (exact uppercase). Heatmap endpoint works because it queries all staging by state without municipio name filter. `location-stats` at `?state=RJ&municipio=RIO DE JANEIRO` returns `total=0` even though staging has ~700K records for Rio de Janeiro.
- **Fix needed**: Register `normalize_text()` SQLite UDF in database.py that strips accents + uppercases (SQLite's upper() only handles ASCII). Use `func.normalize_text(CrimeStaging.municipio).in_(staging_norm_names)` in location-stats fallback query.
- **Status**: FIXED (normalize_text SQLite UDF registered; all RJ cities now return correct totals)

### [BUG-006] NAME-MISMATCH | SANTA MARIA | MEDIANEIRA (ambiguous suffix)
- **Issue**: DB has `MEDIANEIRA` (206 records) as short form. Santa Maria has two polygons ending in `MEDIANEIRA`: `NOSSA SENHORA MEDIANEIRA` and `VILA MEDIANEIRA`. The suffix match requires exactly 1 result, so with 2 matches it fails → desconhecido.
- **Evidence**: Santa Maria polygons: `NOSSA SENHORA MEDIANEIRA`, `VILA MEDIANEIRA`. DB has 206 `MEDIANEIRA` records (distinct from `Nossa Senhora Medianeira` which has 2417 and already matches via normalization). The short form `MEDIANEIRA` alone is ambiguous in Santa Maria's polygon set.
- **Fix needed**: Add `'MEDIANEIRA': 'NOSSA SENHORA MEDIANEIRA'` to `BAIRRO_ALIASES` (this is the dominant/official neighborhood; `Vila Medianeira` is a street-level subdivision). Verify: `Nossa Senhora Medianeira` exists only in Santa Maria and Faxinal do Soturno — no conflicts.
- **Status**: FIXED (poly-conditional alias: MEDIANEIRA→NOSSA SENHORA MEDIANEIRA when no exact MEDIANEIRA polygon but NOSSA SENHORA MEDIANEIRA exists)

### [BUG-007] NAME-MISMATCH | SANTA MARIA | DORES (ambiguous suffix)
- **Issue**: DB has `DORES` (120 records) as short form. Santa Maria has two polygons ending in `DORES`: `NOSSA SENHORA DAS DORES` and `LOTEAMENTO PAROQUIA DAS DORES`. Suffix match finds 2 → fails.
- **Evidence**: Santa Maria DB: 120 `DORES` + 75 `Dores` records. Polygons: `NOSSA SENHORA DAS DORES`, `LOTEAMENTO PAROQUIA DAS DORES`.
- **Fix needed**: Add `'DORES': 'NOSSA SENHORA DAS DORES'` to `BAIRRO_ALIASES`. The `Nossa Senhora das Dores` is the main neighborhood; `Loteamento Paroquia das Dores` is a sub-loteamento. The short form `DORES` unambiguously refers to the main neighborhood.
- **Status**: FIXED (poly-conditional alias: DORES→NOSSA SENHORA DAS DORES when no exact DORES polygon)

### [BUG-008] INVALID-BAIRRO | SANTA MARIA | PREJUDICADO
- **Issue**: `PREJUDICADO` (meaning "damaged/prejudiced") appears 307 times as a bairro name in Santa Maria. This is clearly a data quality artifact (SSP data entry error meaning "unavailable/excluded") and should be treated as invalid/unknown.
- **Evidence**: DB: 175 `prejudicado` + 130 `PREJUDICADO` + 2 `Prejudicado` records in Santa Maria. No GeoJSON polygon exists for this name anywhere.
- **Fix needed**: Add `'PREJUDICADO'` to `_INVALID_BAIRRO_NAMES` set.
- **Status**: FIXED (added to _INVALID_BAIRRO_NAMES)

### [BUG-009] MISSING-GEOJSON | RIO GRANDE | most bairros
- **Issue**: Rio Grande has 9,841 weight in desconhecido with 80+ distinct bairro components. The GeoJSON only had 26 unusual polygon names (mostly VILA JUNCAO, NOVA QUINTA, ABEL CRAVO, etc.) — none of the common downtown bairros (CENTRO, CIDADE NOVA, CASTELO BRANCO, COHAB, LAGOA, NAVEGANTES, etc.) had polygons.
- **Evidence**: 80+ named bairros in DB had no corresponding polygon. Only 26 polygons existed, with no standard neighborhood coverage.
- **Fix applied**: Replaced `supplement_with_ibge()` (geobr 2010 data) with `supplement_with_ibge_2022()` using IBGE 2022 Census boundaries from geoftp.ibge.gov.br. IBGE 2022 provided additional polygons for Rio Grande via the BR zip (filtered by CD_UF='43'). Rio Grande now has 26 polygons (IBGE 2022 matched existing OSM footprint; partial coverage remains for some neighborhoods not in IBGE 2022).
- **Status**: PARTIAL FIX — 26 polygons present (was 26 from OSM, IBGE 2022 data for Rio Grande did not add new neighborhoods beyond OSM coverage; remaining gap is a source data limitation)

### [BUG-010] MISSING-GEOJSON | BAGE | all bairros
- **Issue**: Bagé has 6,678 weight in desconhecido. Zero GeoJSON polygons for Bagé.
- **Evidence**: 0 polygons for BAGE in rs-bairros.geojson.
- **Fix attempted**: IBGE 2022 Census data (geoftp.ibge.gov.br BR zip, CD_UF='43') was checked — Bagé has 0 rows in IBGE 2022. No polygon data available from IBGE 2022 for this municipality.
- **Status**: OPEN (data gap — Bagé absent from IBGE 2022 bairros dataset)

### [BUG-011] MISSING-GEOJSON | SANTO ANGELO | most bairros
- **Issue**: Santo Ângelo has 6,058 weight in desconhecido. Only 1 polygon (COHAB) existed.
- **Evidence**: 80+ bairro names in DB, only 1 polygon.
- **Fix attempted**: IBGE 2022 Census data checked — Santo Ângelo has 0 rows in IBGE 2022 bairros dataset.
- **Status**: OPEN (data gap — Santo Ângelo absent from IBGE 2022 bairros dataset; still 1 polygon)

### [BUG-012] MISSING-GEOJSON | SAPIRANGA | all bairros
- **Issue**: Sapiranga has 3,924 weight in desconhecido. Zero GeoJSON polygons.
- **Fix applied**: IBGE 2022 Census boundaries provided 17 polygons for Sapiranga.
- **Status**: FIXED — 17 polygons added via IBGE 2022 Census data

---

## Summary

**Code-fixable bugs**: BUG-001 through BUG-008 (8 bugs) — ALL FIXED ✓
**Data gaps (NEEDS-GEOJSON)**: BUG-009 through BUG-012 — partially addressed via IBGE 2022 Census supplement
- BUG-009 (Rio Grande): 26 polygons present; IBGE 2022 matched existing OSM coverage, no new neighborhoods added
- BUG-010 (Bagé): OPEN — absent from IBGE 2022 dataset
- BUG-011 (Santo Ângelo): OPEN — absent from IBGE 2022 dataset (1 polygon, COHAB only)
- BUG-012 (Sapiranga): FIXED — 17 polygons added from IBGE 2022

**IBGE 2022 supplement** (2026-03-11): replaced geobr 2010 source with direct IBGE 2022 Census download.
Added 305 new polygons, replaced 94 osm_node_approx circles with real IBGE boundaries. Total RS: 4878 features (was 4810).

**Highest impact fixed**: BUG-005 (all RJ city detail panels were showing 0; now show correct totals), BUG-001 (Santa Maria BONFIM now shows 652 in correct polygon), BUG-002/003 (COHAB + PARQUE DO prefix stripping)
