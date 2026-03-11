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
- **Status**: OPEN

### [BUG-005] PANEL-ZERO-TOTAL | ALL RJ CITIES | location-stats
- **Issue**: `location-stats` endpoint returns `total=0` for ALL RJ and MG cities. The staging fallback query uses `CrimeStaging.municipio.in_(staging_names)` where `staging_names` contains uppercase names (e.g. `['RIO DE JANEIRO']`). But the DB stores mixed-case names (e.g. `'Rio de Janeiro'`). SQLite comparison is case-sensitive, so no records match.
- **Evidence**: DB has 305,875 rows for `municipio='Rio de Janeiro'` (mixed case) but 0 rows for `municipio='RIO DE JANEIRO'` (exact uppercase). Heatmap endpoint works because it queries all staging by state without municipio name filter. `location-stats` at `?state=RJ&municipio=RIO DE JANEIRO` returns `total=0` even though staging has ~700K records for Rio de Janeiro.
- **Fix needed**: Change line 1301 in `main.py` from `CrimeStaging.municipio.in_(staging_names)` to `func.upper(CrimeStaging.municipio).in_([n.upper() for n in staging_names])` (or use `.ilike()` with exact match). This fix applies to both the `total` and `crime_types` queries.
- **Status**: OPEN

### [BUG-006] NAME-MISMATCH | SANTA MARIA | MEDIANEIRA (ambiguous suffix)
- **Issue**: DB has `MEDIANEIRA` (206 records) as short form. Santa Maria has two polygons ending in `MEDIANEIRA`: `NOSSA SENHORA MEDIANEIRA` and `VILA MEDIANEIRA`. The suffix match requires exactly 1 result, so with 2 matches it fails → desconhecido.
- **Evidence**: Santa Maria polygons: `NOSSA SENHORA MEDIANEIRA`, `VILA MEDIANEIRA`. DB has 206 `MEDIANEIRA` records (distinct from `Nossa Senhora Medianeira` which has 2417 and already matches via normalization). The short form `MEDIANEIRA` alone is ambiguous in Santa Maria's polygon set.
- **Fix needed**: Add `'MEDIANEIRA': 'NOSSA SENHORA MEDIANEIRA'` to `BAIRRO_ALIASES` (this is the dominant/official neighborhood; `Vila Medianeira` is a street-level subdivision). Verify: `Nossa Senhora Medianeira` exists only in Santa Maria and Faxinal do Soturno — no conflicts.
- **Status**: OPEN

### [BUG-007] NAME-MISMATCH | SANTA MARIA | DORES (ambiguous suffix)
- **Issue**: DB has `DORES` (120 records) as short form. Santa Maria has two polygons ending in `DORES`: `NOSSA SENHORA DAS DORES` and `LOTEAMENTO PAROQUIA DAS DORES`. Suffix match finds 2 → fails.
- **Evidence**: Santa Maria DB: 120 `DORES` + 75 `Dores` records. Polygons: `NOSSA SENHORA DAS DORES`, `LOTEAMENTO PAROQUIA DAS DORES`.
- **Fix needed**: Add `'DORES': 'NOSSA SENHORA DAS DORES'` to `BAIRRO_ALIASES`. The `Nossa Senhora das Dores` is the main neighborhood; `Loteamento Paroquia das Dores` is a sub-loteamento. The short form `DORES` unambiguously refers to the main neighborhood.
- **Status**: OPEN

### [BUG-008] INVALID-BAIRRO | SANTA MARIA | PREJUDICADO
- **Issue**: `PREJUDICADO` (meaning "damaged/prejudiced") appears 307 times as a bairro name in Santa Maria. This is clearly a data quality artifact (SSP data entry error meaning "unavailable/excluded") and should be treated as invalid/unknown.
- **Evidence**: DB: 175 `prejudicado` + 130 `PREJUDICADO` + 2 `Prejudicado` records in Santa Maria. No GeoJSON polygon exists for this name anywhere.
- **Fix needed**: Add `'PREJUDICADO'` to `_INVALID_BAIRRO_NAMES` set.
- **Status**: OPEN

### [BUG-009] MISSING-GEOJSON | RIO GRANDE | most bairros
- **Issue**: Rio Grande has 9,841 weight in desconhecido with 80+ distinct bairro components. The GeoJSON only has 26 unusual polygon names (mostly VILA JUNCAO, NOVA QUINTA, ABEL CRAVO, etc.) — none of the common downtown bairros (CENTRO, CIDADE NOVA, CASTELO BRANCO, COHAB, LAGOA, NAVEGANTES, etc.) have polygons.
- **Evidence**: 80+ named bairros in DB have no corresponding polygon. Only 26 polygons exist, with no standard neighborhood coverage.
- **Fix needed**: NEEDS-GEOJSON — would require sourcing complete Rio Grande bairro boundary data from IBGE.
- **Status**: OPEN (data gap)

### [BUG-010] MISSING-GEOJSON | BAGE | all bairros
- **Issue**: Bagé has 6,678 weight in desconhecido. Zero GeoJSON polygons for Bagé.
- **Evidence**: 0 polygons for BAGE in rs-bairros.geojson.
- **Fix needed**: NEEDS-GEOJSON
- **Status**: OPEN (data gap)

### [BUG-011] MISSING-GEOJSON | SANTO ANGELO | most bairros
- **Issue**: Santo Ângelo has 6,058 weight in desconhecido. Only 1 polygon (COHAB) exists.
- **Evidence**: 80+ bairro names in DB, only 1 polygon.
- **Fix needed**: NEEDS-GEOJSON
- **Status**: OPEN (data gap)

### [BUG-012] MISSING-GEOJSON | SAPIRANGA | all bairros
- **Issue**: Sapiranga has 3,924 weight in desconhecido. Zero GeoJSON polygons.
- **Fix needed**: NEEDS-GEOJSON
- **Status**: OPEN (data gap)

---

## Summary

**Code-fixable bugs**: BUG-001 through BUG-008 (8 bugs)
**Data gaps (NEEDS-GEOJSON)**: BUG-009 through BUG-012 (4 cities documented, ~30+ similar cities)

**Highest impact**: BUG-005 (all RJ/MG city detail panels show 0), BUG-002 (COHAB prefix), BUG-003 (PARQUE DO prefix)
