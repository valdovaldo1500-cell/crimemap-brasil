#!/usr/bin/env python3
"""Download municipality GeoJSON files from IBGE for use in the crime map.

Downloads state municipality boundaries and normalizes properties to
{codarea, name} format matching rs-municipios.geojson.

Usage:
    python scripts/download_state_geojson.py [--states RJ MG]
"""

import json
import os
import sys
import requests
import unicodedata

# State code → (sigla, output filename)
STATE_CODES = {
    33: ("RJ", "rj-municipios.geojson"),
    31: ("MG", "mg-municipios.geojson"),
}

IBGE_API = "https://servicodados.ibge.gov.br/api/v3/malhas/estados/{code}?formato=application/vnd.geo+json&qualidade=intermediaria&intrarregiao=municipio"

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "public", "geo")


def normalize_name(s: str) -> str:
    """Strip accents and uppercase for matching."""
    nfkd = unicodedata.normalize('NFD', s)
    return ''.join(c for c in nfkd if unicodedata.category(c) != 'Mn').upper().strip()


def _fetch_municipality_names(state_code: int) -> dict[str, str]:
    """Fetch municipality names from IBGE localidades API.

    The malhas API only returns codarea, not names. We need this second
    API call to get the municipality names for each code.
    Returns a dict: codarea → name
    """
    url = f"https://servicodados.ibge.gov.br/api/v1/localidades/estados/{state_code}/municipios"
    print(f"  Fetching municipality names from localidades API...")
    resp = requests.get(url, timeout=60, headers={"User-Agent": "CrimeBrasil/1.0"})
    resp.raise_for_status()
    return {str(m["id"]): m["nome"] for m in resp.json()}


def download_state_geojson(state_code: int, sigla: str, filename: str):
    """Download and normalize a state's municipality GeoJSON from IBGE."""
    url = IBGE_API.format(code=state_code)
    print(f"Downloading {sigla} (code {state_code}) from IBGE...")

    resp = requests.get(url, timeout=120, headers={"User-Agent": "CrimeBrasil/1.0"})
    resp.raise_for_status()
    geojson = resp.json()

    # Fetch names separately since malhas API doesn't include them
    names = _fetch_municipality_names(state_code)

    # Normalize properties to match rs-municipios.geojson format
    for feature in geojson.get("features", []):
        props = feature.get("properties", {})
        codarea = (
            props.get("codarea")
            or props.get("CD_MUN")
            or props.get("codmun")
            or str(props.get("id", ""))
        )
        # Try to get name from properties first, fall back to localidades API
        name = (
            props.get("name")
            or props.get("NM_MUN")
            or props.get("nome")
            or names.get(str(codarea), "")
        )

        feature["properties"] = {
            "codarea": str(codarea),
            "name": name,
            "name_normalized": normalize_name(name),
        }

    output_path = os.path.join(OUTPUT_DIR, filename)
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False)

    n_features = len(geojson.get("features", []))
    named = sum(1 for f in geojson["features"] if f["properties"]["name"])
    size_kb = os.path.getsize(output_path) / 1024
    print(f"  Saved {filename}: {n_features} municipalities ({named} with names), {size_kb:.0f} KB")
    return output_path


def main():
    # Parse optional --states argument
    states_filter = None
    if "--states" in sys.argv:
        idx = sys.argv.index("--states")
        states_filter = [s.upper() for s in sys.argv[idx + 1:]]

    for code, (sigla, filename) in STATE_CODES.items():
        if states_filter and sigla not in states_filter:
            continue
        try:
            download_state_geojson(code, sigla, filename)
        except Exception as e:
            print(f"  ERROR downloading {sigla}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
