"""Integration tests: full ingestion pipeline on an isolated temp SQLite DB.

Validates that ingestion functions correctly parse source files and insert the
right number of records. Uses local cached files (backend/data/*.zip and
backend/data/staging/) — no network downloads if files already exist.

Run with:
    cd backend && python -m pytest tests/test_ingestion_pipeline.py -v --tb=short -s
"""
import csv
import glob
import io
import os
import unicodedata
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, event, func
from sqlalchemy.orm import sessionmaker

# ── Paths ────────────────────────────────────────────────────────────────────
BACKEND_DIR = Path(__file__).parent.parent
DATA_DIR = BACKEND_DIR / "data"
STAGING_DIR = DATA_DIR / "staging"

# ── RJ: crime columns used by load_rj_cisp (matches staging_loader.py) ───────
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

RJ_ADMIN_COLUMNS = {
    "apf", "aaapai", "cmp", "cmba", "aisp", "risp",
    "registro_ocorrencias", "cvli", "letalidade_violenta",
    "total_roubos", "total_furtos",
}


# ── SQLite UDF (mirrors production database.py) ───────────────────────────────
def _normalize_text_sqlite(s: str) -> str:
    if not s:
        return ""
    nfkd = unicodedata.normalize("NFD", s)
    return "".join(c for c in nfkd if unicodedata.category(c) != "Mn").upper().strip()


# ── Shared temp DB fixture (module scope — persists across all tests) ─────────
@pytest.fixture(scope="module")
def test_db(tmp_path_factory):
    """Fresh isolated SQLite DB for the entire test module."""
    import sys
    sys.path.insert(0, str(BACKEND_DIR))
    from database import Base

    db_path = tmp_path_factory.mktemp("pipeline") / "test_pipeline.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def _register_udf(dbapi_conn, _record):
        dbapi_conn.create_function("normalize_text", 1, _normalize_text_sqlite)

    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


# ── Helper: count rows in RS ZIP ──────────────────────────────────────────────
def _count_zip_rows(zip_path: str) -> int:
    """Count data rows (skip header) in the CSV inside a RS ZIP file."""
    with zipfile.ZipFile(zip_path) as zf:
        csv_name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
        with zf.open(csv_name) as raw:
            reader = csv.reader(io.TextIOWrapper(raw, encoding="latin-1"), delimiter=";")
            next(reader)  # skip header
            return sum(1 for _ in reader)


# ── Helper: sum RJ 42-column source ──────────────────────────────────────────
def _sum_rj_source(csv_path: str) -> int:
    """Sum all individual crime columns from rj_isp_cisp.csv (matching load_rj_cisp logic)."""
    total = 0
    for enc in ["latin-1", "utf-8", "cp1252"]:
        try:
            with open(csv_path, encoding=enc, errors="replace") as f:
                reader = csv.DictReader(f, delimiter=";")
                # Normalize column names to lowercase (matches load_rj_cisp)
                raw_rows = list(reader)
                if not raw_rows:
                    break
                # Get fieldnames normalized
                fieldnames = [k.strip().lower() for k in raw_rows[0].keys()]
                crime_cols = [c for c in RJ_CRIME_COLUMNS if c in fieldnames and c not in RJ_ADMIN_COLUMNS]
                for row in raw_rows:
                    # Re-map keys to lowercase
                    normalized_row = {k.strip().lower(): v for k, v in row.items()}
                    for col in crime_cols:
                        val = normalized_row.get(col, "") or "0"
                        try:
                            int_val = int(float(val.replace(",", ".")))
                            if int_val > 0:
                                total += int_val
                        except (ValueError, TypeError):
                            pass
            break
        except Exception:
            continue
    return total


