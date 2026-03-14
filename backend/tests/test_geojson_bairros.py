"""
Tests for rs-bairros.geojson spatial integrity.

Checks:
1. No bairro polygon centroid falls inside another bairro polygon (contained loteamentos).
2. No bairro polygon is invisibly tiny (< 0.001 km²).

The RS GeoJSON has ~1354 contained loteamentos and ~865 small polygons — this is a
known upstream data quality issue. These tests use regression-detection: they fail if
the COUNT INCREASES above the established baselines, preventing new contamination while
documenting the existing debt.

To see the full list of contained bairros, run with -s:
  python3 -m pytest tests/test_geojson_bairros.py -v -s
"""
import json
import math
import os
from collections import defaultdict

import pytest
from shapely.geometry import shape

GEOJSON_PATH = os.path.join(os.path.dirname(__file__), "../bairro-geo/rs-bairros.geojson")

# Regression baselines — update these if GeoJSON is intentionally cleaned up.
# Fail if count EXCEEDS baseline (regression), not if it equals it (known debt).
CONTAINED_BASELINE = 1360   # ~1354 as of 2026-03-14
TINY_BASELINE = 870         # ~865 as of 2026-03-14

# Only flag truly invisible polygons (< 0.001 km² ≈ 100m × 100m)
MIN_AREA_KM2 = 0.001


@pytest.fixture(scope="module")
def bairro_features():
    if not os.path.exists(GEOJSON_PATH):
        pytest.skip("rs-bairros.geojson not found")
    with open(GEOJSON_PATH, encoding="utf-8") as f:
        data = json.load(f)
    return data["features"]


def _area_km2(geom):
    """Rough area in km² via degree-to-km at RS latitude (~-28°)."""
    lat_mid = (geom.bounds[1] + geom.bounds[3]) / 2
    km_per_deg_lat = 111.32
    km_per_deg_lon = 111.32 * math.cos(math.radians(lat_mid))
    env = geom.envelope
    env_area_km2 = env.area * km_per_deg_lat * km_per_deg_lon
    ratio = geom.area / env.area if env.area > 0 else 1
    return env_area_km2 * ratio


def test_tiny_bairros_no_regression(bairro_features):
    """
    Count of bairros below MIN_AREA_KM2 must not exceed TINY_BASELINE.

    A count below baseline is good (cleanup progress). A count above baseline
    means new micro-polygons were added and should be investigated.
    """
    tiny = []
    for feat in bairro_features:
        props = feat["properties"]
        name = props.get("nome") or props.get("name") or ""
        municipio = props.get("municipio", "")
        geom = shape(feat["geometry"])
        if _area_km2(geom) < MIN_AREA_KM2:
            tiny.append(f"  {name!r} ({municipio}): {_area_km2(geom):.5f} km²")

    print(f"\n[tiny bairros < {MIN_AREA_KM2} km²]: {len(tiny)} found (baseline {TINY_BASELINE})")
    if tiny[:20]:
        print("\n".join(tiny[:20]))
        if len(tiny) > 20:
            print(f"  ... and {len(tiny) - 20} more")

    assert len(tiny) <= TINY_BASELINE, (
        f"Regression: {len(tiny)} tiny bairros > baseline {TINY_BASELINE}. "
        f"New polygons added below {MIN_AREA_KM2} km²?"
    )


def test_contained_bairros_no_regression(bairro_features):
    """
    Count of bairros whose centroid falls inside another bairro polygon must not
    exceed CONTAINED_BASELINE.

    These are loteamentos/subdivisions embedded inside larger bairros. Ideal fix
    is to merge them server-side in heatmap_bairros. Run with -s to see the full list.
    """
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
                    contained.append(f"  '{name_i}' inside '{name_j}' ({municipio})")
                    break

    print(f"\n[contained bairros]: {len(contained)} found (baseline {CONTAINED_BASELINE})")
    if contained[:20]:
        print("\n".join(contained[:20]))
        if len(contained) > 20:
            print(f"  ... and {len(contained) - 20} more")

    assert len(contained) <= CONTAINED_BASELINE, (
        f"Regression: {len(contained)} contained bairros > baseline {CONTAINED_BASELINE}. "
        f"New loteamentos added inside other bairros?"
    )


def test_loteamento_parque_farroupilha_is_contained(bairro_features):
    """
    Specific regression: 'Loteamento Parque Farroupilha' in Passo Fundo is
    contained inside another bairro. This test documents the known case and
    will fail if it's ever fixed (confirming the fix worked).
    """
    by_muni = defaultdict(list)
    for feat in bairro_features:
        props = feat["properties"]
        name = props.get("nome") or props.get("name") or ""
        municipio = props.get("municipio", "")
        geom = shape(feat["geometry"])
        by_muni[municipio].append((name, geom))

    pf_entries = by_muni.get("PASSO FUNDO", [])
    target = next(
        ((name, geom) for name, geom in pf_entries
         if "LOTEAMENTO PARQUE FARROUPILHA" in name.upper()),
        None,
    )
    if target is None:
        pytest.skip("Loteamento Parque Farroupilha not found in GeoJSON (may have been merged)")

    name_t, geom_t = target
    centroid = geom_t.centroid
    container = next(
        (name_j for name_j, geom_j in pf_entries
         if name_j != name_t and geom_j.contains(centroid)),
        None,
    )
    assert container is not None, (
        f"'{name_t}' is no longer contained inside another Passo Fundo bairro — "
        f"the GeoJSON may have been fixed! Update this test."
    )
    print(f"\n  '{name_t}' is contained inside '{container}' (Passo Fundo) — known issue")
