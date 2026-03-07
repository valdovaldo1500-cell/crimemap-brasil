#!/usr/bin/env python3
"""
Fetch population data from IBGE and produce backend/data/population.json.

Sources:
  - Municipality populations: IBGE Agregados API (Estimativas 2025, tabela 6579)
  - State populations: Same API with N3 (UF-level)
  - Bairro populations (Tier 1): IBGE "Agregados por bairros" CSV from Censo 2022
  - Bairro populations (Tier 2): IBGE census tracts GeoPackage + spatial aggregation

Usage:
  pip install geopandas shapely requests
  python backend/scripts/fetch_population.py
"""

import json, os, sys, zipfile, io, csv, unicodedata, re, tempfile, logging
import requests

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
log = logging.getLogger(__name__)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(BACKEND_DIR, "data")
GEO_DIR = os.path.join(BACKEND_DIR, "..", "frontend", "public", "geo")
OUTPUT_PATH = os.path.join(DATA_DIR, "population.json")

# IBGE state code -> abbreviation
STATE_CODE_MAP = {
    "11": "RO", "12": "AC", "13": "AM", "14": "RR", "15": "PA", "16": "AP",
    "17": "TO", "21": "MA", "22": "PI", "23": "CE", "24": "RN", "25": "PB",
    "26": "PE", "27": "AL", "28": "SE", "29": "BA", "31": "MG", "32": "ES",
    "33": "RJ", "35": "SP", "41": "PR", "42": "SC", "43": "RS", "50": "MS",
    "51": "MT", "52": "GO", "53": "DF",
}


def normalize_name(s: str) -> str:
    nfkd = unicodedata.normalize('NFD', s)
    return ''.join(c for c in nfkd if unicodedata.category(c) != 'Mn').upper().strip()


# ---------------------------------------------------------------------------
# 1a. Municipality population from IBGE API
# ---------------------------------------------------------------------------
def fetch_municipio_populations() -> dict[str, int]:
    """Returns {7-digit IBGE code: population}."""
    log.info("Fetching municipality populations from IBGE API...")
    url = ("https://servicodados.ibge.gov.br/api/v3/agregados/6579/"
           "periodos/-1/variaveis/9324?localidades=N6%5Ball%5D")
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    data = resp.json()
    result: dict[str, int] = {}
    for var in data:
        for res_item in var.get("resultados", []):
            for loc in res_item.get("series", []):
                code = loc["localidade"]["id"]
                # Get the most recent period value
                vals = loc.get("serie", {})
                for period in sorted(vals.keys(), reverse=True):
                    v = vals[period]
                    if v and v != "...":
                        result[code] = int(v)
                        break
    log.info(f"  Got {len(result)} municipalities")
    return result


# ---------------------------------------------------------------------------
# 1b. State population from IBGE API
# ---------------------------------------------------------------------------
def fetch_state_populations() -> dict[str, int]:
    """Returns {state abbreviation: population}."""
    log.info("Fetching state populations from IBGE API...")
    url = ("https://servicodados.ibge.gov.br/api/v3/agregados/6579/"
           "periodos/-1/variaveis/9324?localidades=N3%5Ball%5D")
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    data = resp.json()
    result: dict[str, int] = {}
    for var in data:
        for res_item in var.get("resultados", []):
            for loc in res_item.get("serie", []):
                pass  # wrong structure, fix below
    # Correct parsing
    result = {}
    for var in data:
        for res_item in var.get("resultados", []):
            for loc in res_item.get("series", []):
                code = loc["localidade"]["id"]
                sigla = STATE_CODE_MAP.get(code, "")
                if not sigla:
                    continue
                vals = loc.get("serie", {})
                for period in sorted(vals.keys(), reverse=True):
                    v = vals[period]
                    if v and v != "...":
                        result[sigla] = int(v)
                        break
    log.info(f"  Got {len(result)} states")
    return result


# ---------------------------------------------------------------------------
# 1c. Bairro population — Tier 1: IBGE official bairro aggregates
# ---------------------------------------------------------------------------
BAIRRO_CSV_URL = ("https://ftp.ibge.gov.br/Censos/Censo_Demografico_2022/"
                  "Agregados_por_Setores_Censitarios/Agregados_por_Bairro_csv/"
                  "Agregados_por_bairros_basico_BR_20250417.zip")


