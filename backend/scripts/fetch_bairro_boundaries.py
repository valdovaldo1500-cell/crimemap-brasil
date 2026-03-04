#!/usr/bin/env python3
"""Fetch bairro (admin_level=10) boundaries from OSM Overpass for Rio Grande do Sul.

Produces frontend/public/geo/rs-bairros.geojson with polygon geometries
and normalized name properties for choropleth matching.

Usage:
    python backend/scripts/fetch_bairro_boundaries.py
"""
import json, math, os, sys, time, unicodedata
import requests

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
QUERY = """
[out:json][timeout:180];
area["name"="Rio Grande do Sul"][admin_level=4]->.rs;
rel(area.rs)[admin_level=10][boundary=administrative];
out geom;
"""

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
MUNICIPIOS_PATH = os.path.join(PROJECT_ROOT, "frontend", "public", "geo", "rs-municipios.geojson")
OUTPUT_PATH = os.path.join(PROJECT_ROOT, "frontend", "public", "geo", "rs-bairros.geojson")


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
    """Stitch outer way segments into closed rings.
    Each member has .geometry as a list of {lat, lon} nodes.
    Returns list of rings (each ring is a list of [lon, lat] pairs).
    """
    # Collect outer way segments
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

        # Close ring if needed
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        # GeoJSON rings need >= 4 points
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


def load_municipio_polygons():
    """Load municipio GeoJSON for point-in-polygon parent determination."""
    if not os.path.exists(MUNICIPIOS_PATH):
        print(f"Warning: {MUNICIPIOS_PATH} not found, skipping parent municipality assignment")
        return {}
    with open(MUNICIPIOS_PATH) as f:
        data = json.load(f)
    result = {}
    for feat in data["features"]:
        name = feat["properties"].get("name", "")
        geom = feat["geometry"]
        if geom["type"] == "Polygon":
            result[name] = geom["coordinates"]
        elif geom["type"] == "MultiPolygon":
            # Use largest polygon
            largest = max(geom["coordinates"], key=lambda p: len(p[0]))
            result[name] = largest
    return result


def find_parent_municipio(centroid_lon, centroid_lat, muni_polys):
    """Find which municipio polygon contains the given point."""
    for name, rings in muni_polys.items():
        if not rings:
            continue
        outer = rings[0]  # First ring is the outer boundary
        if point_in_polygon(centroid_lon, centroid_lat, outer):
            return name
    return None


def polygon_centroid(ring):
    """Compute centroid of a polygon ring [[lon,lat], ...]."""
    n = len(ring) - 1  # Exclude closing point
    if n <= 0:
        return ring[0] if ring else (0, 0)
    cx = sum(p[0] for p in ring[:n]) / n
    cy = sum(p[1] for p in ring[:n]) / n
    return (cx, cy)


def main():
    print("Fetching bairro boundaries from Overpass API...")
    print("This may take a minute or two...")

    resp = requests.post(OVERPASS_URL, data={"data": QUERY}, timeout=300)
    resp.raise_for_status()
    data = resp.json()

    elements = data.get("elements", [])
    print(f"Got {len(elements)} relations from Overpass")

    muni_polys = load_municipio_polygons()
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

        # Determine geometry type
        if len(rings) == 1:
            geometry = {"type": "Polygon", "coordinates": round_coords(rings)}
        else:
            geometry = {"type": "MultiPolygon", "coordinates": round_coords([[r] for r in rings])}

        # Determine parent municipality
        # 1. Try tags first
        municipio = tags.get("addr:city", "") or tags.get("is_in:city", "")
        if not municipio:
            # Check is_in tag
            is_in = tags.get("is_in", "")
            if is_in:
                # is_in often looks like "Porto Alegre, Rio Grande do Sul, Brasil"
                parts = [p.strip() for p in is_in.split(",")]
                if parts:
                    municipio = parts[0]

        # 2. Fall back to point-in-polygon
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

    geojson = {"type": "FeatureCollection", "features": features}

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(geojson, f, separators=(",", ":"))

    file_size = os.path.getsize(OUTPUT_PATH)
    print(f"\nDone! Wrote {len(features)} bairro features to {OUTPUT_PATH}")
    print(f"File size: {file_size / 1024:.0f} KB")
    print(f"Skipped: {skipped} relations (missing name or geometry)")

    # Stats
    with_muni = sum(1 for f in features if f["properties"]["municipio"])
    without_muni = len(features) - with_muni
    print(f"With parent municipality: {with_muni}")
    print(f"Without parent municipality: {without_muni}")


if __name__ == "__main__":
    main()