# ── Helper: sum MG source ─────────────────────────────────────────────────────
def _sum_mg_source(csv_paths: list) -> int:
    """Sum `registros` column across all MG violent CSV files."""
    total = 0
    for path in csv_paths:
        for enc in ("utf-8-sig", "utf-8", "latin-1", "cp1252"):
            try:
                with open(path, encoding=enc, errors="replace") as f:
                    reader = csv.DictReader(f, delimiter=";")
                    for row in reader:
                        # find registros column (case-insensitive, strip BOM)
                        for k, v in row.items():
                            k_clean = k.lstrip('\ufeffï»¿').strip().lower()
                            if k_clean == "registros":
                                try:
                                    total += int(float((v or "0").replace(",", ".")))
                                except (ValueError, TypeError):
                                    pass
                break
            except Exception:
                continue
    return total


# ═════════════════════════════════════════════════════════════════════════════
# RS INGESTION TESTS
# ═════════════════════════════════════════════════════════════════════════════

class TestRSIngestion:
    """Each RS ZIP is ingested and its DB count must exactly match the source CSV row count."""

    @pytest.fixture(scope="class", autouse=True)
    def ingest_rs(self, test_db):
        """Run RS ingestion once for the whole class."""
        import sys
        sys.path.insert(0, str(BACKEND_DIR))
        from services.data_ingestion import KNOWN_URLS, ingest_from_url

        with patch("services.data_ingestion.GeocoderService") as mock_geo_cls:
            mock_geo_cls.return_value.geocode_location.return_value = None
            for url in KNOWN_URLS:
                ingest_from_url(url, db=test_db, state="RS")

    def test_rs_2022(self, test_db):
        self._check_zip(test_db, "2022")

    def test_rs_2023(self, test_db):
        self._check_zip(test_db, "2023")

    def test_rs_2024(self, test_db):
        self._check_zip(test_db, "2024")

    def test_rs_2025(self, test_db):
        self._check_zip(test_db, "2025")

    def test_rs_2026(self, test_db):
        self._check_zip(test_db, "2026")

    def _check_zip(self, db, year_substr: str):
        import sys
        sys.path.insert(0, str(BACKEND_DIR))
        from database import Crime

        zip_files = [f for f in glob.glob(str(DATA_DIR / "*.zip")) if year_substr in Path(f).name]
        if not zip_files:
            pytest.skip(f"No ZIP found for year {year_substr}")

        zip_path = zip_files[0]
        fname = Path(zip_path).name
        source_count = _count_zip_rows(zip_path)

        db_count = (
            db.query(func.count(Crime.id))
            .filter(Crime.source_file == fname)
            .scalar()
        )
        assert db_count == source_count, (
            f"RS {year_substr} ({fname}): source={source_count:,}, db={db_count:,}"
        )
        print(f"\n  RS {year_substr}: {db_count:,} rows OK")


# ═════════════════════════════════════════════════════════════════════════════
# RJ STAGING TESTS
# ═════════════════════════════════════════════════════════════════════════════

class TestRJStagingIngestion:
    @pytest.fixture(scope="class", autouse=True)
    def ingest_rj(self, test_db):
        import sys
        sys.path.insert(0, str(BACKEND_DIR))
        from services.staging_loader import load_rj_cisp

        cisp_path = STAGING_DIR / "rj_isp_cisp.csv"
        if not cisp_path.exists():
            pytest.skip("rj_isp_cisp.csv not found — run refresh-staging first")
        load_rj_cisp(test_db, str(cisp_path))

    def test_rj_cisp_total_occurrences(self, test_db):
        import sys
        sys.path.insert(0, str(BACKEND_DIR))
        from database import CrimeStaging

        cisp_path = STAGING_DIR / "rj_isp_cisp.csv"
        if not cisp_path.exists():
            pytest.skip("rj_isp_cisp.csv not found")

        source_sum = _sum_rj_source(str(cisp_path))
        db_sum = (
            test_db.query(func.sum(CrimeStaging.occurrences))
            .filter(CrimeStaging.state == "RJ")
            .scalar()
            or 0
        )
        assert db_sum == source_sum, (
            f"RJ CISP total: source={source_sum:,}, db={db_sum:,}"
        )
        print(f"\n  RJ staging: {db_sum:,} occurrences OK")


# ═════════════════════════════════════════════════════════════════════════════
# MG STAGING TESTS
# ═════════════════════════════════════════════════════════════════════════════

