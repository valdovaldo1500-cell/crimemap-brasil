#!/usr/bin/env python3
"""Generate bairro_centroids.json from all bairro GeoJSON files.

Reads rs/rj/mg-bairros.geojson, computes bounding-box center for each polygon,
and writes {municipio_normalized: {bairro_normalized: [lat, lng]}} to backend/bairro_centroids.json.
"""
import json
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(SCRIPT_DIR)
GEO_DIR = os.path.join(BACKEND_DIR, "bairro-geo")
OUTPUT = os.path.join(BACKEND_DIR, "bairro_centroids.json")

GEOJSON_FILES = [
    os.path.join(GEO_DIR, "rs-bairros.geojson"),
    os.path.join(GEO_DIR, "rj-bairros.geojson"),
    os.path.join(GEO_DIR, "mg-bairros.geojson"),
]


def bbox_center(geometry):
    """Compute bounding box center (same as Leaflet getBounds().getCenter())."""
    coords = geometry["coordinates"]
    # Flatten: Polygon = [ring, ...], MultiPolygon = [[ring, ...], ...]
    if geometry["type"] == "MultiPolygon":
        points = [pt for poly in coords for ring in poly for pt in ring]
    else:
        points = [pt for ring in coords for pt in ring]

    lngs = [p[0] for p in points]
    lats = [p[1] for p in points]
    return [(min(lats) + max(lats)) / 2, (min(lngs) + max(lngs)) / 2]


def main():
    centroids = {}  # {municipio_normalized: {bairro_normalized: [lat, lng]}}
    total = 0

    for path in GEOJSON_FILES:
        if not os.path.exists(path):
            print(f"SKIP (not found): {path}")
            continue
        with open(path) as f:
            data = json.load(f)
        count = 0
        for feat in data["features"]:
            props = feat["properties"]
            mun = props["municipio_normalized"]
            bairro = props["name_normalized"]
            center = bbox_center(feat["geometry"])
            centroids.setdefault(mun, {})[bairro] = center
            count += 1
        print(f"{os.path.basename(path)}: {count} features")
        total += count

    with open(OUTPUT, "w") as f:
        json.dump(centroids, f, separators=(",", ":"))

    mun_count = len(centroids)
    print(f"\nWrote {OUTPUT}")
    print(f"Total: {mun_count} municipios, {total} bairros")


if __name__ == "__main__":
    main()
