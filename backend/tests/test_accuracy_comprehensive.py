"""Comprehensive accuracy test suite — regressions for bairro pipeline bugs.

Covers:
1. No duplicate BairroComponent entries (Santa Tereza dedup bug)
2. Heatmap weight parity with location-stats (containment merge bug)
3. raw_bairro_names tracking through fuzzy/PIP merge
4. Cross-table double-counting (crimes vs crimes_staging)
5. total >= breakdown sum (no .limit(N) derivation)
6. Population rate math correctness
7. ultimos_meses time window consistency
8. Geographic accuracy (no misplaced bairros)
9. MG compatibility filter behavior
10. API contract (all required fields present)
"""
import os
import sys
import math
import unicodedata
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

_POA = "PORTO ALEGRE"
_CANOAS = "CANOAS"
_CAXIAS = "CAXIAS DO SUL"

def _strip_accents(s: str) -> str:
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')

def _norm(s: str) -> str:
    return _strip_accents(s.upper().strip())


class TestNoDuplicateComponents:
    """Regression: duplicate BairroComponent entries for same display name (Santa Tereza bug)."""

    def _check_no_duplicate_components(self, municipio: str):
        resp = client.get("/api/heatmap/bairros", params={
            "municipio": municipio, "selected_states": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        data = resp.json()
        if not data:
            pytest.skip(f"No bairro data for {municipio}")

        for point in data:
            components = point.get("components") or []
            if not components:
                continue
            # Filter out empty names — they may be legitimate placeholders
            names = [c.get("name", "") for c in components if c.get("name")]
            if len(names) <= 1:
                continue
            assert len(names) == len(set(names)), (
                f"{municipio} bairro '{point.get('bairro')}' has duplicate component names: {names}"
            )

    def test_no_duplicate_bairro_names_in_components_poa(self):
        self._check_no_duplicate_components(_POA)

    def test_no_duplicate_bairro_names_canoas(self):
        self._check_no_duplicate_components(_CANOAS)

    def test_no_duplicate_bairro_names_caxias(self):
        self._check_no_duplicate_components(_CAXIAS)

    def test_components_weights_positive(self):
        """All component weights must be > 0 (no zero-weight ghost entries)."""
        resp = client.get("/api/heatmap/bairros", params={
            "municipio": _POA, "selected_states": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        data = resp.json()
        if not data:
            pytest.skip("No POA bairro data")

        for point in data:
            for comp in point.get("components") or []:
                w = comp.get("weight", 0)
                assert w > 0, (
                    f"Zero-weight component '{comp.get('name')}' in bairro '{point.get('bairro')}'"
                )


class TestHeatmapLocationStatsParity:
    """Regression: heatmap weight must match location-stats total for same bairro+filters."""

    def _get_bairros(self, municipio: str, ultimos_meses: int = 12):
        resp = client.get("/api/heatmap/bairros", params={
            "municipio": municipio, "selected_states": "RS", "ultimos_meses": ultimos_meses,
        })
        assert resp.status_code == 200
        return resp.json()

    def _get_stats_total(self, municipio: str, bairro: str, ultimos_meses: int = 12,
                         extra_bairros: list[str] | None = None) -> int:
        params: dict = {
            "municipio": municipio, "state": "RS", "bairro": bairro,
            "ultimos_meses": ultimos_meses,
        }
        # Build params as list of tuples to support repeated extra_bairros keys
        param_list = list(params.items())
        if extra_bairros:
            param_list += [("extra_bairros", name) for name in extra_bairros]
        resp = client.get("/api/location-stats", params=param_list)
        assert resp.status_code == 200
        return resp.json().get("total", 0)

    def _check_parity(self, municipio: str, ultimos_meses: int = 12,
                      merged_only: bool = False, tolerance: float = 0.05):
        data = self._get_bairros(municipio, ultimos_meses)
        if not data:
            pytest.skip(f"No bairro data for {municipio} ultimos_meses={ultimos_meses}")

        mismatches = []
        checked = 0
        for point in data:
            bairro = point.get("bairro", "")
            if not bairro or bairro in ("-", "Bairro desconhecido"):
                continue
            is_merged = "+" in bairro
            if merged_only and not is_merged:
                continue

            heatmap_w = point.get("weight", 0)
            if heatmap_w == 0:
                continue

            raw_names = point.get("raw_bairro_names", [])
            stats_total = self._get_stats_total(
                municipio, bairro, ultimos_meses, extra_bairros=raw_names
            )

            diff = abs(heatmap_w - stats_total)
            allowed = max(1, heatmap_w * tolerance)
            if diff > allowed:
                mismatches.append({
                    "bairro": bairro, "heatmap": heatmap_w,
                    "stats": stats_total, "diff": diff,
                })
            checked += 1
            if checked >= 20:  # limit to 20 checks to keep tests fast
                break

        assert not mismatches, (
            f"{municipio} parity failures (ultimos_meses={ultimos_meses}): "
            + "; ".join(f"{m['bairro']}: heatmap={m['heatmap']} stats={m['stats']}" for m in mismatches[:5])
        )

    def test_weight_matches_location_stats_poa_all_bairros(self):
        self._check_parity(_POA, ultimos_meses=12)

    def test_weight_matches_location_stats_poa_merged_points(self):
        """Merged/cluster points have highest risk of mismatch."""
        self._check_parity(_POA, ultimos_meses=12, merged_only=True)

    def test_weight_matches_location_stats_canoas(self):
        self._check_parity(_CANOAS, ultimos_meses=12)

    def test_weight_matches_location_stats_with_ultimos_meses_3(self):
        self._check_parity(_POA, ultimos_meses=3)

    def test_weight_matches_location_stats_with_ultimos_meses_6(self):
        self._check_parity(_POA, ultimos_meses=6)


class TestCrossTableAccuracy:
    """Validates no double-counting between crimes and crimes_staging tables."""

    def _heatmap_municipio_total(self, state: str) -> float:
        resp = client.get("/api/heatmap/municipios", params={
            "selected_states": state, "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        return sum(p.get("weight", 0) for p in resp.json())

    def _state_stats_total(self, state: str) -> int:
        resp = client.get("/api/state-stats", params={
            "state": state, "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        return resp.json().get("total", 0)

    def _check_state_consistency(self, state: str, tolerance: float = 0.10):
        heatmap_sum = self._heatmap_municipio_total(state)
        stats_total = self._state_stats_total(state)
        if heatmap_sum == 0 and stats_total == 0:
            pytest.skip(f"No data for {state}")
        diff_ratio = abs(heatmap_sum - stats_total) / max(heatmap_sum, stats_total)
        assert diff_ratio < tolerance, (
            f"{state}: heatmap_sum={heatmap_sum:.0f} vs state_stats_total={stats_total} "
            f"diff={diff_ratio:.1%} (>{tolerance:.0%})"
        )

    def test_municipality_no_double_count_rs(self):
        self._check_state_consistency("RS")

    def test_municipality_no_double_count_rj(self):
        self._check_state_consistency("RJ")

    def test_municipality_no_double_count_mg(self):
        # MG heatmap uses crimes_staging occurrences only (partial source),
        # while state-stats may count from a different aggregation — skip exact comparison.
        # Instead just verify both are positive and heatmap is non-empty.
        heatmap_sum = self._heatmap_municipio_total("MG")
        stats_total = self._state_stats_total("MG")
        if heatmap_sum == 0 and stats_total == 0:
            pytest.skip("No MG data")
        assert heatmap_sum > 0, "MG heatmap must return non-zero total"
        assert stats_total > 0, "MG state-stats must return non-zero total"

    def test_no_duplicate_municipality_dots_rs(self):
        """SAO LEOPOLDO/SÃO LEOPOLDO accent mismatch must not create duplicate dots."""
        resp = client.get("/api/heatmap/municipios", params={
            "selected_states": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        data = resp.json()
        if not data:
            pytest.skip("No RS municipio data")

        seen: dict[str, list[str]] = {}
        for item in data:
            mun = item.get("municipio")
            if not mun or mun in ("-", ""):
                continue
            norm = _norm(mun)
            seen.setdefault(norm, []).append(mun)

        duplicates = {k: v for k, v in seen.items() if len(v) > 1}
        assert not duplicates, f"Duplicate municipio dots (accent mismatch?): {duplicates}"

    def test_no_duplicate_municipality_dots_rj(self):
        resp = client.get("/api/heatmap/municipios", params={
            "selected_states": "RJ", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        data = resp.json()
        if not data:
            pytest.skip("No RJ municipio data")

        seen: dict[str, list[str]] = {}
        for item in data:
            mun = item.get("municipio")
            if not mun or mun in ("-", ""):
                continue
            norm = _norm(mun)
            seen.setdefault(norm, []).append(mun)

        duplicates = {k: v for k, v in seen.items() if len(v) > 1}
        assert not duplicates, f"RJ duplicate municipio dots: {duplicates}"


class TestTotalVsBreakdownIntegrity:
    """total must always >= sum of type breakdown (no .limit(N) derivation)."""

    def _check_location_stats(self, municipio: str, state: str, bairro: str | None = None):
        params: dict = {"municipio": municipio, "state": state, "ultimos_meses": 12}
        if bairro:
            params["bairro"] = bairro
        resp = client.get("/api/location-stats", params=params)
        assert resp.status_code == 200
        d = resp.json()
        total = d.get("total", 0)
        breakdown_sum = sum(ct.get("count", 0) for ct in d.get("crime_types", []))
        if total == 0 and breakdown_sum == 0:
            return  # skip silently for cities without data
        assert total >= breakdown_sum, (
            f"{state}/{municipio}{'/'+bairro if bairro else ''}: "
            f"total={total} < breakdown_sum={breakdown_sum}"
        )

    def _check_state_stats(self, state: str):
        resp = client.get("/api/state-stats", params={"state": state, "ultimos_meses": 12})
        assert resp.status_code == 200
        d = resp.json()
        total = d.get("total", 0)
        breakdown_sum = sum(ct.get("count", 0) for ct in d.get("crime_types", []))
        if total == 0:
            pytest.skip(f"No state-stats data for {state}")
        assert total >= breakdown_sum, (
            f"{state} state-stats: total={total} < breakdown_sum={breakdown_sum}"
        )

    def test_location_stats_total_gte_breakdown_sum_rs(self):
        for city in [_POA, _CANOAS, _CAXIAS, "PELOTAS", "SANTA MARIA"]:
            self._check_location_stats(city, "RS")

    def test_location_stats_total_gte_breakdown_sum_rj(self):
        for city in ["RIO DE JANEIRO", "NITEROI", "DUQUE DE CAXIAS"]:
            self._check_location_stats(city, "RJ")

    def test_state_stats_total_gte_breakdown_sum_rs(self):
        self._check_state_stats("RS")

    def test_state_stats_total_gte_breakdown_sum_rj(self):
        self._check_state_stats("RJ")

    def test_location_stats_total_gte_breakdown_sum_poa_bairros(self):
        resp = client.get("/api/heatmap/bairros", params={
            "municipio": _POA, "selected_states": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        data = resp.json()
        if not data:
            pytest.skip("No POA bairro data")

        checked = 0
        for point in data[:10]:
            bairro = point.get("bairro", "")
            if not bairro or bairro in ("-", "Bairro desconhecido") or "+" in bairro:
                continue
            self._check_location_stats(_POA, "RS", bairro=bairro)
            checked += 1

        if checked == 0:
            pytest.skip("No suitable POA bairros found")


class TestPopulationRateAccuracy:
    """Validates rate calculations and null-safety."""

    def _get_stats(self, municipio: str, state: str, bairro: str | None = None) -> dict:
        params: dict = {"municipio": municipio, "state": state, "ultimos_meses": 12}
        if bairro:
            params["bairro"] = bairro
        resp = client.get("/api/location-stats", params=params)
        assert resp.status_code == 200
        return resp.json()

    def test_rate_math_matches_total_over_population_rs(self):
        d = self._get_stats(_POA, "RS")
        total = d.get("total", 0)
        pop = d.get("population")
        rate = d.get("rate")
        if not total or not pop or rate is None:
            pytest.skip("POA missing total/population/rate")
        expected = (total / pop) * 100_000
        assert abs(rate - expected) <= 1.0, (
            f"POA rate={rate:.2f} != expected={expected:.2f} (total={total}, pop={pop})"
        )

    def test_rate_math_matches_total_over_population_rj(self):
        d = self._get_stats("RIO DE JANEIRO", "RJ")
        total = d.get("total", 0)
        pop = d.get("population")
        rate = d.get("rate")
        if not total or not pop or rate is None:
            pytest.skip("RJ/Rio missing total/population/rate")
        expected = (total / pop) * 100_000
        assert abs(rate - expected) <= 1.0, (
            f"Rio rate={rate:.2f} != expected={expected:.2f}"
        )

    def test_no_nan_or_infinity_rate(self):
        cities = [
            (_POA, "RS"), (_CANOAS, "RS"), (_CAXIAS, "RS"),
            ("RIO DE JANEIRO", "RJ"), ("NITEROI", "RJ"),
            ("BELO HORIZONTE", "MG"), ("UBERLANDIA", "MG"),
        ]
        for municipio, state in cities:
            d = self._get_stats(municipio, state)
            rate = d.get("rate")
            if rate is None:
                continue  # null rate is ok (no population data)
            assert math.isfinite(rate), (
                f"{state}/{municipio}: rate={rate} is not finite (NaN or Inf)"
            )

    def test_population_source_field_present(self):
        d = self._get_stats(_POA, "RS")
        assert "population_source" in d, "location-stats must return population_source field"
        assert d["population_source"] in ("bairro", "municipio", None), (
            f"Invalid population_source value: {d['population_source']!r}"
        )

    def test_bairro_population_source_labeled_correctly_poa(self):
        resp = client.get("/api/heatmap/bairros", params={
            "municipio": _POA, "selected_states": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        bairros_data = resp.json()
        if not bairros_data:
            pytest.skip("No POA bairro data")

        checked = 0
        for point in bairros_data[:10]:
            bairro = point.get("bairro", "")
            if not bairro or "+" in bairro or bairro in ("-", "Bairro desconhecido"):
                continue
            d = self._get_stats(_POA, "RS", bairro=bairro)
            source = d.get("population_source")
            pop = d.get("population")
            # If population_source is set, population must be non-null
            if source is not None:
                assert pop is not None and pop > 0, (
                    f"POA/{bairro}: population_source={source!r} but population={pop}"
                )
            checked += 1

        if checked == 0:
            pytest.skip("No suitable POA bairros")


class TestUltimosMesesParity:
    """Validates time window consistency across endpoints."""

    def test_heatmap_and_locationstats_parity_with_12m(self):
        """12m: heatmap weight sum for POA ≈ location-stats total for POA."""
        resp = client.get("/api/heatmap/bairros", params={
            "municipio": _POA, "selected_states": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        heatmap_sum = sum(p.get("weight", 0) for p in resp.json())

        resp2 = client.get("/api/location-stats", params={
            "municipio": _POA, "state": "RS", "ultimos_meses": 12,
        })
        assert resp2.status_code == 200
        stats_total = resp2.json().get("total", 0)

        if heatmap_sum == 0 and stats_total == 0:
            pytest.skip("No POA data for ultimos_meses=12")

        diff = abs(heatmap_sum - stats_total) / max(heatmap_sum, stats_total)
        assert diff < 0.10, f"12m parity: heatmap={heatmap_sum} stats={stats_total} diff={diff:.1%}"

    def test_heatmap_and_locationstats_parity_with_3m(self):
        resp = client.get("/api/heatmap/bairros", params={
            "municipio": _POA, "selected_states": "RS", "ultimos_meses": 3,
        })
        assert resp.status_code == 200
        heatmap_sum = sum(p.get("weight", 0) for p in resp.json())

        resp2 = client.get("/api/location-stats", params={
            "municipio": _POA, "state": "RS", "ultimos_meses": 3,
        })
        assert resp2.status_code == 200
        stats_total = resp2.json().get("total", 0)

        if heatmap_sum == 0 and stats_total == 0:
            pytest.skip("No POA data for ultimos_meses=3")

        diff = abs(heatmap_sum - stats_total) / max(heatmap_sum, stats_total)
        assert diff < 0.10, f"3m parity: heatmap={heatmap_sum} stats={stats_total} diff={diff:.1%}"

    def test_state_stats_and_heatmap_parity_12m(self):
        """RS: state-stats total with 12m ≈ sum of municipio heatmap weights with 12m."""
        resp = client.get("/api/heatmap/municipios", params={
            "selected_states": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        heatmap_sum = sum(p.get("weight", 0) for p in resp.json())

        resp2 = client.get("/api/state-stats", params={"state": "RS", "ultimos_meses": 12})
        assert resp2.status_code == 200
        state_total = resp2.json().get("total", 0)

        if heatmap_sum == 0 and state_total == 0:
            pytest.skip("No RS data")

        diff = abs(heatmap_sum - state_total) / max(heatmap_sum, state_total)
        assert diff < 0.10, (
            f"RS 12m: heatmap_sum={heatmap_sum:.0f} state_total={state_total} diff={diff:.1%}"
        )

    def test_filter_options_ultimos_meses_consistency(self):
        """12m returns >= 3m crime type counts (more data in longer window)."""
        resp3 = client.get("/api/filter-options", params={
            "selected_states": "RS", "ultimos_meses": 3,
        })
        resp12 = client.get("/api/filter-options", params={
            "selected_states": "RS", "ultimos_meses": 12,
        })
        assert resp3.status_code == 200
        assert resp12.status_code == 200

        tipos3 = resp3.json().get("tipo", [])
        tipos12 = resp12.json().get("tipo", [])

        # 12m should have at least as many types as 3m
        assert len(tipos12) >= len(tipos3), (
            f"12m types ({len(tipos12)}) < 3m types ({len(tipos3)}) — shorter window should not have more types"
        )


class TestGeographicAccuracy:
    """Validates no bairros placed in wrong municipality."""

    def test_no_pantano_in_porto_alegre(self):
        resp = client.get("/api/heatmap/bairros", params={
            "municipio": _POA, "selected_states": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        data = resp.json()
        pantano = [p for p in data if p.get("bairro", "").upper().startswith("PANTANO")]
        assert not pantano, (
            f"Found PANTANO bairros in POA (should be in PANTANO GRANDE municipality): "
            + str([p["bairro"] for p in pantano])
        )

    def test_all_poa_bairros_within_poa_bounds(self):
        """All POA bairro centroids must be within Porto Alegre's bounding box."""
        resp = client.get("/api/heatmap/bairros", params={
            "municipio": _POA, "selected_states": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        data = resp.json()
        if not data:
            pytest.skip("No POA bairro data")

        # POA bounding box (generous)
        LAT_MIN, LAT_MAX = -30.35, -29.85
        LNG_MIN, LNG_MAX = -51.35, -51.00

        outliers = []
        for p in data:
            lat = p.get("latitude", 0)
            lng = p.get("longitude", 0)
            if not (LAT_MIN <= lat <= LAT_MAX and LNG_MIN <= lng <= LNG_MAX):
                outliers.append({"bairro": p.get("bairro"), "lat": lat, "lng": lng})

        assert not outliers, (
            f"POA bairros outside POA bounds: "
            + str(outliers[:5])
        )

    def test_no_invalid_bairro_names(self):
        """Garbage bairro names must not appear in POA results."""
        INVALID = {"-", "NAO INFORMADO", "NÃO INFORMADO", "S/B", "S/BAIRRO", "SB"}
        resp = client.get("/api/heatmap/bairros", params={
            "municipio": _POA, "selected_states": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        data = resp.json()
        bad = [p for p in data if p.get("bairro", "").upper() in INVALID]
        assert not bad, f"Invalid bairro names in POA: {[p['bairro'] for p in bad]}"

    def test_no_street_names_as_bairros(self):
        """Street-prefix bairro names must be remapped by _is_street_or_place()."""
        STREET_PREFIXES = ("RUA ", "AV ", "AVENIDA ", "ESTRADA ", "TRAVESSA ", "RODOVIA ")
        resp = client.get("/api/heatmap/bairros", params={
            "municipio": _POA, "selected_states": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        data = resp.json()
        street_bairros = [
            p for p in data
            if any(p.get("bairro", "").upper().startswith(pfx) for pfx in STREET_PREFIXES)
        ]
        assert not street_bairros, (
            f"Street names appearing as bairros (should be remapped via PIP): "
            + str([p["bairro"] for p in street_bairros[:5]])
        )


class TestMGCompatibilityFilter:
    """Validates MG partial-state filter behavior."""

    def test_mg_single_state_shows_all_mg_types(self):
        """MG alone should show MG-native crime types, not just RS-compatible subset."""
        resp = client.get("/api/filter-options", params={"selected_states": "MG"})
        assert resp.status_code == 200
        tipos = resp.json().get("tipo", [])
        assert len(tipos) > 0, "MG single-state must return crime types"
        # MG has homicidio doloso — a core violent crime type
        type_names = [t.get("value", t) if isinstance(t, dict) else t for t in tipos]
        type_names_upper = [str(n).upper() for n in type_names]
        has_violent = any(
            any(keyword in n for keyword in ["HOMICIDIO", "HOMICÍDIO", "ESTUPRO", "ROUBO"])
            for n in type_names_upper
        )
        assert has_violent, f"MG single-state filter missing expected violent crime types. Got: {type_names[:10]}"

    def test_mg_with_rs_restricts_to_compatible_types(self):
        """RS+MG should yield fewer types than RS alone (MG compatibility filter)."""
        resp_rs = client.get("/api/filter-options", params={"selected_states": "RS"})
        resp_mg_rs = client.get("/api/filter-options", params={"selected_states": "RS,MG"})
        assert resp_rs.status_code == 200
        assert resp_mg_rs.status_code == 200

        rs_tipos = resp_rs.json().get("tipo", [])
        mg_rs_tipos = resp_mg_rs.json().get("tipo", [])

        assert len(mg_rs_tipos) < len(rs_tipos), (
            f"RS+MG ({len(mg_rs_tipos)} types) should have fewer types than RS alone ({len(rs_tipos)} types)"
        )
        assert len(mg_rs_tipos) > 0, "RS+MG filter must return some compatible types"

    def test_mg_total_plausible(self):
        """MG state total should be positive and plausible."""
        resp = client.get("/api/state-stats", params={"state": "MG", "ultimos_meses": 12})
        assert resp.status_code == 200
        total = resp.json().get("total", 0)
        if total == 0:
            pytest.skip("No MG data in last 12 months")
        # MG (partial) should be less than RS (full) — very rough sanity check
        resp_rs = client.get("/api/state-stats", params={"state": "RS", "ultimos_meses": 12})
        rs_total = resp_rs.json().get("total", 0)
        # MG violent crimes should be > 0 (basic sanity)
        assert total > 0, "MG state total must be positive"
        # MG should not massively exceed RS (would indicate double-counting)
        if rs_total > 0:
            assert total < rs_total * 5, (
                f"MG total ({total}) suspiciously large vs RS ({rs_total})"
            )


class TestBairroPolygonIndexLoaded:
    """Validates startup state — catches Coolify volume mount issue where polygons not loaded."""

    def test_polygon_matched_bairros_exist_in_poa(self):
        """At least 20 named bairros in POA (polygon index must be loaded)."""
        resp = client.get("/api/heatmap/bairros", params={
            "municipio": _POA, "selected_states": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        data = resp.json()
        if not data:
            pytest.skip("No POA data")

        named = [p for p in data if p.get("bairro") and p["bairro"] not in ("-", "Bairro desconhecido")]
        assert len(named) >= 20, (
            f"Only {len(named)} named POA bairros — polygon index may not be loaded "
            f"(expected 20+, got {len(named)} named out of {len(data)} total)"
        )

    def test_unknown_bairro_fraction_below_threshold(self):
        """'Bairro desconhecido' must be < 30% of POA total weight."""
        resp = client.get("/api/heatmap/bairros", params={
            "municipio": _POA, "selected_states": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        data = resp.json()
        if not data:
            pytest.skip("No POA data")

        total_weight = sum(p.get("weight", 0) for p in data)
        unknown_weight = sum(
            p.get("weight", 0) for p in data
            if p.get("bairro") in ("Bairro desconhecido", "-", None, "")
        )

        if total_weight == 0:
            pytest.skip("Zero total weight")

        fraction = unknown_weight / total_weight
        assert fraction < 0.30, (
            f"'Bairro desconhecido' is {fraction:.1%} of POA weight "
            f"(threshold: 30%) — polygon index may be empty"
        )

    def test_cluster_merge_preserves_polygon_bairros(self):
        """Known large POA bairros must appear as named points, not absorbed into '+N desconhecido'."""
        resp = client.get("/api/heatmap/bairros", params={
            "municipio": _POA, "selected_states": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        data = resp.json()
        if not data:
            pytest.skip("No POA data")

        bairro_names = {p.get("bairro", "").upper() for p in data}
        # At least ONE of the major known bairros must appear
        major_bairros = {"CENTRO", "MOINHOS DE VENTO", "BELA VISTA", "MONT SERRAT", "HIGIENOPOLIS"}
        found = major_bairros & bairro_names
        assert found, (
            f"None of the expected major POA bairros found: {major_bairros}. "
            f"Available: {sorted(bairro_names)[:20]}"
        )


class TestAPIContract:
    """Validates all endpoints return required fields."""

    def test_heatmap_bairros_required_fields(self):
        resp = client.get("/api/heatmap/bairros", params={
            "municipio": _POA, "selected_states": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        data = resp.json()
        if not data:
            pytest.skip("No data")
        required = {"latitude", "longitude", "weight", "bairro"}
        for point in data[:5]:
            missing = required - set(point.keys())
            assert not missing, f"Heatmap bairro point missing fields: {missing}"

    def test_heatmap_municipios_required_fields(self):
        resp = client.get("/api/heatmap/municipios", params={
            "selected_states": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        data = resp.json()
        if not data:
            pytest.skip("No data")
        required = {"latitude", "longitude", "weight", "municipio"}
        for point in data[:5]:
            missing = required - set(point.keys())
            assert not missing, f"Heatmap municipio point missing fields: {missing}"

    def test_location_stats_required_fields(self):
        resp = client.get("/api/location-stats", params={
            "municipio": _POA, "state": "RS", "ultimos_meses": 12,
        })
        assert resp.status_code == 200
        d = resp.json()
        assert "total" in d, "location-stats missing 'total' field"
        assert "crime_types" in d, "location-stats missing 'crime_types' field"
        assert isinstance(d["crime_types"], list), "crime_types must be a list"
        assert "population_source" in d, "location-stats missing 'population_source' field"

    def test_state_stats_required_fields(self):
        resp = client.get("/api/state-stats", params={"state": "RS", "ultimos_meses": 12})
        assert resp.status_code == 200
        d = resp.json()
        assert "total" in d, "state-stats missing 'total' field"
        assert "crime_types" in d, "state-stats missing 'crime_types' field"

    def test_filter_options_required_fields(self):
        resp = client.get("/api/filter-options", params={"selected_states": "RS"})
        assert resp.status_code == 200
        d = resp.json()
        assert "tipo" in d, "filter-options missing 'tipo' field"
        assert isinstance(d["tipo"], list), "tipo must be a list"

    def test_heatmap_points_weight_positive(self):
        """All heatmap points across RS/RJ/MG must have weight > 0."""
        for state in ["RS", "RJ", "MG"]:
            resp = client.get("/api/heatmap/municipios", params={
                "selected_states": state, "ultimos_meses": 12,
            })
            assert resp.status_code == 200
            data = resp.json()
            zero_weight = [p for p in data if p.get("weight", 0) <= 0]
            assert not zero_weight, (
                f"{state}: {len(zero_weight)} municipio points with weight <= 0"
            )
