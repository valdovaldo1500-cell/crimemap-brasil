#!/usr/bin/env python3
"""Fetch bairro (admin_level=10) boundaries from OSM Overpass for Brazilian states.

Produces frontend/public/geo/{state}-bairros.geojson with polygon geometries
and normalized name properties for choropleth matching.

Usage:
    python backend/scripts/fetch_bairro_boundaries.py           # RS only (default)
    python backend/scripts/fetch_bairro_boundaries.py rs rj mg  # multiple states
    python backend/scripts/fetch_bairro_boundaries.py all       # RS, RJ, MG
"""
import json, os, sys, time, unicodedata
import requests

OVERPASS_URLS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter",
]
OVERPASS_URL = OVERPASS_URLS[0]

# State configurations: OSM name, IBGE code, admin_level for bairros
STATE_CONFIG = {
    "rs": {"osm_name": "Rio Grande do Sul", "ibge_code": 43},
    "rj": {"osm_name": "Rio de Janeiro", "ibge_code": 33},
    "mg": {"osm_name": "Minas Gerais", "ibge_code": 31},
}

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
GEO_DIR = os.path.join(PROJECT_ROOT, "frontend", "public", "geo")


def normalize_name(s: str) -> str:
    """Strip accents and uppercase — matches backend/main.py:normalize_name."""
    nfkd = unicodedata.normalize("NFD", s)
    return "".join(c for c in nfkd if unicodedata.category(c) != "Mn").upper().strip()


def round_coords(coords, precision=5):
    """Recursively round coordinate arrays to given decimal places."""
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], precision), round(coords[1], precision)]
    return [round_coords(c, precision) for c in coords]


def stitch_ways(members):
    """Stitch outer way segments into closed rings."""
    segments = []
    for m in members:
        if m.get("role") != "outer" or "geometry" not in m:
            continue
        seg = [(round(n["lon"], 5), round(n["lat"], 5)) for n in m["geometry"]]
        if len(seg) >= 2:
            segments.append(seg)

    if not segments:
        return []

    rings = []
    while segments:
        ring = list(segments.pop(0))
        changed = True
        while changed:
            changed = False
            for i, seg in enumerate(segments):
                if ring[-1] == seg[0]:
                    ring.extend(seg[1:])
                    segments.pop(i)
                    changed = True
                    break
                elif ring[-1] == seg[-1]:
                    ring.extend(reversed(seg[:-1]))
                    segments.pop(i)
                    changed = True
                    break
                elif ring[0] == seg[-1]:
                    ring = seg[:-1] + ring
                    segments.pop(i)
                    changed = True
                    break
                elif ring[0] == seg[0]:
                    ring = list(reversed(seg[1:])) + ring
                    segments.pop(i)
                    changed = True
                    break

        if ring[0] != ring[-1]:
            ring.append(ring[0])
        if len(ring) >= 4:
            rings.append(ring)

    return rings


def point_in_polygon(px, py, polygon):
    """Ray-casting point-in-polygon test. polygon is [[lon,lat], ...]."""
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def load_municipio_polygons(state_sigla):
    """Load municipio GeoJSON for point-in-polygon parent determination."""
    path = os.path.join(GEO_DIR, f"{state_sigla}-municipios.geojson")
    if not os.path.exists(path):
        print(f"Warning: {path} not found, skipping parent municipality assignment")
        return {}
    with open(path) as f:
        data = json.load(f)
    result = {}
    for feat in data["features"]:
        name = feat["properties"].get("name", "")
        geom = feat["geometry"]
        if geom["type"] == "Polygon":
            result[name] = geom["coordinates"]
        elif geom["type"] == "MultiPolygon":
            largest = max(geom["coordinates"], key=lambda p: len(p[0]))
            result[name] = largest
    return result


def find_parent_municipio(centroid_lon, centroid_lat, muni_polys):
    """Find which municipio polygon contains the given point."""
    for name, rings in muni_polys.items():
        if not rings:
            continue
        outer = rings[0]
        if point_in_polygon(centroid_lon, centroid_lat, outer):
            return name
    return None


