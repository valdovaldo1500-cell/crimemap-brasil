from pydantic import BaseModel
from typing import Optional, List

class CrimeOut(BaseModel):
    id: int
    sequencia: Optional[int] = None
    data_fato: str
    hora_fato: Optional[str] = None
    grupo_fato: str
    tipo_enquadramento: str
    tipo_fato: Optional[str] = None
    municipio_fato: str
    local_fato: Optional[str] = None
    bairro: Optional[str] = None
    quantidade_vitimas: Optional[int] = None
    idade_vitima: Optional[int] = None
    sexo_vitima: Optional[str] = None
    cor_vitima: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    class Config:
        from_attributes = True

class BairroComponent(BaseModel):
    bairro: str
    weight: int

class HeatmapPoint(BaseModel):
    latitude: float
    longitude: float
    weight: int
    municipio: Optional[str] = None
    bairro: Optional[str] = None
    population: Optional[int] = None
    components: Optional[List[BairroComponent]] = None
    level: Optional[str] = None  # "municipio" when bairro endpoint returns municipality-level data (RJ/MG)
    state: Optional[str] = None
    raw_bairro_names: Optional[List[str]] = None

class CrimeTypeCount(BaseModel):
    tipo_enquadramento: str
    count: int

class MunicipioCount(BaseModel):
    municipio: str
    count: int
    latitude: Optional[float] = None
    longitude: Optional[float] = None

class LocationStatsResponse(BaseModel):
    municipio: str
    bairro: Optional[str] = None
    total: int
    crime_types: List[CrimeTypeCount]

class StatsResponse(BaseModel):
    total_crimes: int
    total_municipios: int
    total_population: Optional[int] = None
    period_start: str
    period_end: str
    top_crime_types: List[CrimeTypeCount]
    top_municipios: List[MunicipioCount]
