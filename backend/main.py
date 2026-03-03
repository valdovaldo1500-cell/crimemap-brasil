"""CrimeMap RS"""
import os, logging
from typing import Optional, List
from fastapi import FastAPI, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import func, distinct
from database import init_db, get_db, Crime, GeocodeCache
from schemas import CrimeOut, HeatmapPoint, CrimeTypeCount, MunicipioCount, StatsResponse

logging.basicConfig(level=logging.INFO)
app = FastAPI(title="CrimeMap RS", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
def startup():
    init_db()

def apply_filters(q, tipo=None, grupo=None, municipio=None, bairro=None, data_inicio=None, data_fim=None):
    if tipo: q = q.filter(Crime.tipo_enquadramento.in_(tipo))
    if grupo: q = q.filter(Crime.grupo_fato == grupo)
    if municipio: q = q.filter(Crime.municipio_fato.ilike(f"%{municipio}%"))
    if bairro: q = q.filter(Crime.bairro.ilike(f"%{bairro}%"))
    if data_inicio: q = q.filter(Crime.data_fato >= data_inicio)
    if data_fim: q = q.filter(Crime.data_fato <= data_fim)
    return q

@app.get("/api/crimes", response_model=List[CrimeOut])
def get_crimes(tipo: Optional[List[str]] = Query(None), grupo: Optional[str] = None,
    municipio: Optional[str] = None, bairro: Optional[str] = None,
    data_inicio: Optional[str] = None, data_fim: Optional[str] = None,
    page: int = 1, page_size: int = 100, db: Session = Depends(get_db)):
    q = db.query(Crime).filter(Crime.latitude.isnot(None))
    q = apply_filters(q, tipo, grupo, municipio, bairro, data_inicio, data_fim)
    return q.offset((page-1)*page_size).limit(page_size).all()

@app.get("/api/heatmap/municipios", response_model=List[HeatmapPoint])
def heatmap_municipios(tipo: Optional[List[str]] = Query(None), grupo: Optional[str] = None,
    data_inicio: Optional[str] = None, data_fim: Optional[str] = None,
    south: Optional[float] = None, west: Optional[float] = None,
    north: Optional[float] = None, east: Optional[float] = None,
    db: Session = Depends(get_db)):
    q = db.query(Crime.municipio_fato, func.count(Crime.id).label("cnt")).filter(Crime.latitude.isnot(None))
    if tipo: q = q.filter(Crime.tipo_enquadramento.in_(tipo))
    if grupo: q = q.filter(Crime.grupo_fato == grupo)
    if data_inicio: q = q.filter(Crime.data_fato >= data_inicio)
    if data_fim: q = q.filter(Crime.data_fato <= data_fim)
    if south is not None and north is not None:
        q = q.filter(Crime.latitude.between(south, north))
    if west is not None and east is not None:
        q = q.filter(Crime.longitude.between(west, east))
    q = q.group_by(Crime.municipio_fato)
    results = []
    for row in q.all():
        geo = db.query(GeocodeCache).filter(GeocodeCache.municipio == row.municipio_fato, GeocodeCache.bairro == "").first()
        if geo:
            if south is not None and north is not None and west is not None and east is not None:
                if not (south <= geo.latitude <= north and west <= geo.longitude <= east):
                    continue
            results.append(HeatmapPoint(latitude=geo.latitude, longitude=geo.longitude, weight=row.cnt, municipio=row.municipio_fato))
    return results

@app.get("/api/heatmap/bairros", response_model=List[HeatmapPoint])
def heatmap_bairros(municipio: Optional[str] = None, tipo: Optional[List[str]] = Query(None),
    grupo: Optional[str] = None, data_inicio: Optional[str] = None,
    data_fim: Optional[str] = None,
    south: Optional[float] = None, west: Optional[float] = None,
    north: Optional[float] = None, east: Optional[float] = None,
    db: Session = Depends(get_db)):
    q = db.query(Crime.municipio_fato, Crime.bairro, func.count(Crime.id).label("cnt"),
        func.avg(Crime.latitude).label("lat"), func.avg(Crime.longitude).label("lng")
    ).filter(Crime.latitude.isnot(None), Crime.bairro.isnot(None), Crime.bairro != "")
    if municipio: q = q.filter(Crime.municipio_fato.ilike(f"%{municipio}%"))
    if tipo: q = q.filter(Crime.tipo_enquadramento.in_(tipo))
    if grupo: q = q.filter(Crime.grupo_fato == grupo)
    if data_inicio: q = q.filter(Crime.data_fato >= data_inicio)
    if data_fim: q = q.filter(Crime.data_fato <= data_fim)
    if south is not None and north is not None:
        q = q.filter(Crime.latitude.between(south, north))
    if west is not None and east is not None:
        q = q.filter(Crime.longitude.between(west, east))
    q = q.group_by(Crime.municipio_fato, Crime.bairro)
    return [HeatmapPoint(latitude=float(r.lat), longitude=float(r.lng), weight=r.cnt,
        municipio=r.municipio_fato, bairro=r.bairro) for r in q.all() if r.lat and r.lng]

@app.get("/api/crime-types", response_model=List[CrimeTypeCount])
def get_crime_types(db: Session = Depends(get_db)):
    q = db.query(Crime.tipo_enquadramento, func.count(Crime.id)).group_by(
        Crime.tipo_enquadramento).order_by(func.count(Crime.id).desc())
    return [CrimeTypeCount(tipo_enquadramento=r[0], count=r[1]) for r in q.all()]

@app.get("/api/municipios")
def get_municipios(db: Session = Depends(get_db)):
    q = db.query(distinct(Crime.municipio_fato)).order_by(Crime.municipio_fato)
    return [r[0] for r in q.all() if r[0]]

@app.get("/api/bairros")
def get_bairros(municipio: Optional[str] = None, db: Session = Depends(get_db)):
    q = db.query(distinct(Crime.bairro)).filter(Crime.bairro.isnot(None), Crime.bairro != "")
    if municipio: q = q.filter(Crime.municipio_fato.ilike(f"%{municipio}%"))
    return sorted([r[0] for r in q.all() if r[0]])

@app.get("/api/stats", response_model=StatsResponse)
def get_stats(tipo: Optional[List[str]] = Query(None),
    grupo: Optional[str] = None, municipio: Optional[str] = None,
    data_inicio: Optional[str] = None, data_fim: Optional[str] = None,
    db: Session = Depends(get_db)):
    q = apply_filters(db.query(Crime), tipo, grupo, municipio, None, data_inicio, data_fim)
    total = q.count()
    munis = q.with_entities(distinct(Crime.municipio_fato)).count()
    dates = q.with_entities(func.min(Crime.data_fato), func.max(Crime.data_fato)).first()
    tt = db.query(Crime.tipo_enquadramento, func.count(Crime.id)).group_by(Crime.tipo_enquadramento).order_by(func.count(Crime.id).desc()).limit(10).all()
    tm = db.query(Crime.municipio_fato, func.count(Crime.id)).group_by(Crime.municipio_fato).order_by(func.count(Crime.id).desc()).limit(10).all()
    return StatsResponse(total_crimes=total, total_municipios=munis,
        period_start=dates[0] or "", period_end=dates[1] or "",
        top_crime_types=[CrimeTypeCount(tipo_enquadramento=t[0], count=t[1]) for t in tt],
        top_municipios=[MunicipioCount(municipio=m[0], count=m[1]) for m in tm])

@app.get("/api/autocomplete")
def autocomplete(q: str, db: Session = Depends(get_db)):
    if len(q) < 2:
        return []
    term = f"%{q}%"
    results = []
    munis = db.query(
        Crime.municipio_fato,
        func.count(Crime.id).label("cnt"),
        func.avg(Crime.latitude).label("lat"),
        func.avg(Crime.longitude).label("lng")
    ).filter(
        Crime.municipio_fato.ilike(term),
        Crime.latitude.isnot(None)
    ).group_by(Crime.municipio_fato).order_by(func.count(Crime.id).desc()).limit(5).all()
    for m in munis:
        if m.lat and m.lng:
            results.append({"type": "municipio", "name": m.municipio_fato,
                "latitude": float(m.lat), "longitude": float(m.lng), "count": m.cnt})
    bairros = db.query(
        Crime.bairro, Crime.municipio_fato,
        func.count(Crime.id).label("cnt"),
        func.avg(Crime.latitude).label("lat"),
        func.avg(Crime.longitude).label("lng")
    ).filter(
        Crime.bairro.ilike(term),
        Crime.bairro.isnot(None), Crime.bairro != "",
        Crime.latitude.isnot(None)
    ).group_by(Crime.bairro, Crime.municipio_fato).order_by(func.count(Crime.id).desc()).limit(10).all()
    for b in bairros:
        if b.lat and b.lng:
            results.append({"type": "bairro", "name": b.bairro + ", " + b.municipio_fato,
                "latitude": float(b.lat), "longitude": float(b.lng), "count": b.cnt})
    return results

@app.get("/api/search")
def search_location(q: str, db: Session = Depends(get_db)):
    results = []
    for m in db.query(distinct(Crime.municipio_fato)).filter(Crime.municipio_fato.ilike("%" + q + "%")).limit(10).all():
        geo = db.query(GeocodeCache).filter(GeocodeCache.municipio == m[0], GeocodeCache.bairro == "").first()
        results.append({"type":"municipio","name":m[0],"latitude":geo.latitude if geo else None,"longitude":geo.longitude if geo else None})
    for b in db.query(Crime.bairro, Crime.municipio_fato).filter(Crime.bairro.ilike("%" + q + "%"), Crime.bairro.isnot(None)).distinct().limit(10).all():
        geo = db.query(GeocodeCache).filter(GeocodeCache.municipio == b[1], GeocodeCache.bairro == "").first()
        results.append({"type":"bairro","name":b[0]+", "+b[1],"latitude":geo.latitude if geo else None,"longitude":geo.longitude if geo else None})
    return results

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
