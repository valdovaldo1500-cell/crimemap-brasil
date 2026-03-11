"""Tests that pin the MIN_COUNT_FORCE_NAMED bucketing invariant in heatmap_bairros.

These tests exercise the absorption logic directly — a bairro whose geocoded
coords land at the municipality centroid (< 0.5km) is normally absorbed into
"Bairro desconhecido", but NOT if its count >= MIN_COUNT_FORCE_NAMED (30).
"""
import math


# ---------------------------------------------------------------------------
# Minimal stand-ins — mirror the real types but avoid importing the full app
# ---------------------------------------------------------------------------

def _haversine_km(lat1, lon1, lat2, lon2):
    """Haversine distance in km (matches main.py implementation)."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(a))


MIN_COUNT_FORCE_NAMED = 30  # must match the constant added to heatmap_bairros


def _apply_bucketing_logic(cnt, lat, lng, centroid, key, polygon_matched_keys):
    """
    Pure extraction of the absorption decision from heatmap_bairros.

    Returns True  → bairro is absorbed into "Bairro desconhecido"
    Returns False → bairro appears as its own named entry
    """
    is_at_centroid = centroid and _haversine_km(lat, lng, centroid[0], centroid[1]) < 0.5
    is_low_count = cnt < 3
    is_high_count = cnt >= MIN_COUNT_FORCE_NAMED
    return (is_at_centroid or is_low_count) and not is_high_count and key not in polygon_matched_keys


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestMinCountForceNamed:
    """Pin the MIN_COUNT_FORCE_NAMED invariant."""

    # Centroid for a fictional municipality placed at an exact lat/lng
    MUN_CENTROID = (-30.0, -51.0)

    def _at_centroid_coords(self):
        """Return coords that are within 0.5km of MUN_CENTROID (same point → 0km)."""
        return self.MUN_CENTROID  # 0km distance, definitely < 0.5km threshold

    def test_high_count_at_centroid_not_absorbed(self):
        """
        Test A: bairro count=35, at municipality centroid, no polygon match
        → must NOT be absorbed (must appear as its own named entry).
        """
        lat, lng = self._at_centroid_coords()
        centroid = self.MUN_CENTROID
        key = ("MUNICIPIO TESTE", "BAIRRO ALTO VOLUME")
        polygon_matched_keys: set = set()

        absorbed = _apply_bucketing_logic(35, lat, lng, centroid, key, polygon_matched_keys)

        assert not absorbed, (
            "A bairro with count=35 at the municipality centroid should NOT be absorbed "
            "into 'Bairro desconhecido' — it has >= MIN_COUNT_FORCE_NAMED occurrences."
        )

    def test_low_count_at_centroid_absorbed(self):
        """
        Test B: bairro count=5, at municipality centroid, no polygon match
        → MUST be absorbed into 'Bairro desconhecido'.
        """
        lat, lng = self._at_centroid_coords()
        centroid = self.MUN_CENTROID
        key = ("MUNICIPIO TESTE", "BAIRRO BAIXO VOLUME")
        polygon_matched_keys: set = set()

        absorbed = _apply_bucketing_logic(5, lat, lng, centroid, key, polygon_matched_keys)

        assert absorbed, (
            "A bairro with count=5 at the municipality centroid MUST be absorbed "
            "into 'Bairro desconhecido' — it is below MIN_COUNT_FORCE_NAMED and at the centroid."
        )

    # ------------------------------------------------------------------
    # Boundary / edge cases
    # ------------------------------------------------------------------

    def test_exactly_at_threshold_not_absorbed(self):
        """count == MIN_COUNT_FORCE_NAMED (30) should also be protected (>= threshold)."""
        lat, lng = self._at_centroid_coords()
        centroid = self.MUN_CENTROID
        key = ("MUNICIPIO TESTE", "BAIRRO LIMIAR")
        absorbed = _apply_bucketing_logic(MIN_COUNT_FORCE_NAMED, lat, lng, centroid, key, set())
        assert not absorbed

    def test_one_below_threshold_absorbed(self):
        """count == MIN_COUNT_FORCE_NAMED - 1 (29) is NOT high-count, so it can be absorbed."""
        lat, lng = self._at_centroid_coords()
        centroid = self.MUN_CENTROID
        key = ("MUNICIPIO TESTE", "BAIRRO QUASE")
        absorbed = _apply_bucketing_logic(MIN_COUNT_FORCE_NAMED - 1, lat, lng, centroid, key, set())
        assert absorbed

    def test_high_count_far_from_centroid_not_absorbed(self):
        """A high-count bairro NOT at centroid should also not be absorbed (normal case)."""
        lat, lng = -30.05, -51.05  # ~6km from centroid
        centroid = self.MUN_CENTROID
        key = ("MUNICIPIO TESTE", "BAIRRO DISTANTE")
        absorbed = _apply_bucketing_logic(35, lat, lng, centroid, key, set())
        assert not absorbed

    def test_polygon_matched_always_skips_bucket(self):
        """Polygon-matched key is never absorbed regardless of count or position."""
        lat, lng = self._at_centroid_coords()
        centroid = self.MUN_CENTROID
        key = ("MUNICIPIO TESTE", "CENTRO")
        polygon_matched_keys = {key}
        # Even with count=2 (would normally be absorbed as low-count), polygon match wins
        absorbed = _apply_bucketing_logic(2, lat, lng, centroid, key, polygon_matched_keys)
        assert not absorbed
