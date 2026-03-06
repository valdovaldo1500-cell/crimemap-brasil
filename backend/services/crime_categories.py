"""Crime category mapping for cross-state comparison.

Defines canonical crime categories and maps each state's crime types to them.
Used to auto-filter when comparing states with different data coverage
(e.g., MG only has violent crimes).
"""

import logging

log = logging.getLogger(__name__)


# ── Canonical crime categories ─────────────────────────────────────────────

CRIME_CATEGORIES = {
    "violencia_pessoa": {
        "label": "Violência contra pessoa",
        "rs_types": [
            "HOMICIDIO DOLOSO", "HOMICIDIO CULPOSO", "TENTATIVA DE HOMICIDIO",
            "FEMINICIDIO", "LATROCINIO",
            "LESAO CORPORAL DOLOSA", "LESAO CORPORAL CULPOSA",
            "LESAO CORPORAL SEGUIDA DE MORTE",
            "AMEACA", "SEQUESTRO", "SEQUESTRO RELAMPAGO",
        ],
        "rj_types": [
            "hom_doloso", "hom_culposo", "tentat_hom", "latrocinio",
            "hom_por_interv_policial",
            "lesao_corp_dolosa", "lesao_corp_culposa", "lesao_corp_morte",
            "feminicidio", "tentativa_feminicidio",
            "ameaca", "sequestro", "sequestro_relampago", "extorsao",
        ],
        "mg_types": [
            "Homicídio Consumado (Registros)", "Homicídio Tentado",
            "Feminicídio Consumado (Registros)", "Feminicídio Tentado",
            "Extorsão Consumado", "Extorsão Tentado",
            "Extorsão Mediante Sequestro Consumado",
            "Sequestro E Cárcere Privado Consumado", "Sequestro E Cárcere Privado Tentado",
        ],
        "sinesp_types": [
            "Homicídio doloso", "Feminicídio",
            "Tentativa de homicídio", "Tentativa de feminicídio",
            "Lesão corporal seguida de morte",
            "Roubo seguido de morte (latrocínio)",
            "Morte por intervenção de Agente do Estado",
        ],
    },
    "crimes_patrimoniais": {
        "label": "Crimes patrimoniais",
        "rs_types": [
            "FURTO", "FURTO QUALIFICADO", "FURTO DE VEICULO",
            "ROUBO", "ROUBO A ESTABELECIMENTO COMERCIAL",
            "ROUBO DE VEICULO", "ROUBO A TRANSEUNTE",
            "ESTELIONATO",
        ],
        "rj_types": [
            "roubo_transeunte", "roubo_veiculo", "roubo_comercio",
            "roubo_carga", "roubo_celular", "roubo_residencia",
            "roubo_corp_am_am", "roubo_em_coletivo",
            "roubo_conducao_saque", "roubo_bicicleta",
            "roubo_rua", "roubo_banco", "roubo_cx_eletronico",
            "roubo_apos_saque", "outros_roubos",
            "furto_veiculos", "furto_transeunte", "furto_coletivo",
            "furto_celular", "furto_bicicleta", "outros_furtos",
            "estelionato", "recuperacao_veiculos",
        ],
        "mg_types": [
            "Roubo Consumado", "Roubo Tentado",
        ],
        "sinesp_types": [
            "Furto de veículo", "Roubo de veículo",
            "Roubo a instituição financeira", "Roubo de carga",
        ],
    },
    "crimes_sexuais": {
        "label": "Crimes sexuais",
        "rs_types": [
            "ESTUPRO", "ESTUPRO DE VULNERAVEL",
        ],
        "rj_types": [
            "estupro",
        ],
        "mg_types": [
            "Estupro Consumado", "Estupro De Vulnerável Consumado",
            "Estupro Tentado", "Estupro De Vulnerável Tentado",
        ],
        "sinesp_types": [
            "Estupro", "Estupro de vulnerável",
        ],
    },
    "drogas": {
        "label": "Drogas",
        "rs_types": [
            "TRAFICO DE ENTORPECENTES", "POSSE DE ENTORPECENTES",
        ],
        "rj_types": [
            "trafico_drogas", "posse_drogas", "apreensao_drogas",
        ],
        "mg_types": [],  # NOT AVAILABLE in MG data
        "sinesp_types": [
            "Tráfico de drogas",
        ],
    },
}


# ── State data source metadata ─────────────────────────────────────────────

# Per-source temporal granularity
SOURCE_GRANULARITY = {
    "rs": "monthly",        # crimes table has data_fato with day precision
    "rj_isp": "monthly",    # ISP CSVs have ano + mes columns
    "mg_violent": "monthly", # MG CSVs have month columns
    "sinesp_vde": "yearly",  # data_referencia = YYYY-01-01, no month
}

# State → list of sources (ordered by preference)
STATE_SOURCES = {
    "RS": ["rs"],
    "RJ": ["rj_isp"],
    "MG": ["mg_violent", "sinesp_vde"],
}

# States that only have limited crime coverage
PARTIAL_STATES = {"MG"}  # Only violent crimes

