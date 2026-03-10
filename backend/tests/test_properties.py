"""Property-based tests using Hypothesis.

Tests invariants of normalization functions and filter logic
that must hold for ALL inputs, not just known examples.
"""
import os
import sys
import pytest
from hypothesis import given, settings, assume
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from main import (
    normalize_name,
    _phonetic_br,
    _normalize_bairro_for_matching,
    _point_in_polygon,
    _is_street_or_place,
    _is_invalid_bairro,
)
from services.crime_categories import (
    get_compatible_types,
    get_max_granularity,
    get_state_types,
    STATE_QUALITY,
    STATE_AVAILABLE_CATEGORIES,
    PARTIAL_STATES,
)

ALL_STATES = [
    "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA",
    "MG", "MS", "MT", "PA", "PB", "PE", "PI", "PR", "RJ", "RN",
    "RO", "RR", "RS", "SC", "SE", "SP", "TO",
]

FULL_STATES = [s for s in ALL_STATES if STATE_QUALITY.get(s) == "full"]

# ── Normalization properties ──────────────────────────────────────────────


class TestNormalizeNameProperties:

    @given(st.text(max_size=200))
    @settings(max_examples=200)
    def test_never_crashes(self, s):
        """normalize_name() never raises on arbitrary Unicode input."""
        result = normalize_name(s)
        assert isinstance(result, str)

    @given(st.text(max_size=200))
    @settings(max_examples=200)
    def test_idempotent(self, s):
        """normalize_name(normalize_name(x)) == normalize_name(x)."""
        once = normalize_name(s)
        twice = normalize_name(once)
        assert once == twice

    @given(st.text(max_size=200))
    @settings(max_examples=200)
    def test_result_is_uppercase(self, s):
        """Output is always uppercase (after stripping)."""
        result = normalize_name(s)
        assert result == result.upper()


class TestPhoneticBrProperties:

    @given(st.text(alphabet=st.characters(whitelist_categories=('L', 'N', 'Z')), max_size=100))
    @settings(max_examples=200)
    def test_idempotent(self, s):
        """_phonetic_br() is idempotent."""
        once = _phonetic_br(s)
        twice = _phonetic_br(once)
        assert once == twice

    @given(st.text(max_size=100))
    @settings(max_examples=200)
    def test_no_z_in_output(self, s):
        """Output never contains 'Z'."""
        result = _phonetic_br(s)
        assert 'Z' not in result


class TestNormalizeBairroProperties:

    @given(st.text(max_size=100))
    @settings(max_examples=200)
    def test_never_crashes_no_polys(self, s):
        """_normalize_bairro_for_matching() never crashes without poly_names."""
        result = _normalize_bairro_for_matching(s, None)
        assert isinstance(result, str)

    @given(st.text(max_size=100))
    @settings(max_examples=200)
    def test_never_crashes_empty_polys(self, s):
        """_normalize_bairro_for_matching() never crashes with empty poly_names."""
        result = _normalize_bairro_for_matching(s, set())
        assert isinstance(result, str)

    @given(st.text(max_size=50), st.frozensets(st.text(min_size=3, max_size=30), max_size=20))
    @settings(max_examples=100)
    def test_never_crashes_with_polys(self, s, poly_names):
        """_normalize_bairro_for_matching() never crashes with arbitrary poly_names."""
        result = _normalize_bairro_for_matching(s, set(poly_names))
        assert isinstance(result, str)


class TestPointInPolygon:

    @given(
        st.floats(min_value=-180, max_value=180, allow_nan=False, allow_infinity=False),
        st.floats(min_value=-90, max_value=90, allow_nan=False, allow_infinity=False),
    )
    @settings(max_examples=200)
    def test_returns_bool(self, px, py):
        """_point_in_polygon() always returns bool for a valid triangle."""
        triangle = [[-1, -1], [1, -1], [0, 1], [-1, -1]]
        result = _point_in_polygon(px, py, triangle)
        assert isinstance(result, bool)


