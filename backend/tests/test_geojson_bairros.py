"""
Tests for rs-bairros.geojson spatial integrity.

Checks:
1. No bairro polygon is entirely contained within another bairro polygon.
2. No bairro polygon has area below a minimum threshold (0.05 km²).

These catch loteamentos/micro-bairros that should be merged into their
containing bairro before rendering.
"""
import json
import os
import pytest
from shapely.geometry import shape, Point, mapping
from shapely.ops import unary_union

GEOJSON_PATH = os.path.join(os.path.dirname(__file__), "../../bairro-geo/rs-bairros.geojson")
MIN_AREA_KM2 = 0.05  # polygons smaller than this are flagged


@pytest.fixture(scope="module")
def bairro_features():
    if not os.path.exists(GEOJSON_PATH):
        pytest.skip("rs-bairros.geojson not found")
    with open(GEOJSON_PATH, encoding="utf-8") as f:
        data = json.load(f)
    return data["features"]


def _area_km2(geom):
    """Rough area in km² using degree-to-km conversion at RS latitude (~-28°)."""
    # 1 degree lat ≈ 111.32 km; 1 degree lon ≈ 111.32 * cos(lat) km ≈ 98 km at -28°
    bounds = geom.bounds  # (minx, miny, maxx, maxy)
    lat_mid = (bounds[1] + bounds[3]) / 2
    import math
    km_per_deg_lat = 111.32
    km_per_deg_lon = 111.32 * math.cos(math.radians(lat_mid))
    # Use envelope area as rough estimate, then scale by actual/envelope ratio
    env = geom.envelope
    env_area = env.area  # in degrees²
    env_area_km2 = env_area * km_per_deg_lat * km_per_deg_lon
    actual_ratio = geom.area / env.area if env.area > 0 else 1
    return env_area_km2 * actual_ratio


def test_no_tiny_bairros(bairro_features):
    """All bairro polygons must be at least MIN_AREA_KM2 km²."""
    tiny = []
    for feat in bairro_features:
        name = feat["properties"].get("nome") or feat["properties"].get("name") or str(feat["properties"])
        municipio = feat["properties"].get("municipio", "")
        geom = shape(feat["geometry"])
        area = _area_km2(geom)
        if area < MIN_AREA_KM2:
            tiny.append(f"{name} ({municipio}): {area:.4f} km²")
    assert not tiny, (
        f"Found {len(tiny)} bairro polygon(s) below {MIN_AREA_KM2} km² threshold "
        f"(likely loteamentos that should be merged):\n" + "\n".join(tiny)
    )


def test_no_contained_bairros(bairro_features):
    """No bairro polygon centroid should fall strictly inside another bairro polygon."""
    # Build list of (name, municipio, geom) per same municipio for efficiency
    from collections import defaultdict
    by_muni = defaultdict(list)
    for feat in bairro_features:
        props = feat["properties"]
        name = props.get("nome") or props.get("name") or ""
        municipio = props.get("municipio", "")
        geom = shape(feat["geometry"])
        by_muni[municipio].append((name, geom))

    contained = []
    for municipio, entries in by_muni.items():
        for i, (name_i, geom_i) in enumerate(entries):
            centroid_i = geom_i.centroid
            for j, (name_j, geom_j) in enumerate(entries):
                if i == j:
                    continue
                if geom_j.contains(centroid_i):
                    contained.append(
                        f"'{name_i}' centroid is inside '{name_j}' ({municipio})"
                    )
                    break  # only report first container

    assert not contained, (
        f"Found {len(contained)} bairro(s) whose centroid is inside another bairro polygon "
        f"(should be merged into the containing bairro):\n" + "\n".join(contained)
    )
