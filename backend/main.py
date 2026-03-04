"""CrimeMap RS"""
import os, logging, threading, unicodedata
from typing import Optional, List
from fastapi import FastAPI, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import func, distinct
from database import init_db, get_db, Crime, GeocodeCache, SessionLocal
from schemas import CrimeOut, HeatmapPoint, CrimeTypeCount, MunicipioCount, StatsResponse
from services.geocoder import GeocoderService, batch_geocode_new_bairros

logging.basicConfig(level=logging.INFO)

def normalize_name(s: str) -> str:
    """Strip accents and uppercase — works for Brazilian Portuguese."""
    nfkd = unicodedata.normalize('NFD', s)
    return ''.join(c for c in nfkd if unicodedata.category(c) != 'Mn').upper().strip()

def semester_months(semestre: str) -> list[str]:
    """'2025-S1' -> ['2025-01', ..., '2025-06']"""
    year, sem = semestre.split('-')
    rng = range(1, 7) if sem == "S1" else range(7, 13)
    return [f"{year}-{m:02d}" for m in rng]

app = FastAPI(title="CrimeMap RS", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
def startup():
    init_db()
    from services.scheduler import start_scheduler
    start_scheduler(interval_days=7)

@app.on_event("shutdown")
def shutdown():
    from services.scheduler import stop_scheduler
    stop_scheduler()

def apply_filters(q, tipo=None, grupo=None, municipio=None, bairro=None, data_inicio=None, data_fim=None, ano=None, semestre=None):
    if tipo: q = q.filter(Crime.tipo_enquadramento.in_(tipo))
    if grupo: q = q.filter(Crime.grupo_fato == grupo)
    if municipio: q = q.filter(Crime.municipio_fato.ilike(f"%{municipio}%"))
    if bairro: q = q.filter(Crime.bairro.ilike(f"%{bairro}%"))
    if data_inicio: q = q.filter(Crime.data_fato >= data_inicio)
    if data_fim: q = q.filter(Crime.data_fato <= data_fim)
    if semestre:
        q = q.filter(Crime.year_month.in_(semester_months(semestre)))
    elif ano:
        q = q.filter(Crime.year_month.like(f"{ano}-%"))
    return q

@app.get("/api/crimes", response_model=List[CrimeOut])
def get_crimes(tipo: Optional[List[str]] = Query(None), grupo: Optional[str] = None,
    municipio: Optional[str] = None, bairro: Optional[str] = None,
    data_inicio: Optional[str] = None, data_fim: Optional[str] = None,
    ano: Optional[str] = None, semestre: Optional[str] = None,
    page: int = 1, page_size: int = 100, db: Session = Depends(get_db)):
    q = db.query(Crime).filter(Crime.latitude.isnot(None))
    q = apply_filters(q, tipo, grupo, municipio, bairro, data_inicio, data_fim, ano, semestre)
    return q.offset((page-1)*page_size).limit(page_size).all()

@app.get("/api/heatmap/municipios", response_model=List[HeatmapPoint])
def heatmap_municipios(tipo: Optional[List[str]] = Query(None), grupo: Optional[str] = None,
    data_inicio: Optional[str] = None, data_fim: Optional[str] = None,
    ano: Optional[str] = None, semestre: Optional[str] = None,
    south: Optional[float] = None, west: Optional[float] = None,
    north: Optional[float] = None, east: Optional[float] = None,
    db: Session = Depends(get_db)):
    q = db.query(
        Crime.municipio_fato,
        func.count(Crime.id).label("cnt"),
        func.avg(Crime.latitude).label("lat"),
        func.avg(Crime.longitude).label("lng"),
    ).filter(Crime.latitude.isnot(None))
    if tipo: q = q.filter(Crime.tipo_enquadramento.in_(tipo))
    if grupo: q = q.filter(Crime.grupo_fato == grupo)
    if data_inicio: q = q.filter(Crime.data_fato >= data_inicio)
    if data_fim: q = q.filter(Crime.data_fato <= data_fim)
    if semestre: q = q.filter(Crime.year_month.in_(semester_months(semestre)))
    elif ano: q = q.filter(Crime.year_month.like(f"{ano}-%"))
    if south is not None and north is not None:
        q = q.filter(Crime.latitude.between(south, north))
    if west is not None and east is not None:
        q = q.filter(Crime.longitude.between(west, east))
    q = q.group_by(Crime.municipio_fato)
    return [HeatmapPoint(latitude=float(r.lat), longitude=float(r.lng),
        weight=r.cnt, municipio=r.municipio_fato) for r in q.all() if r.lat and r.lng]

@app.get("/api/heatmap/bairros", response_model=List[HeatmapPoint])
def heatmap_bairros(municipio: Optional[str] = None, tipo: Optional[List[str]] = Query(None),
    grupo: Optional[str] = None, data_inicio: Optional[str] = None,
    data_fim: Optional[str] = None, ano: Optional[str] = None, semestre: Optional[str] = None,
    south: Optional[float] = None, west: Optional[float] = None,
    north: Optional[float] = None, east: Optional[float] = None,
    db: Session = Depends(get_db)):
    q = db.query(Crime.municipio_fato, Crime.bairro,
        func.count(Crime.id).label("cnt"),
        func.avg(Crime.latitude).label("lat"), func.avg(Crime.longitude).label("lng")
    ).filter(Crime.latitude.isnot(None), Crime.bairro.isnot(None), Crime.bairro != "")
    if municipio: q = q.filter(Crime.municipio_fato.ilike(f"%{municipio}%"))
    if tipo: q = q.filter(Crime.tipo_enquadramento.in_(tipo))
    if grupo: q = q.filter(Crime.grupo_fato == grupo)
    if data_inicio: q = q.filter(Crime.data_fato >= data_inicio)
    if data_fim: q = q.filter(Crime.data_fato <= data_fim)
    if semestre: q = q.filter(Crime.year_month.in_(semester_months(semestre)))
    elif ano: q = q.filter(Crime.year_month.like(f"{ano}-%"))
    if south is not None and north is not None:
        q = q.filter(Crime.latitude.between(south, north))
    if west is not None and east is not None:
        q = q.filter(Crime.longitude.between(west, east))
    rows = q.group_by(Crime.municipio_fato, Crime.bairro).having(func.count(Crime.id) >= 10).all()
    # Load GeocodeCache with normalized keys
    cache_rows = db.query(GeocodeCache).filter(GeocodeCache.bairro != "").all()
    cache = {(normalize_name(c.municipio), normalize_name(c.bairro)): (c.latitude, c.longitude) for c in cache_rows}
    # Merge rows by normalized bairro name (handles accented variants)
    merged: dict[tuple[str, str], dict] = {}
    for r in rows:
        if not (r.lat and r.lng):
            continue
        key = (normalize_name(r.municipio_fato), normalize_name(r.bairro))
        if key in merged:
            merged[key]['cnt'] += r.cnt
        else:
            merged[key] = {'municipio': r.municipio_fato, 'bairro': r.bairro,
                            'cnt': r.cnt, 'lat': float(r.lat), 'lng': float(r.lng)}
    results = []
    for key, m in merged.items():
        lat, lng = cache.get(key, (m['lat'], m['lng']))
        results.append(HeatmapPoint(latitude=lat, longitude=lng, weight=m['cnt'],
            municipio=m['municipio'], bairro=m['bairro']))
    return results

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
    raw = [r[0] for r in q.all() if r[0]]
    seen: dict[str, str] = {}
    for b in raw:
        key = normalize_name(b)
        if key not in seen:
            seen[key] = b
    return sorted(seen.values())

@app.get("/api/stats", response_model=StatsResponse)
def get_stats(tipo: Optional[List[str]] = Query(None),
    grupo: Optional[str] = None, municipio: Optional[str] = None,
    data_inicio: Optional[str] = None, data_fim: Optional[str] = None,
    ano: Optional[str] = None, semestre: Optional[str] = None,
    db: Session = Depends(get_db)):
    q = apply_filters(db.query(Crime), tipo, grupo, municipio, None, data_inicio, data_fim, ano, semestre)
    total = q.count()
    munis = q.with_entities(distinct(Crime.municipio_fato)).count()
    dates = q.with_entities(func.min(Crime.data_fato), func.max(Crime.data_fato)).first()
    tt = db.query(Crime.tipo_enquadramento, func.count(Crime.id)).group_by(Crime.tipo_enquadramento).order_by(func.count(Crime.id).desc()).limit(10).all()
    tm = db.query(Crime.municipio_fato, func.count(Crime.id)).group_by(Crime.municipio_fato).order_by(func.count(Crime.id).desc()).limit(10).all()
    return StatsResponse(total_crimes=total, total_municipios=munis,
        period_start=dates[0] or "", period_end=dates[1] or "",
        top_crime_types=[CrimeTypeCount(tipo_enquadramento=t[0], count=t[1]) for t in tt],
        top_municipios=[MunicipioCount(municipio=m[0], count=m[1]) for m in tm])

@app.get("/api/location-stats")
def location_stats(municipio: str, bairro: Optional[str] = None,
    tipo: Optional[List[str]] = Query(None), semestre: Optional[str] = None,
    ano: Optional[str] = None, db: Session = Depends(get_db)):
    q = db.query(Crime).filter(Crime.municipio_fato.ilike(f"%{municipio}%"))
    if bairro:
        q = q.filter(Crime.bairro.ilike(f"%{bairro}%"))
    if semestre:
        q = q.filter(Crime.year_month.in_(semester_months(semestre)))
    elif ano:
        q = q.filter(Crime.year_month.like(f"{ano}-%"))
    if tipo:
        q = q.filter(Crime.tipo_enquadramento.in_(tipo))
    total = q.count()
    breakdown = q.with_entities(Crime.tipo_enquadramento, func.count(Crime.id)) \
        .group_by(Crime.tipo_enquadramento).order_by(func.count(Crime.id).desc()).limit(10).all()
    return {"municipio": municipio, "bairro": bairro, "total": total,
        "crime_types": [{"tipo_enquadramento": t[0], "count": t[1]} for t in breakdown]}

@app.get("/api/years")
def get_years(db: Session = Depends(get_db)):
    year_col = func.substr(Crime.year_month, 1, 4).label("year")
    rows = db.query(year_col).distinct().order_by(year_col.desc()).all()
    return [r.year for r in rows if r.year]

@app.get("/api/semesters")
def get_semesters(db: Session = Depends(get_db)):
    rows = db.query(distinct(Crime.year_month)).filter(Crime.year_month.isnot(None)).all()
    semesters = set()
    for (ym,) in rows:
        year, month = ym.split('-')
        semesters.add(f"{year}-{'S1' if int(month) <= 6 else 'S2'}")
    return sorted(semesters, reverse=True)

@app.get("/api/autocomplete")
def autocomplete(q: str, db: Session = Depends(get_db)):
    if len(q) < 3:
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
    bairro_merged: dict[tuple[str, str], dict] = {}
    for b in bairros:
        if not (b.lat and b.lng):
            continue
        key = (normalize_name(b.municipio_fato), normalize_name(b.bairro))
        if key in bairro_merged:
            bairro_merged[key]['count'] += b.cnt
        else:
            bairro_merged[key] = {"type": "bairro", "name": b.bairro + ", " + b.municipio_fato,
                "latitude": float(b.lat), "longitude": float(b.lng), "count": b.cnt}
    # Override bairro coords from GeocodeCache for accurate centering
    cache_rows = db.query(GeocodeCache).filter(GeocodeCache.bairro != "").all()
    geo_cache = {(normalize_name(c.municipio), normalize_name(c.bairro)): (c.latitude, c.longitude) for c in cache_rows}
    for key, item in bairro_merged.items():
        cached = geo_cache.get(key)
        if cached and cached[0] and cached[1]:
            item['latitude'] = cached[0]
            item['longitude'] = cached[1]
    results.extend(bairro_merged.values())
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

@app.post("/api/admin/geocode-bairros")
def geocode_bairros(municipio: Optional[str] = None, db: Session = Depends(get_db)):
    """Batch geocode bairros missing from GeocodeCache. Runs in background thread."""
    def _run():
        sess = SessionLocal()
        try:
            done, total = batch_geocode_new_bairros(db=sess, municipio_filter=municipio)
            logging.info(f"Batch geocoding complete: {done}/{total}")
        finally:
            sess.close()
    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return {"message": "Geocoding started in background"}

@app.post("/api/admin/check-updates")
def check_updates():
    """Manually trigger SSP data check + ingestion + geocoding."""
    def _run():
        from services.scheduler import auto_ingest_job
        auto_ingest_job()
    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return {"message": "Update check started in background"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