# Categories available per state
STATE_AVAILABLE_CATEGORIES = {
    "RS": {"violencia_pessoa", "crimes_patrimoniais", "crimes_sexuais", "drogas"},
    "RJ": {"violencia_pessoa", "crimes_patrimoniais", "crimes_sexuais", "drogas"},
    "MG": {"violencia_pessoa", "crimes_patrimoniais", "crimes_sexuais"},
    # SINESP-only states have all categories covered by VDE
    "_sinesp": {"violencia_pessoa", "crimes_patrimoniais", "crimes_sexuais", "drogas"},
}

# Data quality levels
STATE_QUALITY = {
    "RS": "full",
    "RJ": "full",
    "MG": "partial",
}


def _get_state_key(state: str) -> str:
    """Get the key for looking up state categories/types."""
    return state if state in STATE_AVAILABLE_CATEGORIES else "_sinesp"


def get_state_types(state: str) -> list[str]:
    """Get all crime types for a given state across all categories."""
    key = _get_state_key(state)
    types = []
    for cat_name, cat in CRIME_CATEGORIES.items():
        if cat_name not in STATE_AVAILABLE_CATEGORIES.get(key, set()):
            continue
        type_key = f"{state.lower()}_types" if f"{state.lower()}_types" in cat else "sinesp_types"
        types.extend(cat.get(type_key, []))
    return types


def get_compatible_types(selected_states: list[str]) -> dict[str, list[str]]:
    """Compute compatible crime types across selected states.

    Returns a per-state filter list that ensures apples-to-apples comparison.
    When MG is selected, filters all states to MG-compatible categories only.
    """
    if not selected_states:
        return {}

    # Find common categories across all selected states
    common_cats = None
    for state in selected_states:
        key = _get_state_key(state)
        state_cats = STATE_AVAILABLE_CATEGORIES.get(key, set())
        if common_cats is None:
            common_cats = state_cats.copy()
        else:
            common_cats &= state_cats

    if not common_cats:
        return {s: [] for s in selected_states}

    # Build per-state type lists from common categories
    # Include both state-specific AND sinesp types since staging data may use either naming
    result = {}
    for state in selected_states:
        types = set()
        for cat_name in common_cats:
            cat = CRIME_CATEGORIES[cat_name]
            type_key = f"{state.lower()}_types"
            if type_key in cat:
                types.update(cat[type_key])
            # Always include sinesp types too (data may come from SINESP VDE)
            types.update(cat.get("sinesp_types", []))
        result[state] = list(types)

    return result


def get_max_granularity(selected_states: list[str]) -> str:
    """Determine the best temporal granularity for selected states.

    Returns "monthly" if all states have monthly data, "yearly" if any
    selected state only has yearly (SINESP VDE) data.
    """
    if not selected_states:
        return "monthly"

    for state in selected_states:
        sources = STATE_SOURCES.get(state)
        if not sources:
            # SINESP-only state
            return "yearly"
        # Check if all sources for this state are monthly
        for src in sources:
            if SOURCE_GRANULARITY.get(src) == "yearly":
                return "yearly"

    return "monthly"


def categorize_crime_types(crime_types: list[dict]) -> list[dict]:
    """Group raw crime types into canonical categories for cross-state comparison.

    Maps state-specific type names (e.g. RS "AMEACA", MG "Homicídio Consumado")
    to canonical category labels (e.g. "Violência contra pessoa").
    """
    reverse_map = {}
    for cat_name, cat in CRIME_CATEGORIES.items():
        label = cat["label"]
        for key in cat:
            if key.endswith("_types"):
                for t in cat[key]:
                    reverse_map[t] = label

    category_counts = {}
    for ct in crime_types:
        tipo = ct.get("tipo_enquadramento", "")
        count = ct.get("count", 0)
        category = reverse_map.get(tipo, "Outros")
        category_counts[category] = category_counts.get(category, 0) + count

    return sorted(
        [{"category": k, "count": v} for k, v in category_counts.items()],
        key=lambda x: x["count"], reverse=True
    )


def get_filter_info(selected_states: list[str]) -> dict:
    """Get complete filter info for the selected states.

    Returns metadata the frontend needs to render the correct UI.
    """
    if not selected_states:
        return {
            "compatible_types": {},
            "max_granularity": "monthly",
            "active_filter": None,
            "needs_filter": False,
        }

    compatible = get_compatible_types(selected_states)
    granularity = get_max_granularity(selected_states)

    # Check if filtering is needed (any partial state selected)
    has_partial = any(s in PARTIAL_STATES for s in selected_states)
    needs_filter = has_partial and len(selected_states) > 1

    active_filter = None
    if needs_filter:
        partial_states = [s for s in selected_states if s in PARTIAL_STATES]
        active_filter = {
            "label": f"Filtrando: apenas crimes compatíveis ({', '.join(partial_states)})",
            "partial_states": partial_states,
        }

    return {
        "compatible_types": compatible,
        "max_granularity": granularity,
        "active_filter": active_filter,
        "needs_filter": needs_filter,
    }
