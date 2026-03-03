import os
from sqlalchemy import (create_engine, Column, Integer, String, Float,
    Index, DateTime, func)
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/crimemap.db")
engine = create_engine(DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {},
    echo=False)
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
    __table_args__ = (
        Index('idx_mun_bairro', 'municipio_fato', 'bairro'),
        Index('idx_tipo_data', 'tipo_enquadramento', 'data_fato'),)

class GeocodeCache(Base):
    __tablename__ = "geocode_cache"
    id = Column(Integer, primary_key=True, autoincrement=True)
    municipio = Column(String, index=True)
    bairro = Column(String, default="")
    latitude = Column(Float)
    longitude = Column(Float)
    source = Column(String, default="nominatim")
    __table_args__ = (Index('idx_geo', 'municipio', 'bairro', unique=True),)

class DataSource(Base):
    __tablename__ = "data_sources"
    id = Column(Integer, primary_key=True, autoincrement=True)
    filename = Column(String, unique=True)
    url = Column(String)
    downloaded_at = Column(DateTime, server_default=func.now())
    records_count = Column(Integer, default=0)
    status = Column(String, default="pending")

def init_db():
    Base.metadata.create_all(bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
