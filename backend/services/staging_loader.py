"""Download and load crime data for all 27 Brazilian states into crimes_staging table.

Sources:
- SINESP Municipal (all 27 UFs): municipality-level victim counts
- SINESP UF (all 27 UFs): state-level crime breakdowns (ocorrências + vítimas)
- RJ ISP Municipal: RJ municipality-level detailed crime types
- RJ ISP CISP: RJ police-district-level detailed crime types
- MG Violent Crimes: MG municipality-level violent crimes
"""

import os
import json
import logging
import requests
import pandas as pd
from datetime import datetime
from database import CrimeStaging, SessionLocal

logger = logging.getLogger(__name__)
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "staging")

# ── URLs ──────────────────────────────────────────────────────────────────────

SINESP_MUNICIPAL_URL = (
    "http://dados.mj.gov.br/dataset/210b9ae2-21fc-4986-89c6-2006eb4db247"
    "/resource/03af7ce2-174e-4ebd-b085-384503cfb40f/download/"
    "indicadoressegurancapublicamunic.xlsx"
)

SINESP_UF_URL = (
    "http://dados.mj.gov.br/dataset/210b9ae2-21fc-4986-89c6-2006eb4db247"
    "/resource/feeae05e-faba-406c-8a4a-512aec91a9d1/download/"
    "indicadoressegurancapublicauf.xlsx"
)

# SINESP VDE (newer data, per-year XLSX files from gov.br, all 27 UFs)
SINESP_VDE_URLS = {
    year: (
        f"https://www.gov.br/mj/pt-br/assuntos/sua-seguranca/seguranca-publica/"
        f"estatistica/download/dnsp-base-de-dados/bancovde-{year}.xlsx/@@download/file"
    )
    for year in range(2015, datetime.now().year + 1)
}

RJ_ISP_MUNICIPAL_URL = "https://www.ispdados.rj.gov.br/Arquivos/BaseMunicipioMensal.csv"
RJ_ISP_CISP_URL = "https://www.ispdados.rj.gov.br/Arquivos/BaseDPEvolucaoMensalCisp.csv"

# MG resource IDs — try CKAN API first, fallback to known URLs
MG_VIOLENT_DATASET_URL = "https://dados.mg.gov.br/api/3/action/package_show?id=crimes-violentos"
MG_VIOLENT_FALLBACK_URLS = [
    "https://dados.mg.gov.br/dataset/29d89d80-8aaf-438b-a80f-70bb64d10f6f/resource/216a5c59-497e-49d2-bfc0-23cbedb1d665/download/crimes_violentos_2019.csv",
    "https://dados.mg.gov.br/dataset/29d89d80-8aaf-438b-a80f-70bb64d10f6f/resource/637c3391-50ea-4bd5-b2f1-8d2347b4758a/download/crimes_violentos_2020.csv",
    "https://dados.mg.gov.br/dataset/29d89d80-8aaf-438b-a80f-70bb64d10f6f/resource/151a95ee-49af-4feb-9d23-8a6868d82077/download/crimes_violentos_2021.csv",
    "https://dados.mg.gov.br/dataset/29d89d80-8aaf-438b-a80f-70bb64d10f6f/resource/a96028d5-1808-4166-b680-91b3f8f6aa17/download/crimes_violentos_2022.csv",
    "https://dados.mg.gov.br/dataset/29d89d80-8aaf-438b-a80f-70bb64d10f6f/resource/3d935565-0f56-4594-9c26-7b6db71c25d2/download/crimes_violentos_2023.csv",
    "https://dados.mg.gov.br/dataset/29d89d80-8aaf-438b-a80f-70bb64d10f6f/resource/15ac6aff-1349-4589-8739-76ed7c52b3b0/download/crimes_violentos_2024.csv",
    "https://dados.mg.gov.br/dataset/29d89d80-8aaf-438b-a80f-70bb64d10f6f/resource/d23fed6e-c59a-488e-a1da-72c5091edb30/download/crimes_violentos_2025.csv",
    "https://dados.mg.gov.br/dataset/29d89d80-8aaf-438b-a80f-70bb64d10f6f/resource/476f959e-e4bc-4960-b5c4-b3c22fc6fefb/download/crimes_violentos_2026.csv",
]


def download_file(url: str, filename: str | None = None, retries: int = 3) -> str:
    """Download a file to DATA_DIR with retry. Returns local path. Skips if already exists."""
    os.makedirs(DATA_DIR, exist_ok=True)
    if filename is None:
        filename = url.split("/")[-1].split("?")[0]
    dest = os.path.join(DATA_DIR, filename)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        logger.info(f"Already downloaded: {filename}")
        return dest
    for attempt in range(1, retries + 1):
        try:
            logger.info(f"Downloading {url} → {filename} (attempt {attempt}/{retries})...")
            resp = requests.get(url, timeout=300, stream=True,
                                headers={"User-Agent": "CrimeBrasil/1.0"})
            resp.raise_for_status()
            tmp = dest + ".tmp"
            with open(tmp, "wb") as f:
                for chunk in resp.iter_content(chunk_size=65536):
                    f.write(chunk)
            os.rename(tmp, dest)
            logger.info(f"Downloaded {filename} ({os.path.getsize(dest) / 1024 / 1024:.1f} MB)")
            return dest
        except Exception as e:
            logger.warning(f"Download attempt {attempt} failed for {filename}: {e}")
            # Clean up partial download
            for p in [dest, dest + ".tmp"]:
                if os.path.exists(p):
                    os.remove(p)
            if attempt == retries:
                raise
    raise RuntimeError(f"Download failed after {retries} attempts: {url}")


