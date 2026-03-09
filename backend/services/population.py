"""Population data loader for per-100K rate calculations.

Loads backend/data/population.json at import time and exposes lookup functions.
"""

import json, os, unicodedata, logging

log = logging.getLogger(__name__)

_DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "lookup", "population.json")

# Loaded data
_population_data: dict = {}
# name_norm -> IBGE code (built from rs-municipios.geojson)
_mun_name_to_code: dict[str, str] = {}


def _normalize(s: str) -> str:
    nfkd = unicodedata.normalize('NFD', s)
    return ''.join(c for c in nfkd if unicodedata.category(c) != 'Mn').upper().strip()


def _load():
    global _population_data, _mun_name_to_code

    # Load population.json
    if os.path.exists(_DATA_PATH):
        with open(_DATA_PATH, encoding='utf-8') as f:
            _population_data = json.load(f)
        log.info(f"Population data loaded: {len(_population_data.get('municipios', {}))} municipios, "
                 f"{len(_population_data.get('states', {}))} states")
    else:
        log.warning(f"Population data not found at {_DATA_PATH}")
        _population_data = {}

    # Build name -> IBGE code map
    # Primary: load from static JSON file (Docker-safe, no GeoJSON needed)
    static_json_path = os.path.join(os.path.dirname(__file__), "..", "data", "mun_name_to_code.json")
    if os.path.exists(static_json_path):
        try:
            with open(static_json_path, encoding='utf-8') as f:
                _mun_name_to_code = json.load(f)
            log.info(f"Loaded {len(_mun_name_to_code)} municipality name→code mappings from mun_name_to_code.json")
            return  # Skip GeoJSON loading
        except Exception as e:
            log.warning(f"Failed to load mun_name_to_code.json: {e}")

    # Fallback: build from GeoJSON files
    import glob
    geo_dirs = [
        os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "public", "geo"),
        "/app/geo",
    ]
    loaded_files = 0
    for geo_dir in geo_dirs:
        if not os.path.isdir(geo_dir):
            continue
        for geo_path in sorted(glob.glob(os.path.join(geo_dir, "*-municipios.geojson"))):
            try:
                with open(geo_path) as f:
                    geo = json.load(f)
                for feat in geo.get("features", []):
                    props = feat.get("properties", {})
                    code = props.get("codarea", "")
                    name = props.get("name", "")
                    if code and name:
                        _mun_name_to_code[_normalize(name)] = code
                loaded_files += 1
            except Exception as e:
                log.warning(f"Failed to load {geo_path}: {e}")
        if loaded_files > 0:
            break  # found geo files in this directory, don't check fallback
    log.info(f"Loaded {loaded_files} GeoJSON files, {len(_mun_name_to_code)} municipality name→code mappings")


# Load at import time
_load()


def get_state_population(sigla: str) -> int | None:
    """Get population for a state by its 2-letter abbreviation."""
    return _population_data.get("states", {}).get(sigla.upper())


def get_municipio_population(name: str, state: str = "") -> int | None:
    """Get population for a municipality by name.

    Uses the GeoJSON codarea bridge to map name -> IBGE code -> population.
    Falls back to trying the name directly if state is RS.
    """
    if not name:
        return None
    municipios = _population_data.get("municipios", {})
    name_norm = _normalize(name)

    # Try via IBGE code
    code = _mun_name_to_code.get(name_norm)
    if code and code in municipios:
        return municipios[code]

    # Try all municipality codes matching the state prefix
    state_codes = _population_data.get("state_codes", {})
    state_prefix = ""
    for code_prefix, abbr in state_codes.items():
        if abbr == state.upper():
            state_prefix = code_prefix
            break

    if state_prefix:
        # Search through all municipios for one whose name matches
        # This is a broader fallback for non-RS municipalities
        for mun_code, pop in municipios.items():
            if mun_code.startswith(state_prefix):
                # We don't have names for non-RS municipalities in our GeoJSON,
                # but the IBGE code is available in staging data
                pass

    return None


def get_municipio_population_by_code(ibge_code: str) -> int | None:
    """Get population directly by 7-digit IBGE code."""
    return _population_data.get("municipios", {}).get(ibge_code)


def get_bairro_population(municipio: str, bairro: str, state: str = "RS") -> int | None:
    """Get population for a bairro.

    Returns None if bairro population is unknown.
    """
    if not municipio or not bairro:
        return None
    bairros = _population_data.get("bairros", {})
    state_data = bairros.get(state.upper(), {})

    mun_norm = _normalize(municipio)
    bairro_norm = _normalize(bairro)

    mun_data = state_data.get(mun_norm, {})
    pop = mun_data.get(bairro_norm)
    if pop is not None:
        return pop

    # Try matching with hyphens replaced by spaces and vice versa
    alt = bairro_norm.replace('-', ' ')
    if alt != bairro_norm:
        pop = mun_data.get(alt)
        if pop is not None:
            return pop
    alt = bairro_norm.replace(' ', '-')
    if alt != bairro_norm:
        pop = mun_data.get(alt)
        if pop is not None:
            return pop

    return None