def polygon_centroid(ring):
    """Compute centroid of a polygon ring [[lon,lat], ...]."""
    n = len(ring) - 1
    if n <= 0:
        return ring[0] if ring else (0, 0)
    cx = sum(p[0] for p in ring[:n]) / n
    cy = sum(p[1] for p in ring[:n]) / n
    return (cx, cy)


def supplement_with_ibge_2022(existing_features, state_abbrev, state_ibge_code):
    """Supplement OSM bairro features with IBGE 2022 Census neighborhood boundaries.

    Downloads from geoftp.ibge.gov.br: tries state-specific zip first, falls back
    to the full BR zip with a fiona SQL filter to avoid loading all Brazil into memory.

    Returns (new_features, replaced_keys) where:
      - new_features: list of GeoJSON Feature dicts to add
      - replaced_keys: set of (municipio_normalized, name_normalized) tuples for
        osm_node_approx features that should be replaced by the IBGE polygon
    """
    try:
        import geopandas as gpd
    except ImportError:
        print("geopandas not installed — skipping IBGE 2022 supplement")
        return [], set()

    state_abbrev_upper = state_abbrev.upper()
    state_abbrev_lower = state_abbrev.lower()

    rs_url = (
        f"zip+https://geoftp.ibge.gov.br/organizacao_do_territorio/malhas_territoriais/"
        f"malhas_de_setores_censitarios__divisoes_intramunicipais/censo_2022/bairros/shp/"
        f"UF/{state_abbrev_upper}/{state_abbrev_upper}_bairros_CD2022.zip"
    )
    br_url = (
        f"zip+https://geoftp.ibge.gov.br/organizacao_do_territorio/malhas_territoriais/"
        f"malhas_de_setores_censitarios__divisoes_intramunicipais/censo_2022/bairros/shp/"
        f"BR/BR_bairros_CD2022.zip"
    )

    print(f"\nFetching IBGE 2022 neighborhood boundaries for {state_abbrev_upper}...")

    gdf = None

    # Try state-specific zip first
    head_url = rs_url.replace("zip+", "")
    try:
        head_resp = requests.head(head_url, timeout=30, allow_redirects=True)
        if head_resp.status_code == 200:
            print(f"  Downloading state-specific zip: {head_url}")
            gdf = gpd.read_file(rs_url, timeout=60)
            print(f"  Got {len(gdf)} features from state-specific zip")
        else:
            print(f"  State-specific zip returned {head_resp.status_code}, falling back to BR zip")
    except Exception as e:
        print(f"  State-specific zip check failed ({e}), falling back to BR zip")

    if gdf is None:
        print(f"  Downloading BR zip with state filter CD_UF='{state_ibge_code}'...")
        try:
            gdf = gpd.read_file(br_url, where=f"CD_UF='{state_ibge_code}'", timeout=180)
            print(f"  Got {len(gdf)} features from BR zip (filtered by CD_UF={state_ibge_code})")
        except Exception as e:
            print(f"Failed to fetch IBGE 2022 data: {e}")
            return [], set()

    # Fail fast if expected columns are missing
    EXPECTED_COLS = {"NM_BAIRRO", "NM_MUN"}
    missing = EXPECTED_COLS - set(gdf.columns)
    assert not missing, (
        f"IBGE 2022 schema changed. Missing cols: {missing}. Found: {list(gdf.columns)}"
    )

    print(f"Columns in IBGE 2022 data: {list(gdf.columns)}")

    # Build deduplication index: (municipio_normalized, name_normalized) -> source
    existing_index = {
        (
            f["properties"].get("municipio_normalized", ""),
            f["properties"].get("name_normalized", ""),
        ): f["properties"].get("source", "real")
        for f in existing_features
    }

    new_features = []
    replaced_keys = set()

    for _, row in gdf.iterrows():
        name = row.get("NM_BAIRRO", "")
        mun_name = row.get("NM_MUN", "")
        # Guard against NaN (pandas float) values
        if not isinstance(name, str) or not isinstance(mun_name, str):
            continue
        name = name.strip()
        mun_name = mun_name.strip()
        if not name or not mun_name:
            continue

        geom = row.geometry
        if geom is None or geom.is_empty:
            continue

        name_norm = normalize_name(name)
        mun_norm = normalize_name(mun_name)
        key = (mun_norm, name_norm)

        existing_source = existing_index.get(key)

        if existing_source is not None and existing_source != "osm_node_approx":
            # Already have a real polygon — skip
            continue

        if existing_source == "osm_node_approx":
            # IBGE polygon is better than the approximate circle — mark for replacement
            replaced_keys.add(key)

        try:
            geojson_geom = geom.__geo_interface__
            geojson_geom = dict(geojson_geom)
            geojson_geom["coordinates"] = round_coords(geojson_geom["coordinates"])
        except Exception:
            continue

        feature = {
            "type": "Feature",
            "properties": {
                "name": name,
                "name_normalized": name_norm,
                "municipio": mun_name,
                "municipio_normalized": mun_norm,
                "source": "ibge_2022",
            },
            "geometry": geojson_geom,
        }
        new_features.append(feature)
        # Update index so subsequent duplicates within gdf are also deduplicated
        existing_index[key] = "ibge_2022"

    print(f"IBGE 2022: {len(new_features)} new features, {len(replaced_keys)} osm_node_approx replacements")
    return new_features, replaced_keys