def _safe_int(val) -> int | None:
    """Parse a value to int, returning None on failure."""
    if pd.isna(val):
        return None
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return None


# Brazilian state full name → sigla mapping
UF_NAME_TO_SIGLA = {
    "acre": "AC", "alagoas": "AL", "amapá": "AP", "amapa": "AP",
    "amazonas": "AM", "bahia": "BA", "ceará": "CE", "ceara": "CE",
    "distrito federal": "DF", "espírito santo": "ES", "espirito santo": "ES",
    "goiás": "GO", "goias": "GO", "maranhão": "MA", "maranhao": "MA",
    "mato grosso": "MT", "mato grosso do sul": "MS",
    "minas gerais": "MG", "pará": "PA", "para": "PA",
    "paraíba": "PB", "paraiba": "PB", "paraná": "PR", "parana": "PR",
    "pernambuco": "PE", "piauí": "PI", "piaui": "PI",
    "rio de janeiro": "RJ", "rio grande do norte": "RN",
    "rio grande do sul": "RS", "rondônia": "RO", "rondonia": "RO",
    "roraima": "RR", "santa catarina": "SC", "são paulo": "SP",
    "sao paulo": "SP", "sergipe": "SE", "tocantins": "TO",
}

MONTH_PT_TO_NUM = {
    "janeiro": 1, "fevereiro": 2, "março": 3, "marco": 3,
    "abril": 4, "maio": 5, "junho": 6, "julho": 7,
    "agosto": 8, "setembro": 9, "outubro": 10,
    "novembro": 11, "dezembro": 12,
}


def _normalize_uf(val) -> str | None:
    """Convert state name or sigla to 2-letter UF code."""
    if pd.isna(val):
        return None
    s = str(val).strip()
    if len(s) == 2:
        return s.upper()
    return UF_NAME_TO_SIGLA.get(s.lower())


def _parse_month(val) -> int | None:
    """Parse month from int, string name, or Portuguese text."""
    if pd.isna(val):
        return None
    if isinstance(val, (int, float)):
        return int(val) if 1 <= int(val) <= 12 else None
    s = str(val).strip().lower()
    return MONTH_PT_TO_NUM.get(s) or _safe_int(s)


# ── SINESP Municipal ─────────────────────────────────────────────────────────

def load_sinesp_municipal(db, xlsx_path: str) -> int:
    """Parse SINESP municipal XLSX → crimes_staging rows.
    Expected columns: Cód_IBGE, Município, Sigla UF, Região, Mês/Ano, Vítimas
    (or Portuguese variations).
    """
    logger.info("Loading SINESP municipal data...")
    df = pd.read_excel(xlsx_path, engine="openpyxl")
    # Normalize column names
    df.columns = [c.strip() for c in df.columns]

    # Find columns flexibly
    col_map = {}
    for c in df.columns:
        cl = c.lower().replace("í", "i").replace("ê", "e").replace("ó", "o")
        if "cod" in cl and "ibge" in cl:
            col_map["cod_ibge"] = c
        elif "municipio" in cl or "município" in cl:
            col_map["municipio"] = c
        elif "sigla" in cl and "uf" in cl:
            col_map["state"] = c
        elif "mes" in cl and "ano" in cl:
            col_map["mes_ano"] = c
        elif "vitima" in cl or "vítima" in cl:
            col_map["vitimas"] = c
        elif "tipo" in cl and "crime" in cl:
            col_map["crime_type"] = c
        elif "ocorrencia" in cl or "ocorrência" in cl:
            col_map["ocorrencias"] = c

    if "state" not in col_map:
        logger.error(f"Cannot find UF column. Columns: {list(df.columns)}")
        return 0

    count = 0
    batch = []
    for _, row in df.iterrows():
        state = _normalize_uf(row.get(col_map.get("state", ""), ""))
        if not state:
            continue

        # Parse mes/ano — could be "01/2020", datetime/Timestamp, or "2020-01"
        mes_ano = row.get(col_map.get("mes_ano", ""), "")
        year, month = None, None
        if pd.notna(mes_ano):
            if hasattr(mes_ano, 'year') and hasattr(mes_ano, 'month'):
                # Timestamp or datetime object
                year, month = mes_ano.year, mes_ano.month
            else:
                s = str(mes_ano).strip()
                if "/" in s:
                    parts = s.split("/")
                    month, year = _safe_int(parts[0]), _safe_int(parts[1])
                elif "-" in s:
                    parts = s.split("-")
                    year, month = _safe_int(parts[0]), _safe_int(parts[1])

        crime_type = str(row.get(col_map.get("crime_type", ""), "")).strip()
        if not crime_type or crime_type == "nan":
            crime_type = "Total"

        rec = CrimeStaging(
            source="sinesp_municipal",
            state=state,
            municipio=str(row.get(col_map.get("municipio", ""), "")).strip() or None,
            cod_ibge=_safe_int(row.get(col_map.get("cod_ibge", ""), None)),
            crime_type=crime_type,
            year=year,
            month=month,
            occurrences=_safe_int(row.get(col_map.get("ocorrencias", ""), 0)) or 0,
            victims=_safe_int(row.get(col_map.get("vitimas", ""), 0)) or 0,
        )
        batch.append(rec)
        count += 1
        if len(batch) >= 5000:
            db.bulk_save_objects(batch)
            db.commit()
            batch = []
            logger.info(f"  SINESP municipal: {count} rows...")

    if batch:
        db.bulk_save_objects(batch)
        db.commit()
    logger.info(f"SINESP municipal: {count} total rows loaded")
    return count


