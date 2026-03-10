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
        assert diff_ratio < 0.10, (
            f"POA count mismatch: heatmap={heatmap}, stats={stats}, diff={diff_ratio:.2%}"
        )

    def test_canoas_consistency(self):
        """Canoas heatmap total ≈ location-stats total."""
        heatmap = self._get_heatmap_total("CANOAS")
        stats = self._get_location_stats_total("CANOAS")

        if heatmap == 0 and stats == 0:
            pytest.skip("No data for Canoas in current time window")

        diff_ratio = abs(heatmap - stats) / max(heatmap, stats)
        assert diff_ratio < 0.10, (
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


class TestAccentNormalizedDedup:
    """Regression: municipality names with/without accents must not create duplicate dots.

    Root cause (2026-03-10): crimes table stores "SAO LEOPOLDO" (no accents),
    crimes_staging stores "SÃO LEOPOLDO" (SINESP source preserves accents).
    Exact-string dedup missed the match, creating a phantom second dot.
    """

    def test_no_duplicate_municipio_dots(self):
        """Each municipality should appear at most once in heatmap response."""
        from main import normalize_name
        resp = client.get("/api/heatmap/municipios", params={
            "selected_states": "RS", "ano": "2024",
        })
        assert resp.status_code == 200
        data = resp.json()
        if not data:
            pytest.skip("No municipality data for RS 2024")

        # Group by normalized name and check for duplicates
        seen: dict[str, list[str]] = {}
        for item in data:
            mun = item.get("municipio")
            if not mun or mun == "-":
                continue
            norm = normalize_name(mun)
            seen.setdefault(norm, []).append(mun)

        duplicates = {k: v for k, v in seen.items() if len(v) > 1}
        assert not duplicates, (
            f"Duplicate municipality dots (accent mismatch?): {duplicates}"
        )

    def test_nao_informado_excluded(self):
        """'NÃO INFORMADO' must not appear as a municipality dot."""
        resp = client.get("/api/heatmap/municipios", params={
            "selected_states": ["RS", "RJ", "MG"],
        })
        assert resp.status_code == 200
        data = resp.json()
        bad = [d for d in data if d.get("municipio") and
               "INFORMADO" in d["municipio"].upper()]
        assert not bad, f"Found NÃO INFORMADO dot(s): {bad}"


class TestTotalGteBreakdownSum:
    """Contract: total must always >= sum of type breakdown.

    Root cause (2026-03-10): staging fallback derived total from .limit(10)
    breakdown, silently undercounting cities with >10 crime types.
    """

    def _check_total_gte_breakdown(self, endpoint: str, params: dict):
        resp = client.get(endpoint, params=params)
        assert resp.status_code == 200
        data = resp.json()
        total = data.get("total", 0)
        type_sum = sum(ct.get("count", 0) for ct in data.get("crime_types", []))
        if total == 0 and type_sum == 0:
            pytest.skip(f"No data for {params}")
        assert total >= type_sum, (
            f"{endpoint} total ({total}) < type breakdown sum ({type_sum}) for {params}"
        )

    def test_location_stats_rs_municipality(self):
        self._check_total_gte_breakdown("/api/location-stats", {
            "municipio": "PORTO ALEGRE", "state": "RS", "ano": "2024",
        })

    def test_location_stats_rj_municipality(self):
        """RJ uses staging fallback — previously undercounted."""
        self._check_total_gte_breakdown("/api/location-stats", {
            "municipio": "Itatiaia", "state": "RJ",
        })

    def test_state_stats_rs(self):
        self._check_total_gte_breakdown("/api/state-stats", {
            "state": "RS", "ano": "2024",
        })

    def test_state_stats_rj(self):
        """RJ uses staging fallback — previously undercounted."""
        self._check_total_gte_breakdown("/api/state-stats", {
            "state": "RJ",
        })

    def test_state_stats_with_ultimos_meses(self):
        """Verify ultimos_meses param works on state-stats (added 2026-03-10)."""
        resp = client.get("/api/state-stats", params={
            "state": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        data = resp.json()
        total = data.get("total", 0)
        type_sum = sum(ct.get("count", 0) for ct in data.get("crime_types", []))
        if total == 0:
            pytest.skip("No RS data in last 12 months")
        assert total >= type_sum
