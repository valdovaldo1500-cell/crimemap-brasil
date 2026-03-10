"""Golden-file tests for bairro name normalization.

Tests that _normalize_bairro_for_matching() correctly resolves known
variants from actual crime data to their canonical polygon names.
These mappings are derived from bugs found during March 9-10, 2026.
"""
import json
import os
import sys
import pytest

# Add backend to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from main import (
    _normalize_bairro_for_matching,
    normalize_name,
    _phonetic_br,
    _strip_articles,
    _is_invalid_bairro,
    _is_street_or_place,
    BAIRRO_POLYGON_INDEX,
)


def _get_poly_names(municipality: str) -> set[str]:
    """Get polygon names for a municipality from the loaded index."""
    mun_norm = normalize_name(municipality)
    polys = BAIRRO_POLYGON_INDEX.get(mun_norm, [])
    return {name_norm for name_norm, _, _ in polys}


def _get_any_poly_names() -> set[str]:
    """Get a combined set of polygon names from all municipalities."""
    names = set()
    for polys in BAIRRO_POLYGON_INDEX.values():
        for name_norm, _, _ in polys:
            names.add(name_norm)
    return names


# Load golden file
GOLDEN_FILE = os.path.join(os.path.dirname(__file__), 'golden_bairro_mappings.json')
with open(GOLDEN_FILE) as f:
    GOLDEN_MAPPINGS = json.load(f)


@pytest.mark.parametrize("mapping", GOLDEN_MAPPINGS, ids=lambda m: f"{m['input']}@{m['municipality']}")
def test_golden_bairro_mapping(mapping):
    """Test that each golden mapping resolves correctly."""
    input_name = normalize_name(mapping['input'])
    municipality = mapping['municipality']

    if municipality == "ANY":
        poly_names = _get_any_poly_names()
    else:
        poly_names = _get_poly_names(municipality)

    result = _normalize_bairro_for_matching(input_name, poly_names if poly_names else None)

    if 'expected' in mapping:
        expected = normalize_name(mapping['expected'])
        assert result == expected, (
            f"Input '{mapping['input']}' in {municipality}: "
            f"got '{result}', expected '{expected}'"
        )
    elif 'expected_startswith' in mapping:
        prefix = normalize_name(mapping['expected_startswith'])
        assert result.startswith(prefix), (
            f"Input '{mapping['input']}' in {municipality}: "
            f"got '{result}', expected to start with '{prefix}'"
        )


class TestNormalizeName:
    """Basic tests for normalize_name()."""

    def test_strips_accents(self):
        assert normalize_name("São Paulo") == "SAO PAULO"

    def test_uppercases(self):
        assert normalize_name("porto alegre") == "PORTO ALEGRE"

    def test_strips_whitespace(self):
        assert normalize_name("  CENTRO  ") == "CENTRO"

    def test_empty_string(self):
        assert normalize_name("") == ""


class TestPhoneticBr:
    """Tests for _phonetic_br() — Z→S normalization."""

    def test_z_to_s(self):
        assert _phonetic_br("FORMOZA") == "FORMOSA"

    def test_no_z(self):
        assert _phonetic_br("CENTRO") == "CENTRO"

    def test_multiple_z(self):
        assert _phonetic_br("TEREZA REZENDE") == "TERESA RESENDE"


class TestIsInvalidBairro:
    """Tests for _is_invalid_bairro()."""

    def test_empty(self):
        assert _is_invalid_bairro("")

    def test_dash(self):
        assert _is_invalid_bairro("-")

    def test_nao_informado(self):
        assert _is_invalid_bairro("NAO INFORMADO")

    def test_single_char(self):
        assert _is_invalid_bairro("I")

    def test_valid_bairro(self):
        assert not _is_invalid_bairro("CENTRO")


class TestIsStreetOrPlace:
    """Tests for _is_street_or_place()."""

    def test_rua(self):
        assert _is_street_or_place("RUA VOLUNTARIOS DA PATRIA")

    def test_avenida(self):
        assert _is_street_or_place("AVENIDA BRASIL")

    def test_highway(self):
        assert _is_street_or_place("BR-116")

    def test_numbered(self):
        assert _is_street_or_place("24 DE OUTUBRO")

    def test_real_bairro(self):
        assert not _is_street_or_place("CENTRO")

    def test_vila_prefix_not_street(self):
        # VILA is NOT a street prefix (Vila Nova, Vila Rosa are real bairros)
        assert not _is_street_or_place("VILA NOVA")