# ── SINESP UF ────────────────────────────────────────────────────────────────

def load_sinesp_uf(db, xlsx_path: str) -> dict[str, int]:
    """Parse SINESP UF XLSX (two sheets: Ocorrências and Vítimas) → staging rows.
    Returns dict with counts per sheet.
    """
    logger.info("Loading SINESP UF data...")
    xl = pd.ExcelFile(xlsx_path, engine="openpyxl")
    sheet_names = xl.sheet_names
    logger.info(f"  Sheets found: {sheet_names}")

    counts = {}

    # Process each sheet
    for sheet in sheet_names:
        df = pd.read_excel(xl, sheet_name=sheet)
        df.columns = [c.strip() for c in df.columns]

        sheet_lower = sheet.lower().replace("ê", "e").replace("í", "i")
        if "ocorr" in sheet_lower:
            source_name = "sinesp_uf_ocorrencias"
        elif "vitima" in sheet_lower or "vítima" in sheet_lower:
            source_name = "sinesp_uf_vitimas"
        else:
            source_name = f"sinesp_uf_{sheet.lower().replace(' ', '_')}"

        # Find columns
        col_map = {}
        for c in df.columns:
            cl = c.lower().replace("í", "i").replace("ê", "e").replace("ó", "o")
            if cl == "uf" or (cl.startswith("sigla") and "uf" in cl):
                col_map["state"] = c
            elif "tipo" in cl and "crime" in cl:
                col_map["crime_type"] = c
            elif cl == "ano":
                col_map["year"] = c
            elif cl in ("mes", "mês"):
                col_map["month"] = c
            elif "ocorr" in cl:
                col_map["ocorrencias"] = c
            elif "sexo" in cl:
                col_map["sexo"] = c
            elif "vitima" in cl or "vítima" in cl:
                col_map["vitimas"] = c

        if "state" not in col_map:
            logger.warning(f"  Sheet '{sheet}': no UF column found in {list(df.columns)}, skipping")
            continue

        count = 0
        batch = []
        for _, row in df.iterrows():
            state = _normalize_uf(row.get(col_map.get("state", "")))
            if not state:
                continue
            rec = CrimeStaging(
                source=source_name,
                state=state,
                crime_type=str(row.get(col_map.get("crime_type", ""), "")).strip() or None,
                year=_safe_int(row.get(col_map.get("year", ""), None)),
                month=_parse_month(row.get(col_map.get("month", ""), None)),
                occurrences=_safe_int(row.get(col_map.get("ocorrencias", ""), 0)) or 0,
                victims=_safe_int(row.get(col_map.get("vitimas", ""), 0)) or 0,
                sexo_vitima=str(row.get(col_map.get("sexo", ""), "")).strip() or None,
            )
            if rec.sexo_vitima == "nan":
                rec.sexo_vitima = None
            batch.append(rec)
            count += 1
            if len(batch) >= 5000:
                db.bulk_save_objects(batch)
                db.commit()
                batch = []
                logger.info(f"  {source_name}: {count} rows...")

        if batch:
            db.bulk_save_objects(batch)
            db.commit()
        logger.info(f"  {source_name}: {count} total rows")
        counts[source_name] = count

    return counts


# ── RJ ISP Municipal ─────────────────────────────────────────────────────────