class TestMGStagingIngestion:
    @pytest.fixture(scope="class", autouse=True)
    def ingest_mg(self, test_db):
        import sys
        sys.path.insert(0, str(BACKEND_DIR))
        from services.staging_loader import load_mg_violent

        mg_files = sorted(glob.glob(str(STAGING_DIR / "mg_violent_*.csv")))
        if not mg_files:
            pytest.skip("No mg_violent_*.csv files found — run refresh-staging first")
        for path in mg_files:
            load_mg_violent(test_db, path)

    def test_mg_violent_total_occurrences(self, test_db):
        import sys
        sys.path.insert(0, str(BACKEND_DIR))
        from database import CrimeStaging

        mg_files = sorted(glob.glob(str(STAGING_DIR / "mg_violent_*.csv")))
        if not mg_files:
            pytest.skip("No mg_violent_*.csv files found")

        source_sum = _sum_mg_source(mg_files)
        db_sum = (
            test_db.query(func.sum(CrimeStaging.occurrences))
            .filter(CrimeStaging.state == "MG")
            .scalar()
            or 0
        )
        assert db_sum == source_sum, (
            f"MG violent total: source={source_sum:,}, db={db_sum:,}"
        )
        print(f"\n  MG staging: {db_sum:,} occurrences OK")


# ═════════════════════════════════════════════════════════════════════════════
# SINESP CONTAMINATION CHECK
# ═════════════════════════════════════════════════════════════════════════════

def test_no_sinesp_contamination(test_db):
    """After all ingestion, staging table must have zero SINESP rows."""
    import sys
    sys.path.insert(0, str(BACKEND_DIR))
    from database import CrimeStaging

    count = (
        test_db.query(func.count(CrimeStaging.id))
        .filter(CrimeStaging.source.like("sinesp%"))
        .scalar()
        or 0
    )
    assert count == 0, f"Found {count} SINESP rows — SINESP should never be loaded"


# ═════════════════════════════════════════════════════════════════════════════
# FULL STAGING ORCHESTRATION TEST
# ═════════════════════════════════════════════════════════════════════════════

def test_run_full_staging_load_orchestration(tmp_path_factory):
    """run_full_staging_load() completes without error and returns correct structure."""
    import sys
    sys.path.insert(0, str(BACKEND_DIR))
    from database import Base, CrimeStaging
    from services.staging_loader import run_full_staging_load

    # Fresh isolated DB for this test
    db_path = tmp_path_factory.mktemp("orch") / "orch.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def _register_udf(dbapi_conn, _record):
        dbapi_conn.create_function("normalize_text", 1, _normalize_text_sqlite)

    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    db = Session()

    try:
        results = run_full_staging_load(db=db)

        # No error
        assert "_error" not in results, f"Staging load error: {results.get('_error')}"

        # RJ and MG keys present with integer counts
        assert "rj_isp_cisp" in results
        assert isinstance(results["rj_isp_cisp"], int), f"rj_isp_cisp={results['rj_isp_cisp']}"
        assert results["rj_isp_cisp"] > 0, "RJ CISP loaded 0 rows"

        mg_keys = [k for k in results if k.startswith("mg_violent_") and isinstance(results[k], int)]
        assert len(mg_keys) > 0, "No MG violent rows loaded"
        assert all(results[k] > 0 for k in mg_keys), f"Some MG files loaded 0 rows: {results}"

        # _total matches DB
        db_total = db.query(func.count(CrimeStaging.id)).scalar() or 0
        assert results["_total"] == db_total, (
            f"_total={results['_total']:,} != db count={db_total:,}"
        )

        # No SINESP rows
        sinesp_count = (
            db.query(func.count(CrimeStaging.id))
            .filter(CrimeStaging.source.like("sinesp%"))
            .scalar()
            or 0
        )
        assert sinesp_count == 0

        print(f"\n  Orchestration: {db_total:,} total staging rows, states={results.get('_distinct_states')} OK")
    finally:
        db.close()
