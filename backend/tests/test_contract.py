"""Contract tests — verify consistency between related API endpoints.

These catch the count-mismatch bugs where heatmap shows one number
but the detail panel shows another for the same location+filters.
"""
import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

# Use broad time window to ensure data is present regardless of DB freshness
_BROAD_PARAMS = {"ano": "2024"}


class TestHeatmapLocationStatsConsistency:
    """heatmap/bairros total weight must match location-stats total for same query."""

    def _get_heatmap_total(self, municipio: str, **params) -> int:
        params['municipio'] = municipio
        params.setdefault('selected_states', 'RS')
        params.setdefault('ano', '2024')
        resp = client.get("/api/heatmap/bairros", params=params)
        assert resp.status_code == 200
        return sum(item['weight'] for item in resp.json())

    def _get_location_stats_total(self, municipio: str, **params) -> int:
        params['municipio'] = municipio
        params.setdefault('selected_states', 'RS')
        params.setdefault('ano', '2024')
        resp = client.get("/api/location-stats", params=params)
        assert resp.status_code == 200
        return resp.json().get('total', 0)

    def test_porto_alegre_consistency(self):
        """POA heatmap total ≈ location-stats total (within 5%)."""
        heatmap = self._get_heatmap_total("PORTO ALEGRE")
        stats = self._get_location_stats_total("PORTO ALEGRE")

        if heatmap == 0 and stats == 0:
            pytest.skip("No RS data for 2024 in local DB")

        diff_ratio = abs(heatmap - stats) / max(heatmap, stats)
        assert diff_ratio < 0.05, (
            f"POA count mismatch: heatmap={heatmap}, stats={stats}, diff={diff_ratio:.2%}"
        )

    def test_canoas_consistency(self):
        """Canoas heatmap total ≈ location-stats total."""
        heatmap = self._get_heatmap_total("CANOAS")
        stats = self._get_location_stats_total("CANOAS")

        if heatmap == 0 and stats == 0:
            pytest.skip("No data for Canoas in current time window")

        diff_ratio = abs(heatmap - stats) / max(heatmap, stats)
        assert diff_ratio < 0.05, (
            f"Canoas count mismatch: heatmap={heatmap}, stats={stats}, diff={diff_ratio:.2%}"
        )


class TestStatesEndpoint:
    """Basic contract tests for /api/heatmap/states."""

    def test_returns_states(self):
        resp = client.get("/api/heatmap/states", params=_BROAD_PARAMS)
        assert resp.status_code == 200
        data = resp.json()
        # RS, RJ, MG have detailed data; SINESP-only states may or may not appear
        assert len(data) >= 3, f"Expected 3+ states, got {len(data)}"

    def test_states_have_weights(self):
        resp = client.get("/api/heatmap/states", params=_BROAD_PARAMS)
        assert resp.status_code == 200
        data = resp.json()
        nonzero = [d for d in data if d.get('weight', 0) > 0]
        assert len(nonzero) >= 3, f"Expected 3+ states with data, got {len(nonzero)}"


class TestFilterOptions:
    """Contract tests for /api/filter-options."""

    def test_rs_has_tipos(self):
        resp = client.get("/api/filter-options", params={"selected_states": "RS"})
        assert resp.status_code == 200
        data = resp.json()
        # API returns 'tipo' (not 'tipos')
        assert len(data.get('tipo', [])) > 0, "RS should have crime types"

    def test_rj_has_tipos(self):
        resp = client.get("/api/filter-options", params={"selected_states": "RJ"})
        assert resp.status_code == 200
        data = resp.json()
        assert len(data.get('tipo', [])) > 0, "RJ should have crime types"