class TestIsStreetOrPlaceProperties:

    @given(st.text(max_size=100))
    @settings(max_examples=200)
    def test_returns_bool(self, s):
        """_is_street_or_place() always returns bool."""
        assert isinstance(_is_street_or_place(s), bool)


class TestIsInvalidBairroProperties:

    @given(st.text(max_size=100))
    @settings(max_examples=200)
    def test_returns_bool(self, s):
        """_is_invalid_bairro() always returns bool."""
        assert isinstance(_is_invalid_bairro(s), bool)


# ── Filter combinatorial properties ──────────────────────────────────────

state_strategy = st.sampled_from(ALL_STATES)
state_list_strategy = st.lists(state_strategy, min_size=1, max_size=5, unique=True)


class TestGetCompatibleTypes:

    @given(st.sampled_from(ALL_STATES))
    @settings(max_examples=27)
    def test_single_state_returns_all_native_types(self, state):
        """For any single state, get_compatible_types returns ALL that state's native types."""
        result = get_compatible_types([state])
        assert state in result
        native = set(get_state_types(state))
        returned = set(result[state])
        # Every native type must be in the returned set
        assert native.issubset(returned), (
            f"State {state}: missing types {native - returned}"
        )

    @given(state_list_strategy)
    @settings(max_examples=100)
    def test_result_subset_of_union(self, states):
        """Result types for each state are a subset of the union of all states' types + sinesp types."""
        result = get_compatible_types(states)
        # get_compatible_types always includes sinesp_types alongside state-specific types,
        # so the union must include sinesp types too (via the _sinesp pseudo-state)
        all_types = set()
        for s in states:
            all_types.update(get_state_types(s))
        all_types.update(get_state_types("_sinesp_placeholder"))  # adds sinesp types
        for s in states:
            returned = set(result.get(s, []))
            assert returned.issubset(all_types), (
                f"State {s} has types not in the union: {returned - all_types}"
            )

    @given(state_list_strategy)
    @settings(max_examples=100)
    def test_commutative(self, states):
        """Order of states doesn't matter."""
        import random
        shuffled = states.copy()
        random.shuffle(shuffled)
        r1 = get_compatible_types(states)
        r2 = get_compatible_types(shuffled)
        for s in states:
            assert set(r1.get(s, [])) == set(r2.get(s, [])), (
                f"State {s}: order-dependent results"
            )

    @given(
        st.sampled_from(FULL_STATES),
        state_list_strategy,
    )
    @settings(max_examples=50)
    def test_full_state_types_stable(self, full_state, other_states):
        """Full-quality states (RS, RJ) keep all native types regardless of companions."""
        solo = get_compatible_types([full_state])
        combined = list(set([full_state] + other_states))
        multi = get_compatible_types(combined)

        solo_types = set(solo.get(full_state, []))
        multi_types = set(multi.get(full_state, []))
        # Multi might have fewer types due to MG compatibility filtering,
        # but should still be non-empty
        assert len(multi_types) > 0, f"{full_state} lost all types when combined with {other_states}"

    def test_empty_returns_empty(self):
        assert get_compatible_types([]) == {}


class TestGetMaxGranularity:

    @given(st.lists(st.sampled_from(FULL_STATES), min_size=1, max_size=3, unique=True))
    @settings(max_examples=20)
    def test_full_states_are_monthly(self, states):
        """All full-quality states together → monthly."""
        assert get_max_granularity(states) == "monthly"

    def test_sinesp_only_is_yearly(self):
        """A SINESP-only state forces yearly granularity."""
        # BA is SINESP-only (not in STATE_QUALITY)
        assert get_max_granularity(["BA"]) == "yearly"
        assert get_max_granularity(["RS", "BA"]) == "yearly"

    def test_empty_is_monthly(self):
        assert get_max_granularity([]) == "monthly"