# Crime type columns in RJ ISP CSVs (columns to unpivot)
# Excludes admin/geographic columns (apf, aaapai, cmp, cmba, aisp, risp)
# and summary columns (registro_ocorrencias, cvli, letalidade_violenta, total_roubos, total_furtos)
RJ_CRIME_COLUMNS = [
    "hom_doloso", "lesao_corp_morte", "latrocinio", "hom_por_interv_policial",
    "tentat_hom", "lesao_corp_dolosa", "estupro", "hom_culposo",
    "lesao_corp_culposa", "feminicidio", "tentativa_feminicidio",
    "roubo_transeunte", "roubo_corp_am_am",
    "roubo_em_coletivo", "roubo_veiculo", "roubo_carga", "roubo_celular",
    "roubo_conducao_saque", "roubo_bicicleta", "roubo_comercio",
    "roubo_residencia", "roubo_rua", "roubo_banco", "roubo_cx_eletronico",
    "roubo_apos_saque", "outros_roubos",
    "furto_veiculos", "furto_transeunte", "furto_coletivo",
    "furto_celular", "furto_bicicleta", "outros_furtos",
    "sequestro", "extorsao",
    "sequestro_relampago", "estelionato", "apreensao_drogas",
    "posse_drogas", "trafico_drogas", "recuperacao_veiculos",
    "ameaca", "pessoas_desaparecidas", "encontro_cadaver",
    "encontro_ossada", "pol_militares_mortos_serv",
    "pol_civis_mortos_serv",
]
# Admin/geographic columns to NEVER treat as crime types
RJ_ADMIN_COLUMNS = {
    "apf", "aaapai", "cmp", "cmba", "aisp", "risp",
    "registro_ocorrencias", "cvli", "letalidade_violenta",
    "total_roubos", "total_furtos",
}


def load_rj_municipal(db, csv_path: str) -> int:
    """Parse RJ ISP municipal CSV → staging rows. Unpivots crime columns into rows."""
    logger.info("Loading RJ ISP municipal data...")

    # Try different encodings
    df = None
    for enc in ["latin-1", "utf-8", "cp1252"]:
        try:
            df = pd.read_csv(csv_path, sep=";", encoding=enc, low_memory=False)
            break
        except UnicodeDecodeError:
            continue
    if df is None:
        logger.error("Failed to read RJ municipal CSV with any encoding")
        return 0

    df.columns = [c.strip().lower() for c in df.columns]

    # Find municipality and date columns
    # RJ ISP uses 'fmun' for municipality name and 'fmun_cod' for IBGE code
    mun_col = None
    ibge_col = None
    for c in df.columns:
        cl = c.lower()
        if cl == "fmun":
            mun_col = c
        elif cl == "fmun_cod" or (cl.startswith("cod") and "mun" in cl):
            ibge_col = c
        elif "munic" in cl and "cod" not in cl and mun_col is None:
            mun_col = c

    month_col = next((c for c in df.columns if c in ("mes", "mês", "mes_ano", "mes_fato")), None)
    year_col = next((c for c in df.columns if c in ("ano", "year", "ano_fato")), None)

    # Find which crime columns exist in the dataframe, excluding admin columns
    crime_cols = [c for c in RJ_CRIME_COLUMNS if c in df.columns and c not in RJ_ADMIN_COLUMNS]
    if not crime_cols:
        # Try matching without exact case
        crime_cols = [c for c in df.columns if c not in RJ_ADMIN_COLUMNS and any(
            rc in c for rc in ["hom_", "roubo_", "furto_", "estupro", "latrocinio",
                                "lesao_", "sequestro", "extorsao", "trafico_", "ameaca"]
        )]

    if not crime_cols:
        logger.error(f"No crime columns found. Columns: {list(df.columns)}")
        return 0

    logger.info(f"  Found {len(crime_cols)} crime columns, {len(df)} rows to unpivot")

    logger.info(f"  Municipality column: {mun_col}, IBGE column: {ibge_col}")

    count = 0
    batch = []
    for _, row in df.iterrows():
        municipio = str(row.get(mun_col, "")).strip() if mun_col else None
        if municipio and municipio.lower() == "nan":
            municipio = None
        cod_ibge = _safe_int(row.get(ibge_col)) if ibge_col else None
        year = _safe_int(row.get(year_col)) if year_col else None
        month = _safe_int(row.get(month_col)) if month_col else None

        for crime_col in crime_cols:
            val = _safe_int(row.get(crime_col, 0))
            if val is None or val == 0:
                continue
            rec = CrimeStaging(
                source="rj_isp_municipal",
                state="RJ",
                municipio=municipio,
                cod_ibge=cod_ibge,
                crime_type=crime_col,
                year=year,
                month=month,
                occurrences=val,
                victims=0,
            )
            batch.append(rec)
            count += 1
            if len(batch) >= 5000:
                db.bulk_save_objects(batch)
                db.commit()
                batch = []
                logger.info(f"  RJ municipal: {count} rows...")

    if batch:
        db.bulk_save_objects(batch)
        db.commit()
    logger.info(f"RJ ISP municipal: {count} total rows loaded")
    return count


# ── RJ ISP CISP (Police District) ────────────────────────────────────────────