def fetch_bairro_populations_tier1() -> dict[str, dict[str, dict[str, int]]]:
    """
    Returns nested dict: {state: {municipio_name_norm: {bairro_name_norm: population}}}.
    Only RS (CD_UF == '43') for now.
    """
    log.info("Fetching IBGE bairro aggregates (Tier 1)...")
    try:
        resp = requests.get(BAIRRO_CSV_URL, timeout=120)
        resp.raise_for_status()
    except Exception as e:
        log.warning(f"  Failed to download bairro CSV: {e}")
        return {}

    result: dict[str, dict[str, dict[str, int]]] = {}
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        csv_names = [n for n in zf.namelist() if n.endswith('.csv') or n.endswith('.CSV')]
        if not csv_names:
            log.warning("  No CSV found in zip")
            return {}
        with zf.open(csv_names[0]) as f:
            # Try different encodings
            raw = f.read()
            for enc in ('utf-8', 'latin-1', 'cp1252'):
                try:
                    text = raw.decode(enc)
                    break
                except UnicodeDecodeError:
                    continue
            else:
                text = raw.decode('latin-1', errors='replace')

            reader = csv.DictReader(io.StringIO(text), delimiter=';')
            for row in reader:
                cd_uf = row.get('CD_UF', '').strip()
                if cd_uf != '43':  # RS only
                    continue
                cd_mun = row.get('CD_MUN', '').strip()
                nm_bairro = row.get('NM_BAIRRO', '').strip()
                pop_str = row.get('v0001', '').strip()
                if not nm_bairro or not pop_str:
                    continue
                try:
                    pop = int(float(pop_str))
                except ValueError:
                    continue
                # We need municipality name - get it from CD_MUN via our GeoJSON
                # For now store by CD_MUN, we'll resolve names later
                state = 'RS'
                result.setdefault(state, {}).setdefault(cd_mun, {})[normalize_name(nm_bairro)] = pop

    total_bairros = sum(len(b) for m in result.values() for b in m.values())
    log.info(f"  Got {total_bairros} bairros from Tier 1 CSV")
    return result


# ---------------------------------------------------------------------------
# 1c. Bairro population — Tier 2: Census tract spatial aggregation
# ---------------------------------------------------------------------------
SETORES_GPKG_URL = ("https://ftp.ibge.gov.br/Censos/Censo_Demografico_2022/"
                    "Agregados_por_Setores_Censitarios/agregado_por_setores_RS.zip")


def fetch_bairro_populations_tier2(existing_mun_codes: set[str]) -> dict[str, dict[str, int]]:
    """
    Spatial aggregation: load census tract data and our bairro polygons,
    for RS municipalities not covered in Tier 1.
    Returns {municipio_name_norm: {bairro_name_norm: population}}.
    """
    log.info("Attempting Tier 2 spatial aggregation...")
    try:
        import geopandas as gpd
        from shapely.geometry import shape
    except ImportError:
        log.warning("  geopandas/shapely not installed — skipping Tier 2")
        return {}

    # Load our bairro polygons
    bairro_geojson_path = os.path.join(GEO_DIR, "rs-bairros.geojson")
    if not os.path.exists(bairro_geojson_path):
        bairro_geojson_path = "/app/geo/rs-bairros.geojson"
    if not os.path.exists(bairro_geojson_path):
        log.warning("  rs-bairros.geojson not found — skipping Tier 2")
        return {}

    log.info("  Loading bairro polygons...")
    bairros_gdf = gpd.read_file(bairro_geojson_path)
    if bairros_gdf.crs and bairros_gdf.crs.to_epsg() != 4326:
        bairros_gdf = bairros_gdf.to_crs(epsg=4326)

    # Filter to municipalities NOT in Tier 1
    # We need the municipio_normalized field
    if 'municipio_normalized' not in bairros_gdf.columns:
        log.warning("  bairros GeoJSON missing municipio_normalized — skipping Tier 2")
        return {}

    # Download census tract data
    log.info("  Downloading census tract data (this may take a while)...")
    try:
        resp = requests.get(SETORES_GPKG_URL, timeout=300)
        resp.raise_for_status()
    except Exception as e:
        log.warning(f"  Failed to download census tracts: {e}")
        return {}

    # Extract and load
    result: dict[str, dict[str, int]] = {}
    with tempfile.TemporaryDirectory() as tmpdir:
        zip_path = os.path.join(tmpdir, "setores.zip")
        with open(zip_path, 'wb') as f:
            f.write(resp.content)

        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(tmpdir)

        # Find the GeoPackage or CSV with population data
        gpkg_files = []
        csv_files = []
        for root, dirs, files in os.walk(tmpdir):
            for fname in files:
                if fname.endswith('.gpkg'):
                    gpkg_files.append(os.path.join(root, fname))
                elif fname.endswith('.csv') or fname.endswith('.CSV'):
                    csv_files.append(os.path.join(root, fname))

        if gpkg_files:
            log.info(f"  Loading GeoPackage: {os.path.basename(gpkg_files[0])}")
            setores_gdf = gpd.read_file(gpkg_files[0])
            if setores_gdf.crs and setores_gdf.crs.to_epsg() != 4326:
                setores_gdf = setores_gdf.to_crs(epsg=4326)

            # Find population column (usually v0001 or similar)
            pop_col = None
            for col in setores_gdf.columns:
                if col.lower() in ('v0001', 'v001', 'pop', 'populacao', 'moradores'):
                    pop_col = col
                    break
            if not pop_col:
                # Try to find any column that looks like population
                for col in setores_gdf.columns:
                    if 'pop' in col.lower() or 'morad' in col.lower() or col == 'v0001':
                        pop_col = col
                        break

            if not pop_col:
                log.warning(f"  Could not find population column. Available: {list(setores_gdf.columns)}")
                return {}

            log.info(f"  Using population column: {pop_col}")

            # Get census tract centroids
            setores_gdf['centroid'] = setores_gdf.geometry.centroid

            # For each bairro polygon, find tracts whose centroids fall inside
            municipalities_in_tier1 = existing_mun_codes
            # Filter bairros to only those NOT in tier1 municipalities
            # We don't have cod_mun in bairros, so we process all and skip overlap later

            log.info("  Performing spatial join...")
            setores_points = setores_gdf.copy()
            setores_points = setores_points.set_geometry('centroid')

            joined = gpd.sjoin(setores_points, bairros_gdf, how='inner', predicate='within')

            for _, row in joined.iterrows():
                mun_norm = row.get('municipio_normalized', '')
                bairro_norm = row.get('name_normalized', '')
                pop = row.get(pop_col, 0)
                if not mun_norm or not bairro_norm:
                    continue
                try:
                    pop_val = int(float(pop)) if pop else 0
                except (ValueError, TypeError):
                    continue
                result.setdefault(mun_norm, {}).setdefault(bairro_norm, 0)
                result[mun_norm][bairro_norm] += pop_val

            total_bairros = sum(len(b) for b in result.values())
            log.info(f"  Got {total_bairros} bairros from Tier 2 spatial aggregation")
        else:
            log.warning("  No GeoPackage found in census tract download")

    return result


