import os, unicodedata
from sqlalchemy import (create_engine, Column, Integer, String, Float,
    Index, DateTime, func, event)
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/crimemap.db")
engine = create_engine(DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {},
    echo=False)

def _normalize_text_sqlite(s: str) -> str:
    """SQLite UDF: strip accents + uppercase (mirrors normalize_name in main.py).
    Used in queries where SQLite's built-in upper() fails for accented chars
    (e.g. 'Niterói' → upper() stays 'NITERóI' in SQLite).
    """
    if not s:
        return ''
    nfkd = unicodedata.normalize('NFD', s)
    return ''.join(c for c in nfkd if unicodedata.category(c) != 'Mn').upper().strip()

if "sqlite" in DATABASE_URL:
    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, connection_record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA cache_size=-256000")   # 256 MB
        cursor.execute("PRAGMA mmap_size=2147483648")  # 2 GB
        cursor.execute("PRAGMA temp_store=MEMORY")
        # Register custom normalize function for accent-insensitive comparisons
        dbapi_conn.create_function("normalize_text", 1, _normalize_text_sqlite)
        cursor.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class Crime(Base):
    __tablename__ = "crimes"
    id = Column(Integer, primary_key=True, autoincrement=True)
    sequencia = Column(Integer)
    data_fato = Column(String, index=True)
    hora_fato = Column(String)
    grupo_fato = Column(String, index=True)
    tipo_enquadramento = Column(String, index=True)
    tipo_fato = Column(String)
    municipio_fato = Column(String, index=True)
    local_fato = Column(String)
    bairro = Column(String, index=True)
    quantidade_vitimas = Column(Integer, default=0)
    idade_vitima = Column(Integer)
    sexo_vitima = Column(String)
    cor_vitima = Column(String)
    latitude = Column(Float)
    longitude = Column(Float)
    source_file = Column(String)
    year_month = Column(String, index=True)
    state = Column(String, default="RS", index=True)
    __table_args__ = (
        Index('idx_mun_bairro', 'municipio_fato', 'bairro'),
        Index('idx_tipo_data', 'tipo_enquadramento', 'data_fato'),
        Index('idx_lat_lng', 'latitude', 'longitude'),
        Index('idx_state_tipo', 'state', 'tipo_enquadramento'),
        Index('idx_state_grupo', 'state', 'grupo_fato'),
        Index('idx_state_sexo', 'state', 'sexo_vitima'),
        Index('idx_state_cor', 'state', 'cor_vitima'),
        Index('idx_state_ym_tipo', 'state', 'year_month', 'tipo_enquadramento'),
    )

class GeocodeCache(Base):
    __tablename__ = "geocode_cache"
    id = Column(Integer, primary_key=True, autoincrement=True)
    municipio = Column(String, index=True)
    bairro = Column(String, default="")
    latitude = Column(Float)
    longitude = Column(Float)
    source = Column(String, default="nominatim")
    __table_args__ = (Index('idx_geo', 'municipio', 'bairro', unique=True),)

class BugReport(Base):
    __tablename__ = "bug_reports"
    id = Column(Integer, primary_key=True, autoincrement=True)
    description = Column(String, nullable=False)
    email = Column(String, default="")
    image_path = Column(String, default="")
    created_at = Column(DateTime, server_default=func.now())
    status = Column(String, default="new")

class DataSource(Base):
    __tablename__ = "data_sources"
    id = Column(Integer, primary_key=True, autoincrement=True)
    filename = Column(String, unique=True)
    url = Column(String)
    downloaded_at = Column(DateTime, server_default=func.now())
    records_count = Column(Integer, default=0)
    status = Column(String, default="pending")

class CrimeStaging(Base):
    __tablename__ = "crimes_staging"
    id = Column(Integer, primary_key=True, autoincrement=True)
    source = Column(String, index=True)
    state = Column(String, index=True)
    municipio = Column(String, index=True)
    cod_ibge = Column(Integer)
    crime_type = Column(String, index=True)
    year = Column(Integer, index=True)
    month = Column(Integer)
    occurrences = Column(Integer, default=0)
    victims = Column(Integer, default=0)
    sexo_vitima = Column(String)
    extra_json = Column(String)
    __table_args__ = (
        Index('idx_staging_state_year_month', 'state', 'year', 'month'),
        Index('idx_staging_municipio', 'municipio'),
        Index('idx_staging_crime_type', 'crime_type'),
        Index('idx_staging_state_type_counts', 'state', 'crime_type', 'occurrences', 'victims'),
    )

def init_db():
    Base.metadata.create_all(bind=engine)
    # Add state column if missing (SQLAlchemy create_all won't ALTER existing tables)
    db = SessionLocal()
    try:
        from sqlalchemy import text, inspect
        insp = inspect(engine)
        cols = [c['name'] for c in insp.get_columns('crimes')]
        if 'state' not in cols:
            db.execute(text("ALTER TABLE crimes ADD COLUMN state VARCHAR DEFAULT 'RS'"))
            db.execute(text("CREATE INDEX IF NOT EXISTS ix_crimes_state ON crimes (state)"))
            db.commit()
        db.execute(text("UPDATE crimes SET state = 'RS' WHERE state IS NULL"))
        db.commit()
        # Create bug_reports table if not exists
        cols_tables = insp.get_table_names()
        if 'bug_reports' not in cols_tables:
            BugReport.__table__.create(engine, checkfirst=True)
        # Ensure additional indexes exist (idempotent — safe to run every startup)
        db.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_crimes_year "
            "ON crimes (substr(year_month, 1, 4))"
        ))
        db.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_staging_municipio "
            "ON crimes_staging (municipio)"
        ))
        db.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_staging_crime_type "
            "ON crimes_staging (crime_type)"
        ))
        db.commit()
    except Exception as e:
        db.rollback()
        import logging
        logging.getLogger(__name__).warning(f"Migration warning: {e}")
    finally:
        db.close()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