def load_rj_cisp(db, csv_path: str) -> int:
    """Parse RJ ISP CISP CSV → staging rows. Unpivots crime columns."""
    logger.info("Loading RJ ISP CISP data...")

    df = None
    for enc in ["latin-1", "utf-8", "cp1252"]:
        try:
            df = pd.read_csv(csv_path, sep=";", encoding=enc, low_memory=False)
            break
        except UnicodeDecodeError:
            continue
    if df is None:
        logger.error("Failed to read RJ CISP CSV with any encoding")
        return 0

    df.columns = [c.strip().lower() for c in df.columns]

    # Find key columns — CISP also uses fmun for municipality
    cisp_col = next((c for c in df.columns if "cisp" in c), None)
    mun_col = None
    ibge_col = None
    for c in df.columns:
        cl = c.lower()
        if cl == "fmun":
            mun_col = c
        elif cl == "fmun_cod" or (cl.startswith("cod") and "mun" in cl):
            ibge_col = c
        elif "munic" in cl and "cod" not in cl and mun_col is None:
            mun_col = c
    month_col = next((c for c in df.columns if c in ("mes", "mês", "mes_ano", "mes_fato")), None)
    year_col = next((c for c in df.columns if c in ("ano", "year", "ano_fato")), None)

    crime_cols = [c for c in RJ_CRIME_COLUMNS if c in df.columns and c not in RJ_ADMIN_COLUMNS]
    if not crime_cols:
        crime_cols = [c for c in df.columns if c not in RJ_ADMIN_COLUMNS and any(
            rc in c for rc in ["hom_", "roubo_", "furto_", "estupro", "latrocinio",
                                "lesao_", "sequestro", "extorsao", "trafico_", "ameaca"]
        )]

    if not crime_cols:
        logger.error(f"No crime columns found in CISP. Columns: {list(df.columns)}")
        return 0

    logger.info(f"  Found {len(crime_cols)} crime columns, {len(df)} rows to unpivot")

    count = 0
    batch = []
    for _, row in df.iterrows():
        municipio = str(row.get(mun_col, "")).strip() if mun_col else None
        if municipio and municipio.lower() == "nan":
            municipio = None
        cod_ibge = _safe_int(row.get(ibge_col)) if ibge_col else None
        year = _safe_int(row.get(year_col)) if year_col else None
        month = _safe_int(row.get(month_col)) if month_col else None

        extra = {}
        if cisp_col and pd.notna(row.get(cisp_col)):
            extra["cisp"] = str(row[cisp_col]).strip()

        extra_str = json.dumps(extra) if extra else None

        for crime_col in crime_cols:
            val = _safe_int(row.get(crime_col, 0))
            if val is None or val == 0:
                continue
            rec = CrimeStaging(
                source="rj_isp_cisp",
                state="RJ",
                municipio=municipio,
                cod_ibge=cod_ibge,
                crime_type=crime_col,
                year=year,
                month=month,
                occurrences=val,
                victims=0,
                extra_json=extra_str,
            )
            batch.append(rec)
            count += 1
            if len(batch) >= 5000:
                db.bulk_save_objects(batch)
                db.commit()
                batch = []
                logger.info(f"  RJ CISP: {count} rows...")

    if batch:
        db.bulk_save_objects(batch)
        db.commit()
    logger.info(f"RJ ISP CISP: {count} total rows loaded")
    return count


# ── SINESP VDE (gov.br, newer data 2015-2026) ────────────────────────────────

# Only import these crime-relevant event types from VDE data.
# Forms 1,2,3,7 use total_vitima as count; Forms 4,6,8,9 use total as count.
SINESP_VDE_CRIME_EVENTS = {
    # Form 1 — violent crimes against persons (use total_vitima)
    "Homicídio doloso",
    "Feminicídio",
    "Tentativa de homicídio",
    "Tentativa de feminicídio",
    "Lesão corporal seguida de morte",
    "Roubo seguido de morte (latrocínio)",
    # Form 2 — deaths by intervention (use total_vitima)
    "Morte por intervenção de Agente do Estado",
    # Form 3 — sexual crimes (use total_vitima)
    "Estupro",
    "Estupro de vulnerável",
    # Form 4 — property crimes (use total)
    "Furto de veículo",
    "Roubo a instituição financeira",
    "Roubo de carga",
    "Roubo de veículo",
    # Form 7 — drug trafficking (use total_vitima for victim count)
    "Tráfico de drogas",
}

# Events that use total_vitima (victim count) instead of total (occurrence count)
SINESP_VDE_VICTIM_EVENTS = {
    "Homicídio doloso", "Feminicídio", "Tentativa de homicídio",
    "Tentativa de feminicídio", "Lesão corporal seguida de morte",
    "Roubo seguido de morte (latrocínio)",
    "Morte por intervenção de Agente do Estado",
    "Estupro", "Estupro de vulnerável",
    "Tráfico de drogas",
}

# Normalize VDE event names for matching (strip accents)
def _normalize_evento(s: str) -> str:
    import unicodedata
    nfkd = unicodedata.normalize('NFD', s)
    return ''.join(c for c in nfkd if unicodedata.category(c) != 'Mn').strip()

_VDE_CRIME_EVENTS_NORM = {_normalize_evento(e): e for e in SINESP_VDE_CRIME_EVENTS}
_VDE_VICTIM_EVENTS_NORM = {_normalize_evento(e) for e in SINESP_VDE_VICTIM_EVENTS}