def make_circle_polygon(lon, lat, radius_m=400, n_sides=16):
    """Generate an approximate circular polygon around a point (no shapely needed)."""
    import math
    lat_deg = 1 / 111320
    lon_deg = 1 / (111320 * math.cos(math.radians(lat)))
    coords = []
    for i in range(n_sides):
        angle = 2 * math.pi * i / n_sides
        coords.append([round(lon + radius_m * lon_deg * math.cos(angle), 5),
                       round(lat + radius_m * lat_deg * math.sin(angle), 5)])
    coords.append(coords[0])  # close ring
    return coords


def overpass_request(query, timeout_secs=600):
    """Send query to Overpass API (GET preferred, POST fallback), trying mirror URLs."""
    last_exc = None
    for url in OVERPASS_URLS:
        # Try GET first (avoids some 504s on certain load balancers)
        for method in ("get", "post"):
            try:
                if method == "get":
                    resp = requests.get(url, params={"data": query}, timeout=timeout_secs)
                else:
                    resp = requests.post(url, data={"data": query}, timeout=timeout_secs)
                resp.raise_for_status()
                return resp.json()
            except Exception as exc:
                last_exc = exc
                if method == "get":
                    continue  # try POST before moving to next URL
                print(f"  Overpass URL {url} (GET+POST) failed: {exc}")
                time.sleep(5)
    raise last_exc


