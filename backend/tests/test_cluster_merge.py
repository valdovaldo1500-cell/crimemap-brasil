"""Snapshot tests for cluster-merge logic.

Verifies that the clustering algorithm produces stable output for
known input points — catches the bug where polygon-matched bairros
got absorbed into 'Bairro desconhecido' clusters.
"""
import os
import sys
import math
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from main import _point_in_polygon


def _haversine_km(lat1, lon1, lat2, lon2):
    """Haversine distance in km (matches main.py implementation)."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * 2 * math.asin(math.sqrt(a))


class _FakePoint:
    """Minimal stand-in for HeatmapPoint for testing cluster logic."""
    def __init__(self, lat, lng, weight, municipio, bairro):
        self.latitude = lat
        self.longitude = lng
        self.weight = weight
        self.municipio = municipio
        self.bairro = bairro
        self.components = None


def _cluster_merge(pts, polygon_matched_keys, threshold_km=0.3):
    """Extracted cluster-merge logic from heatmap_bairros endpoint."""
    from main import normalize_name

    assigned = [False] * len(pts)
    clusters = []
    for i in range(len(pts)):
        if assigned[i]:
            continue
        cluster = [i]
        assigned[i] = True
        for j in range(i + 1, len(pts)):
            if assigned[j]:
                continue
            seed_bairro = normalize_name(pts[cluster[0]].bairro or "")
            j_bairro = normalize_name(pts[j].bairro or "")
            seed_mun = normalize_name(pts[cluster[0]].municipio or "")
            j_mun = normalize_name(pts[j].municipio or "")
            seed_has_poly = (seed_mun, seed_bairro) in polygon_matched_keys
            j_has_poly = (j_mun, j_bairro) in polygon_matched_keys
            if seed_has_poly or j_has_poly:
                continue
            for ci in cluster:
                if _haversine_km(pts[ci].latitude, pts[ci].longitude,
                                 pts[j].latitude, pts[j].longitude) <= threshold_km:
                    cluster.append(j)
                    assigned[j] = True
                    break
        clusters.append(cluster)
    return clusters


class TestHaversine:
    def test_same_point(self):
        assert _haversine_km(0, 0, 0, 0) == 0.0

    def test_known_distance(self):
        # POA to Canoas is ~15km
        d = _haversine_km(-30.03, -51.23, -29.92, -51.18)
        assert 10 < d < 20

    def test_close_points(self):
        # ~100m apart
        d = _haversine_km(-30.0, -51.0, -30.001, -51.0)
        assert d < 0.2  # less than 200m


class TestClusterMerge:
    """Snapshot tests for cluster merge behavior."""

    def test_nearby_non_polygon_points_merge(self):
        """Two non-polygon points within 0.3km should merge."""
        pts = [
            _FakePoint(-30.03, -51.23, 100, "PORTO ALEGRE", "UNKNOWN A"),
            _FakePoint(-30.0301, -51.2301, 50, "PORTO ALEGRE", "UNKNOWN B"),
        ]
        clusters = _cluster_merge(pts, set())
        assert len(clusters) == 1
        assert len(clusters[0]) == 2

    def test_distant_points_stay_separate(self):
        """Two points >0.3km apart should not merge."""
        pts = [
            _FakePoint(-30.03, -51.23, 100, "PORTO ALEGRE", "A"),
            _FakePoint(-30.04, -51.24, 50, "PORTO ALEGRE", "B"),  # ~1.3km away
        ]
        clusters = _cluster_merge(pts, set())
        assert len(clusters) == 2

    def test_polygon_matched_never_merges(self):
        """Polygon-matched bairros should NEVER be merged, even if close."""
        pts = [
            _FakePoint(-30.03, -51.23, 100, "PORTO ALEGRE", "CENTRO"),
            _FakePoint(-30.0301, -51.2301, 50, "PORTO ALEGRE", "FLORESTA"),
        ]
        polygon_matched = {
            ("PORTO ALEGRE", "CENTRO"),
            ("PORTO ALEGRE", "FLORESTA"),
        }
        clusters = _cluster_merge(pts, polygon_matched)
        assert len(clusters) == 2, "Polygon-matched bairros were incorrectly merged"

    def test_polygon_seed_protects_cluster(self):
        """If the seed of a cluster is polygon-matched, nothing merges into it."""
        pts = [
            _FakePoint(-30.03, -51.23, 100, "PORTO ALEGRE", "CENTRO"),
            _FakePoint(-30.0301, -51.2301, 50, "PORTO ALEGRE", "Bairro desconhecido"),
        ]
        polygon_matched = {("PORTO ALEGRE", "CENTRO")}
        clusters = _cluster_merge(pts, polygon_matched)
        assert len(clusters) == 2

    def test_mixed_polygon_and_non_polygon(self):
        """Non-polygon points near each other merge; polygon point stays separate."""
        pts = [
            _FakePoint(-30.03, -51.23, 100, "PORTO ALEGRE", "CENTRO"),       # polygon
            _FakePoint(-30.0301, -51.2301, 50, "PORTO ALEGRE", "UNKNOWN A"), # non-polygon, close to CENTRO
            _FakePoint(-30.0302, -51.2302, 30, "PORTO ALEGRE", "UNKNOWN B"), # non-polygon, close to A
        ]
        polygon_matched = {("PORTO ALEGRE", "CENTRO")}
        clusters = _cluster_merge(pts, polygon_matched)
        # CENTRO stays alone; UNKNOWN A+B merge together
        assert len(clusters) == 2
        sizes = sorted([len(c) for c in clusters])
        assert sizes == [1, 2]

    def test_snapshot_known_config(self):
        """Snapshot: 5 points in known positions produce exactly 3 clusters."""
        pts = [
            _FakePoint(-30.030, -51.230, 100, "POA", "A"),  # cluster 1
            _FakePoint(-30.0301, -51.2301, 50, "POA", "B"), # cluster 1 (close to A)
            _FakePoint(-30.040, -51.240, 80, "POA", "C"),   # cluster 2 (far)
            _FakePoint(-30.050, -51.250, 60, "POA", "D"),   # cluster 3 (far)
            _FakePoint(-30.0501, -51.2501, 40, "POA", "E"), # cluster 3 (close to D)
        ]
        clusters = _cluster_merge(pts, set())
        assert len(clusters) == 3
        sizes = sorted([len(c) for c in clusters])
        assert sizes == [1, 2, 2]


class TestPointInPolygon:
    """Basic PIP tests."""

    def test_inside_triangle(self):
        triangle = [[0, 0], [10, 0], [5, 10], [0, 0]]
        assert _point_in_polygon(5, 3, triangle) is True

    def test_outside_triangle(self):
        triangle = [[0, 0], [10, 0], [5, 10], [0, 0]]
        assert _point_in_polygon(20, 20, triangle) is False

    def test_inside_square(self):
        square = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
        assert _point_in_polygon(5, 5, square) is True