def load_sinesp_vde(db, xlsx_path: str, year: int) -> int:
    """Parse SINESP VDE yearly XLSX → staging rows.
    These files have UF-level crime data with columns varying by year.

    Fixed column detection:
    - crime_type: 'evento' column (not 'tipo_crime')
    - year: parsed from 'data_referencia' datetime (not 'ano')
    - month: set to None (VDE is yearly data only)
    - count: 'total' for property crimes, 'total_vitima' for violent/sexual crimes
    """
    logger.info(f"Loading SINESP VDE {year} data from {xlsx_path}...")
    try:
        xl = pd.ExcelFile(xlsx_path, engine="openpyxl")
    except Exception as e:
        logger.error(f"  Failed to open VDE {year}: {e}")
        return 0

    total_count = 0
    for sheet in xl.sheet_names:
        df = pd.read_excel(xl, sheet_name=sheet)
        df.columns = [str(c).strip() for c in df.columns]

        # Flexible column detection for VDE files
        col_map = {}
        for c in df.columns:
            cl = c.lower().replace("í", "i").replace("ê", "e").replace("ó", "o")
            if cl == "uf" or (cl.startswith("sigla") and "uf" in cl):
                col_map["state"] = c
            # VDE uses 'evento' instead of 'tipo_crime'
            elif cl == "evento" or cl == "evento_ssp":
                col_map["crime_type"] = c
            elif "tipo" in cl and "crime" in cl:
                col_map["crime_type"] = col_map.get("crime_type", c)
            # VDE uses 'data_referencia' datetime instead of 'ano'/'mes'
            elif "data" in cl and "referencia" in cl:
                col_map["data_referencia"] = c
            elif cl == "ano":
                col_map["year"] = c
            elif cl in ("mes", "mês"):
                col_map["month"] = c
            # VDE uses 'total' for property crime occurrence count
            elif cl == "total":
                col_map["total"] = c
            # VDE uses 'total_vitima' for violent crime victim count
            elif cl == "total_vitima" or cl == "total_vitimas":
                col_map["total_vitima"] = c
            elif "ocorr" in cl:
                col_map["ocorrencias"] = c
            elif ("vitima" in cl or "vítima" in cl) and "sexo" not in cl and "total" not in cl:
                col_map["vitimas"] = c
            elif "sexo" in cl:
                col_map["sexo"] = c
            elif "municipio" in cl or "município" in cl:
                col_map["municipio"] = c
            elif "cod" in cl and "ibge" in cl:
                col_map["cod_ibge"] = c
            elif cl == "formulario" or cl == "form":
                col_map["formulario"] = c

        if "state" not in col_map:
            logger.warning(f"  VDE {year} sheet '{sheet}': no UF column in {list(df.columns)}, skipping")
            continue

        logger.info(f"  VDE {year} sheet '{sheet}': columns mapped: {col_map}")

        count = 0
        skipped_non_crime = 0
        batch = []
        for _, row in df.iterrows():
            state = str(row.get(col_map.get("state", ""), "")).strip().upper()
            if not state or len(state) != 2:
                continue

            # Get crime type from 'evento' or 'tipo_crime' column
            crime_type_raw = str(row.get(col_map.get("crime_type", ""), "")).strip()
            if not crime_type_raw or crime_type_raw == "nan":
                crime_type_raw = None

            # Filter non-crime events — only keep actual crime types
            if crime_type_raw:
                crime_norm = _normalize_evento(crime_type_raw)
                canonical = _VDE_CRIME_EVENTS_NORM.get(crime_norm)
                if canonical is None:
                    skipped_non_crime += 1
                    continue
                crime_type = canonical
                is_victim_event = crime_norm in _VDE_VICTIM_EVENTS_NORM
            else:
                continue  # Skip rows with no event type

            # Parse year from data_referencia (datetime) or ano column
            row_year = year
            if "data_referencia" in col_map:
                dr = row.get(col_map["data_referencia"])
                if pd.notna(dr):
                    if hasattr(dr, 'year'):
                        row_year = dr.year
                    else:
                        # Try parsing "YYYY-MM-DD" or "YYYY"
                        dr_str = str(dr).strip()
                        yr = _safe_int(dr_str[:4])
                        if yr:
                            row_year = yr
            elif "year" in col_map:
                row_year = _safe_int(row.get(col_map["year"], year)) or year

            # VDE data is yearly only — month is always None
            row_month = None
            if "month" in col_map:
                row_month = _safe_int(row.get(col_map["month"]))

            # Select count column based on event type
            if is_victim_event and "total_vitima" in col_map:
                count_val = _safe_int(row.get(col_map["total_vitima"], 0)) or 0
                occ = 0
                vic = count_val
            elif "total" in col_map:
                count_val = _safe_int(row.get(col_map["total"], 0)) or 0
                occ = count_val
                vic = 0
            elif "ocorrencias" in col_map:
                occ = _safe_int(row.get(col_map["ocorrencias"], 0)) or 0
                vic = _safe_int(row.get(col_map.get("vitimas", ""), 0)) or 0
            else:
                occ = 0
                vic = _safe_int(row.get(col_map.get("vitimas", ""), 0)) or 0

            if occ == 0 and vic == 0:
                continue

            sexo = str(row.get(col_map.get("sexo", ""), "")).strip()
            if sexo == "nan":
                sexo = None

            rec = CrimeStaging(
                source=f"sinesp_vde_{year}",
                state=state,
                municipio=str(row.get(col_map.get("municipio", ""), "")).strip() or None,
                cod_ibge=_safe_int(row.get(col_map.get("cod_ibge", ""), None)),
                crime_type=crime_type,
                year=row_year,
                month=row_month,
                occurrences=occ,
                victims=vic,
                sexo_vitima=sexo if sexo else None,
            )
            batch.append(rec)
            count += 1
            if len(batch) >= 5000:
                db.bulk_save_objects(batch)
                db.commit()
                batch = []

        if batch:
            db.bulk_save_objects(batch)
            db.commit()
        total_count += count
        logger.info(f"  VDE {year} sheet '{sheet}': {count} rows loaded, {skipped_non_crime} non-crime events skipped")

    logger.info(f"SINESP VDE {year}: {total_count} total rows loaded")
    return total_count