# ---------------------------------------------------------------------------
# Assemble and write output
# ---------------------------------------------------------------------------
def build_municipio_name_map() -> dict[str, str]:
    """Build IBGE code -> normalized municipality name from rs-municipios.geojson."""
    geojson_path = os.path.join(GEO_DIR, "rs-municipios.geojson")
    if not os.path.exists(geojson_path):
        geojson_path = "/app/geo/rs-municipios.geojson"
    if not os.path.exists(geojson_path):
        return {}
    with open(geojson_path) as f:
        data = json.load(f)
    result = {}
    for feat in data.get("features", []):
        props = feat.get("properties", {})
        code = props.get("codarea", "")
        name = props.get("name", "")
        if code and name:
            result[code] = normalize_name(name)
    return result


def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    # Fetch municipality and state populations
    mun_pops = fetch_municipio_populations()
    state_pops = fetch_state_populations()

    # Build code -> name map for RS municipalities
    code_to_name = build_municipio_name_map()

    # Fetch bairro populations
    tier1_raw = fetch_bairro_populations_tier1()

    # Convert Tier 1 from {state: {cd_mun: {bairro: pop}}} to {state: {mun_name: {bairro: pop}}}
    bairros: dict[str, dict[str, dict[str, int]]] = {}
    tier1_mun_codes: set[str] = set()
    for state, mun_dict in tier1_raw.items():
        for cd_mun, bairro_dict in mun_dict.items():
            # cd_mun is 7-digit IBGE code
            mun_name = code_to_name.get(cd_mun, "")
            if not mun_name:
                # Try to find in the full mun_pops keys
                # cd_mun from CSV might be just the municipality part
                for full_code, name in code_to_name.items():
                    if full_code == cd_mun or full_code.endswith(cd_mun):
                        mun_name = name
                        break
            if mun_name:
                tier1_mun_codes.add(cd_mun)
                bairros.setdefault(state, {}).setdefault(mun_name, {}).update(bairro_dict)

    # Try Tier 2 spatial aggregation
    tier2 = fetch_bairro_populations_tier2(tier1_mun_codes)
    for mun_norm, bairro_dict in tier2.items():
        # Only add if not already covered by Tier 1
        if mun_norm not in bairros.get("RS", {}):
            bairros.setdefault("RS", {}).setdefault(mun_norm, {}).update(bairro_dict)

    # Build output
    output = {
        "source": "IBGE Censo 2022 + Estimativas 2025",
        "municipios": mun_pops,
        "states": state_pops,
        "state_codes": STATE_CODE_MAP,
        "bairros": bairros,
    }

    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    log.info(f"\nOutput written to {OUTPUT_PATH}")
    log.info(f"  Municipalities: {len(mun_pops)}")
    log.info(f"  States: {len(state_pops)}")
    total_bairros = sum(len(b) for m in bairros.values() for b in m.values())
    log.info(f"  Bairros: {total_bairros}")


if __name__ == "__main__":
    main()