def fetch_state_bairros(state_sigla):
    """Fetch and write bairro boundaries for a single state."""
    config = STATE_CONFIG[state_sigla]
    osm_name = config["osm_name"]
    ibge_code = config["ibge_code"]
    output_path = os.path.join(GEO_DIR, f"{state_sigla}-bairros.geojson")

    print(f"\n{'='*60}")
    print(f"Fetching bairro boundaries for {osm_name} ({state_sigla.upper()})...")
    print(f"Phase 1: fetching relation IDs + tags (lightweight)...")

    # Phase 1: get all relation IDs and tags (no geometry — small response)
    id_query = f"""
[out:json][timeout:120];
area["name"="{osm_name}"][admin_level=4]->.state;
rel(area.state)[admin_level=10][boundary=administrative];
out tags;
"""
    data = overpass_request(id_query, timeout_secs=180)
    id_elements = data.get("elements", [])
    print(f"Got {len(id_elements)} relations (tags only)")

    # Build map of relation_id -> tags for later lookup
    tags_by_id = {el["id"]: el.get("tags", {}) for el in id_elements if el.get("type") == "relation"}
    rel_ids = list(tags_by_id.keys())

    # Phase 2: fetch geometry in batches to avoid 504
    BATCH_SIZE = 50
    elements = []
    print(f"Phase 2: fetching geometry in batches of {BATCH_SIZE}...")
    for batch_start in range(0, len(rel_ids), BATCH_SIZE):
        batch = rel_ids[batch_start:batch_start + BATCH_SIZE]
        id_list = ",".join(str(i) for i in batch)
        geom_query = f"""
[out:json][timeout:120];
rel(id:{id_list});
out geom;
"""
        batch_num = batch_start // BATCH_SIZE + 1
        total_batches = (len(rel_ids) + BATCH_SIZE - 1) // BATCH_SIZE
        print(f"  Batch {batch_num}/{total_batches} ({len(batch)} relations)...")
        batch_data = overpass_request(geom_query, timeout_secs=180)
        batch_elements = batch_data.get("elements", [])
        # Re-attach tags from phase 1 (geometry response may omit some tags)
        for el in batch_elements:
            if el.get("id") in tags_by_id:
                el["tags"] = {**el.get("tags", {}), **tags_by_id[el["id"]]}
        elements.extend(batch_elements)
        # Brief pause between batches to respect rate limits
        if batch_start + BATCH_SIZE < len(rel_ids):
            time.sleep(2)

    print(f"Total elements with geometry: {len(elements)}")

    muni_polys = load_municipio_polygons(state_sigla)
    print(f"Loaded {len(muni_polys)} municipio polygons for parent assignment")

    features = []
    skipped = 0

    for el in elements:
        if el.get("type") != "relation":
            continue

        tags = el.get("tags", {})
        name = tags.get("name", "")
        if not name:
            skipped += 1
            continue

        members = el.get("members", [])
        rings = stitch_ways(members)
        if not rings:
            skipped += 1
            continue

        if len(rings) == 1:
            geometry = {"type": "Polygon", "coordinates": round_coords(rings)}
        else:
            geometry = {"type": "MultiPolygon", "coordinates": round_coords([[r] for r in rings])}

        municipio = tags.get("addr:city", "") or tags.get("is_in:city", "")
        if not municipio:
            is_in = tags.get("is_in", "")
            if is_in:
                parts = [p.strip() for p in is_in.split(",")]
                if parts:
                    municipio = parts[0]

        if not municipio and muni_polys:
            cx, cy = polygon_centroid(rings[0])
            parent = find_parent_municipio(cx, cy, muni_polys)
            if parent:
                municipio = parent

        name_normalized = normalize_name(name)
        municipio_normalized = normalize_name(municipio) if municipio else ""

        feature = {
            "type": "Feature",
            "properties": {
                "name": name,
                "name_normalized": name_normalized,
                "municipio": municipio,
                "municipio_normalized": municipio_normalized,
            },
            "geometry": geometry,
        }
        features.append(feature)

    print(f"OSM admin_level=10 features: {len(features)}, skipped: {skipped}")

    # Phase 3: fetch place=suburb/neighbourhood ways and relations
    print(f"\nPhase 3: fetching place=suburb/neighbourhood features...")
    place_query = f"""
[out:json][timeout:300];
area["name"="{osm_name}"][admin_level=4]->.state;
(
  way[place~"^(suburb|neighbourhood)$"](area.state);
  rel[place~"^(suburb|neighbourhood)$"](area.state);
);
out geom;
"""
    place_data = overpass_request(place_query, timeout_secs=360)
    place_elements = place_data.get("elements", [])
    print(f"Got {len(place_elements)} place-tagged elements")

    # Build dedup set from existing admin_level=10 features (admin_level=10 wins on collision)
    existing_keys = set()
    for feat in features:
        props = feat["properties"]
        existing_keys.add((props.get("municipio_normalized", ""), props.get("name_normalized", "")))

    place_added = 0
    place_skipped = 0

    for el in place_elements:
        tags = el.get("tags", {})
        name = tags.get("name", "")
        if not name:
            place_skipped += 1
            continue

        el_type = el.get("type")

        if el_type == "way":
            geom_nodes = el.get("geometry", [])
            if not geom_nodes:
                place_skipped += 1
                continue
            ring = [(round(n["lon"], 5), round(n["lat"], 5)) for n in geom_nodes]
            # Must be closed (first == last) and have at least 4 vertices
            if len(ring) < 4 or ring[0] != ring[-1]:
                place_skipped += 1
                continue
            rings = [ring]
            geometry = {"type": "Polygon", "coordinates": round_coords(rings)}

        elif el_type == "relation":
            members = el.get("members", [])
            rings = stitch_ways(members)
            if not rings:
                place_skipped += 1
                continue
            if len(rings) == 1:
                geometry = {"type": "Polygon", "coordinates": round_coords(rings)}
            else:
                geometry = {"type": "MultiPolygon", "coordinates": round_coords([[r] for r in rings])}
        else:
            place_skipped += 1
            continue

        # Municipality assignment: tags first, then PIP fallback
        municipio = tags.get("addr:city", "") or tags.get("is_in:city", "")
        if not municipio:
            is_in = tags.get("is_in", "")
            if is_in:
                parts = [p.strip() for p in is_in.split(",")]
                if parts:
                    municipio = parts[0]

        if not municipio and muni_polys:
            cx, cy = polygon_centroid(rings[0])
            parent = find_parent_municipio(cx, cy, muni_polys)
            if parent:
                municipio = parent

        name_normalized = normalize_name(name)
        municipio_normalized = normalize_name(municipio) if municipio else ""

        key = (municipio_normalized, name_normalized)
        if key in existing_keys:
            place_skipped += 1
            continue

        feature = {
            "type": "Feature",
            "properties": {
                "name": name,
                "name_normalized": name_normalized,
                "municipio": municipio,
                "municipio_normalized": municipio_normalized,
            },
            "geometry": geometry,
        }
        features.append(feature)
        existing_keys.add(key)
        place_added += 1

    print(f"Place-tagged features: added {place_added}, skipped {place_skipped}")

    # Phase 4: fetch place=suburb/neighbourhood nodes (no polygon geometry)
    # Generate approximate circular polygon (~400m radius) for each missing node
    # Skip nodes whose center falls inside an existing polygon bairro (same municipality)
    print(f"\nPhase 4: fetching place=suburb/neighbourhood nodes (point-only features)...")
    node_query = f"""
[out:json][timeout:120];
area["name"="{osm_name}"][admin_level=4]->.state;
node[place~"^(suburb|neighbourhood)$"](area.state);
out tags center;
"""
    node_data = overpass_request(node_query, timeout_secs=180)
    node_elements = node_data.get("elements", [])
    print(f"Got {len(node_elements)} place-tagged nodes")

    # Build per-municipality index of existing polygon outer rings for containment check.
    # Nodes inside an existing polygon get a tiny radius (50m) — just enough for name
    # matching and a map dot — to avoid visually overlapping the parent polygon.
    # Nodes outside all polygons get the full 400m radius.
    from collections import defaultdict
    bairro_polys_by_muni = defaultdict(list)
    for feat in features:
        muni_norm = feat["properties"].get("municipio_normalized", "")
        geom = feat["geometry"]
        if geom["type"] == "Polygon":
            bairro_polys_by_muni[muni_norm].append(geom["coordinates"][0])
        elif geom["type"] == "MultiPolygon":
            for poly in geom["coordinates"]:
                bairro_polys_by_muni[muni_norm].append(poly[0])

    node_added = 0
    node_skipped = 0
    node_inside = 0

    for el in node_elements:
        if el.get("type") != "node":
            node_skipped += 1
            continue

        tags = el.get("tags", {})
        name = tags.get("name", "")
        if not name:
            node_skipped += 1
            continue

        lon = el.get("lon")
        lat = el.get("lat")
        if lon is None or lat is None:
            node_skipped += 1
            continue

        # Municipality assignment: tags first, then PIP fallback
        municipio = tags.get("addr:city", "") or tags.get("is_in:city", "")
        if not municipio:
            is_in = tags.get("is_in", "")
            if is_in:
                parts = [p.strip() for p in is_in.split(",")]
                if parts:
                    municipio = parts[0]

        if not municipio and muni_polys:
            parent = find_parent_municipio(lon, lat, muni_polys)
            if parent:
                municipio = parent

        name_normalized = normalize_name(name)
        municipio_normalized = normalize_name(municipio) if municipio else ""

        key = (municipio_normalized, name_normalized)
        if key in existing_keys:
            node_skipped += 1
            continue

        # If node center falls inside an existing polygon bairro, use tiny radius (50m)
        # to avoid visual overlap. Full radius (400m) for genuinely uncovered areas.
        inside_existing = False
        for ring in bairro_polys_by_muni.get(municipio_normalized, []):
            if point_in_polygon(lon, lat, ring):
                inside_existing = True
                break
        if inside_existing:
            node_inside += 1

        radius = 50 if inside_existing else 400
        coords = make_circle_polygon(lon, lat, radius_m=radius)
        feature = {
            "type": "Feature",
            "properties": {
                "name": name,
                "name_normalized": name_normalized,
                "municipio": municipio,
                "municipio_normalized": municipio_normalized,
                "source": "osm_node_approx",
            },
            "geometry": {"type": "Polygon", "coordinates": [coords]},
        }
        features.append(feature)
        existing_keys.add(key)
        node_added += 1

    print(f"Node-approx features: added {node_added}, skipped {node_skipped}, inside existing (50m radius): {node_inside}")

    # Supplement with IBGE data
    features = supplement_with_ibge(features, ibge_code)

    geojson = {"type": "FeatureCollection", "features": features}

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(geojson, f, separators=(",", ":"))

    # Also copy to backend/bairro-geo/ (baked into Docker image)
    backend_geo_dir = os.path.join(PROJECT_ROOT, "backend", "bairro-geo")
    backend_output_path = os.path.join(backend_geo_dir, f"{state_sigla}-bairros.geojson")
    if os.path.exists(backend_geo_dir):
        with open(backend_output_path, "w") as f:
            json.dump(geojson, f, separators=(",", ":"))
        print(f"Also wrote backend copy to {backend_output_path}")

    file_size = os.path.getsize(output_path)
    print(f"\nDone! Wrote {len(features)} bairro features to {output_path}")
    print(f"File size: {file_size / 1024:.0f} KB")

    with_muni = sum(1 for f in features if f["properties"]["municipio"])
    without_muni = len(features) - with_muni
    print(f"With parent municipality: {with_muni}")
    print(f"Without parent municipality: {without_muni}")

    return len(features)


def main():
    args = sys.argv[1:] if len(sys.argv) > 1 else ["rs"]

    if "all" in args:
        states = list(STATE_CONFIG.keys())
    else:
        states = [s.lower() for s in args]
        invalid = [s for s in states if s not in STATE_CONFIG]
        if invalid:
            print(f"Unknown states: {invalid}. Available: {list(STATE_CONFIG.keys())}")
            sys.exit(1)

    total = 0
    for state in states:
        count = fetch_state_bairros(state)
        total += count
        # Rate limit between requests
        if state != states[-1]:
            print("\nWaiting 30s between Overpass requests (rate limiting)...")
            time.sleep(30)

    print(f"\n{'='*60}")
    print(f"All done! Total bairro features across {len(states)} state(s): {total}")


if __name__ == "__main__":
    main()