# ── MG Violent Crimes ─────────────────────────────────────────────────────────

def _discover_mg_urls() -> list[str]:
    """Discover MG violent crime CSV URLs via CKAN API."""
    try:
        resp = requests.get(MG_VIOLENT_DATASET_URL, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        resources = data.get("result", {}).get("resources", [])
        urls = [r["url"] for r in resources if r.get("url") and r.get("format", "").upper() == "CSV"]
        logger.info(f"Discovered {len(urls)} MG CSV resources from CKAN API")
        return urls
    except Exception as e:
        logger.warning(f"MG CKAN API discovery failed: {e}")
        return []


_MG_CANONICAL_NAMES = {
    "Estupro De Vulneravel Consumado": "Estupro De Vulnerável Consumado",
    "Estupro De Vulneravel Tentado": "Estupro De Vulnerável Tentado",
    "Extorsao Consumado": "Extorsão Consumado",
    "Extorsao Tentado": "Extorsão Tentado",
    "Extorsao Mediante Sequestro Consumado": "Extorsão Mediante Sequestro Consumado",
    "Extorsao Mediante Sequestro Tentado": "Extorsão Mediante Sequestro Tentado",
    "Homicidio Consumado (Registros)": "Homicídio Consumado (Registros)",
    "Homicidio Tentado": "Homicídio Tentado",
    "Feminicidio Consumado (Registros)": "Feminicídio Consumado (Registros)",
    "Feminicidio Tentado": "Feminicídio Tentado",
    "Sequestro E Carcere Privado Consumado": "Sequestro E Cárcere Privado Consumado",
    "Sequestro E Carcere Privado Tentado": "Sequestro E Cárcere Privado Tentado",
    "Lesao Corporal Consumado": "Lesão Corporal Consumado",
    "Lesao Corporal Tentado": "Lesão Corporal Tentado",
}


def _fix_mg_encoding(s: str) -> str:
    """Fix mojibake in MG crime type names.

    MG CSVs are often ISO-8859-1 but sometimes get double-encoded.
    Try re-encoding latin-1→utf-8 to fix, then normalize to title case.
    Finally, apply canonical name mapping to merge accent-free variants.
    """
    if not s or s == "nan":
        return s
    try:
        fixed = s.encode('latin-1').decode('utf-8')
    except (UnicodeDecodeError, UnicodeEncodeError):
        fixed = s
    # Normalize to title case (e.g., "HOMICIDIO CONSUMADO" → "Homicidio Consumado")
    result = fixed.strip().title()
    return _MG_CANONICAL_NAMES.get(result, result)


def load_mg_violent(db, csv_path: str) -> int:
    """Parse MG violent crimes CSV → staging rows.
    Expected columns: registros, natureza, municipio, cod_municipio, mes, ano, risp, rmbh
    """
    logger.info("Loading MG violent crimes data...")

    df = None
    for enc in ["latin-1", "utf-8", "cp1252"]:
        try:
            df = pd.read_csv(csv_path, sep=";", encoding=enc, low_memory=False)
            break
        except UnicodeDecodeError:
            continue
    if df is None:
        logger.error("Failed to read MG CSV with any encoding")
        return 0

    df.columns = [c.strip().lower() for c in df.columns]

    count = 0
    batch = []
    for _, row in df.iterrows():
        extra = {}
        if "risp" in df.columns and pd.notna(row.get("risp")):
            extra["risp"] = str(row["risp"]).strip()
        if "rmbh" in df.columns and pd.notna(row.get("rmbh")):
            extra["rmbh"] = str(row["rmbh"]).strip()

        # Fix encoding mojibake in crime type names
        raw_natureza = str(row.get("natureza", "")).strip()
        crime_type = _fix_mg_encoding(raw_natureza) if raw_natureza else None
        if crime_type and crime_type.lower() == "nan":
            crime_type = None

        rec = CrimeStaging(
            source="mg_violent",
            state="MG",
            municipio=str(row.get("municipio", "")).strip() or None,
            cod_ibge=_safe_int(row.get("cod_municipio")),
            crime_type=crime_type,
            year=_safe_int(row.get("ano")),
            month=_safe_int(row.get("mes")),
            occurrences=_safe_int(row.get("registros")) or 0,
            victims=0,
            extra_json=json.dumps(extra) if extra else None,
        )
        batch.append(rec)
        count += 1
        if len(batch) >= 5000:
            db.bulk_save_objects(batch)
            db.commit()
            batch = []
            logger.info(f"  MG violent: {count} rows...")

    if batch:
        db.bulk_save_objects(batch)
        db.commit()
    logger.info(f"MG violent crimes: {count} total rows loaded")
    return count


# ── Orchestrator ──────────────────────────────────────────────────────────────

def run_full_staging_load() -> dict:
    """Download all sources and load into crimes_staging. Returns per-source counts."""
    from database import init_db
    init_db()
    db = SessionLocal()
    results = {}

    try:
        # Clear existing staging data
        deleted = db.query(CrimeStaging).delete()
        db.commit()
        logger.info(f"Cleared {deleted} existing staging rows")

        # 1. SINESP Municipal (older data, dados.mj.gov.br)
        try:
            path = download_file(SINESP_MUNICIPAL_URL, "sinesp_municipal.xlsx")
            results["sinesp_municipal"] = load_sinesp_municipal(db, path)
        except Exception as e:
            logger.error(f"SINESP municipal failed: {e}")
            results["sinesp_municipal"] = f"ERROR: {e}"

        # 2. SINESP UF (older data, dados.mj.gov.br)
        try:
            path = download_file(SINESP_UF_URL, "sinesp_uf.xlsx")
            uf_counts = load_sinesp_uf(db, path)
            results.update(uf_counts)
        except Exception as e:
            logger.error(f"SINESP UF failed: {e}")
            results["sinesp_uf"] = f"ERROR: {e}"

        # 3. SINESP VDE (newer data, gov.br — all 27 UFs, 2015-2026)
        for year, url in SINESP_VDE_URLS.items():
            try:
                path = download_file(url, f"sinesp_vde_{year}.xlsx")
                count = load_sinesp_vde(db, path, year)
                results[f"sinesp_vde_{year}"] = count
            except Exception as e:
                logger.warning(f"SINESP VDE {year} failed: {e}")
                results[f"sinesp_vde_{year}"] = f"SKIPPED: {e}"

        # 4. RJ ISP Municipal — SKIPPED: redundant with CISP (same totals, less granular)
        # Municipal is an aggregation of CISP data; loading both causes double-counting.
        results["rj_isp_municipal"] = "SKIPPED (redundant with CISP)"

        # 5. RJ ISP CISP
        try:
            path = download_file(RJ_ISP_CISP_URL, "rj_isp_cisp.csv")
            results["rj_isp_cisp"] = load_rj_cisp(db, path)
        except Exception as e:
            logger.error(f"RJ ISP CISP failed: {e}")
            results["rj_isp_cisp"] = f"ERROR: {e}"

        # 6. MG Violent Crimes (CKAN API → fallback to known URLs)
        mg_urls = _discover_mg_urls() or MG_VIOLENT_FALLBACK_URLS
        for i, url in enumerate(mg_urls):
            try:
                path = download_file(url, f"mg_violent_{i}.csv")
                results[f"mg_violent_{i}"] = load_mg_violent(db, path)
            except Exception as e:
                logger.warning(f"MG violent crimes {i} failed: {e}")
                results[f"mg_violent_{i}"] = f"SKIPPED: {e}"

        # Deduplicate: for states with dedicated importers (RJ from ISP),
        # SINESP VDE data overlaps. Prefer dedicated importers.
        # Keep MG VDE since it adds property crime types MG Violent lacks.
        try:
            vde_rj_deleted = db.query(CrimeStaging).filter(
                CrimeStaging.source.like("sinesp_vde%"),
                CrimeStaging.state == "RJ"
            ).delete(synchronize_session=False)
            db.commit()
            if vde_rj_deleted:
                logger.info(f"Dedup: removed {vde_rj_deleted} SINESP VDE rows for RJ (ISP data preferred)")
                results["_dedup_rj_vde"] = vde_rj_deleted
        except Exception as e:
            logger.warning(f"Dedup step failed: {e}")
            db.rollback()

        # Summary
        total = sum(v for v in results.values() if isinstance(v, int))
        results["_total"] = total
        states = db.query(CrimeStaging.state).distinct().count()
        results["_distinct_states"] = states
        logger.info(f"Staging load complete: {total} total rows, {states} distinct states")

    except Exception as e:
        logger.error(f"Staging load error: {e}")
        db.rollback()
        results["_error"] = str(e)
    finally:
        db.close()

    return results


def refresh_staging_data() -> dict:
    """Delete cached files in data/staging/ to force fresh download, then run full staging load."""
    import glob
    if os.path.exists(DATA_DIR):
        for f in glob.glob(os.path.join(DATA_DIR, "*")):
            try:
                os.remove(f)
                logger.info(f"Deleted cached file: {os.path.basename(f)}")
            except OSError as e:
                logger.warning(f"Failed to delete {f}: {e}")
    return run_full_staging_load()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    results = run_full_staging_load()
    print(json.dumps(results, indent=2, default=str))
