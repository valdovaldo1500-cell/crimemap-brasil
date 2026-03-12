"""Download and load crime data into crimes_staging table.

Sources:
- RJ ISP CISP: RJ police-district-level detailed crime types
- MG Violent Crimes: MG municipality-level violent crimes
"""

import os
import json
import logging
import requests
import pandas as pd
from database import CrimeStaging, SessionLocal

logger = logging.getLogger(__name__)
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "staging")

# ── URLs ──────────────────────────────────────────────────────────────────────

RJ_ISP_CISP_URL = "https://www.ispdados.rj.gov.br/Arquivos/BaseDPEvolucaoMensalCisp.csv"

# MG resource IDs — try CKAN API first, fallback to known URLs
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


# ── RJ ISP CISP (Police District) ────────────────────────────────────────────

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


# ── MG Violent Crimes ─────────────────────────────────────────────────────────

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
    for enc in ["utf-8-sig", "utf-8", "latin-1", "cp1252"]:
        try:
            df = pd.read_csv(csv_path, sep=";", encoding=enc, low_memory=False)
            break
        except UnicodeDecodeError:
            continue
    if df is None:
        logger.error("Failed to read MG CSV with any encoding")
        return 0

    # Strip BOM and whitespace from column names (handles latin-1 misread of UTF-8 BOM)
    df.columns = [c.lstrip('\ufeffï»¿').strip().lower() for c in df.columns]

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

def _discover_mg_urls() -> list[str]:
    """Discover MG violent crime CSV URLs via CKAN API."""
    MG_VIOLENT_DATASET_URL = "https://dados.mg.gov.br/api/3/action/package_show?id=crimes-violentos"
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


def run_full_staging_load(db=None) -> dict:
    """Download all sources and load into crimes_staging. Returns per-source counts."""
    from database import init_db
    init_db()
    owns_session = db is None
    if db is None:
        db = SessionLocal()
    results = {}

    try:
        # Clear existing staging data
        deleted = db.query(CrimeStaging).delete()
        db.commit()
        logger.info(f"Cleared {deleted} existing staging rows")

        # 1. RJ ISP CISP
        try:
            path = download_file(RJ_ISP_CISP_URL, "rj_isp_cisp.csv")
            results["rj_isp_cisp"] = load_rj_cisp(db, path)
        except Exception as e:
            logger.error(f"RJ ISP CISP failed: {e}")
            results["rj_isp_cisp"] = f"ERROR: {e}"

        # 2. MG Violent Crimes (CKAN API → fallback to known URLs)
        mg_urls = _discover_mg_urls() or MG_VIOLENT_FALLBACK_URLS
        for i, url in enumerate(mg_urls):
            try:
                path = download_file(url, f"mg_violent_{i}.csv")
                results[f"mg_violent_{i}"] = load_mg_violent(db, path)
            except Exception as e:
                logger.warning(f"MG violent crimes {i} failed: {e}")
                results[f"mg_violent_{i}"] = f"SKIPPED: {e}"

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
        if owns_session:
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
    import json as _json
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    results = run_full_staging_load()
    print(_json.dumps(results, indent=2, default=str))
