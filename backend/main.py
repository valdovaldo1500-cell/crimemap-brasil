"""CrimeBrasil"""
import os, logging, threading, unicodedata, hmac, hashlib, time, random, base64, json
import os as _os, json as _json
from typing import Optional, List
from fastapi import FastAPI, Depends, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import func, distinct
from database import init_db, get_db, Crime, GeocodeCache, BugReport, CrimeStaging, SessionLocal
from schemas import CrimeOut, HeatmapPoint, BairroComponent, CrimeTypeCount, MunicipioCount, StatsResponse
from services.geocoder import GeocoderService, batch_geocode_new_bairros

CAPTCHA_SECRET = os.getenv("CAPTCHA_SECRET", "crimebrasil-captcha-2024")

logging.basicConfig(level=logging.INFO)

def normalize_name(s: str) -> str:
    """Strip accents and uppercase — works for Brazilian Portuguese."""
    nfkd = unicodedata.normalize('NFD', s)
    return ''.join(c for c in nfkd if unicodedata.category(c) != 'Mn').upper().strip()

def normalize_fuzzy(s: str) -> str:
    """Aggressive normalization: strip accents, spaces, hyphens, apostrophes."""
    import re
    n = normalize_name(s)
    return re.sub(r"[\s'\-]+", "", n)

def _load_bairro_polygons():
    """Load rs-bairros.geojson into a spatial index keyed by municipio."""
    path = _os.path.join(_os.path.dirname(__file__), "..", "frontend", "public", "geo", "rs-bairros.geojson")
    if not _os.path.exists(path):
        path = "/app/geo/rs-bairros.geojson"
    if not _os.path.exists(path):
        return {}
    with open(path) as f:
        data = _json.load(f)
    index = {}  # municipio_norm -> [(bairro_norm, display_name, [ring, ...]), ...]
    for feat in data.get("features", []):
        props = feat.get("properties", {})
        mun = props.get("municipio_normalized", "")
        name_norm = props.get("name_normalized", "")
        name = props.get("name", "")
        if not mun or not name_norm:
            continue
        geom = feat.get("geometry", {})
        rings = []
        if geom["type"] == "Polygon":
            rings = [geom["coordinates"][0]]  # outer ring only
        elif geom["type"] == "MultiPolygon":
            rings = [poly[0] for poly in geom["coordinates"]]  # outer ring of each sub-polygon
        if rings:
            index.setdefault(mun, []).append((name_norm, name, rings))
    return index

BAIRRO_POLYGON_INDEX = _load_bairro_polygons()

def _point_in_polygon(px, py, polygon):
    """Ray-casting PIP test. polygon is [[lon,lat], ...]."""
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside

def _find_containing_polygon(lat, lng, mun_norm):
    """Find which bairro polygon contains point (lat, lng) for a given municipality.
    Returns (name_normalized, display_name) or None."""
    polys = BAIRRO_POLYGON_INDEX.get(mun_norm, [])
    for name_norm, display_name, rings in polys:
        for ring in rings:
            if _point_in_polygon(lng, lat, ring):  # PIP takes (lon, lat)
                return (name_norm, display_name)
    # Retry with small offsets for boundary-edge cases (~50m buffer)
    for dlat, dlng in [(0.0005, 0), (-0.0005, 0), (0, 0.0005), (0, -0.0005)]:
        for name_norm, display_name, rings in polys:
            for ring in rings:
                if _point_in_polygon(lng + dlng, lat + dlat, ring):
                    return (name_norm, display_name)
    return None

def semester_months(semestre: str) -> list[str]:
    """'2025-S1' -> ['2025-01', ..., '2025-06']"""
    year, sem = semestre.split('-')
    rng = range(1, 7) if sem == "S1" else range(7, 13)
    return [f"{year}-{m:02d}" for m in rng]

app = FastAPI(title="CrimeBrasil", version="2.0.0")
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

def apply_filters(q, tipo=None, grupo=None, municipio=None, bairro=None, data_inicio=None, data_fim=None, ano=None, semestre=None, idade_min=None, idade_max=None, sexo=None, cor=None, state=None):
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
    if idade_min is not None: q = q.filter(Crime.idade_vitima >= idade_min)
    if idade_max is not None: q = q.filter(Crime.idade_vitima <= idade_max)
    if sexo: q = q.filter(Crime.sexo_vitima.in_(sexo))
    if cor: q = q.filter(Crime.cor_vitima.in_(cor))
    if state: q = q.filter(Crime.state == state)
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
    idade_min: Optional[int] = None, idade_max: Optional[int] = None,
    sexo: Optional[List[str]] = Query(None), cor: Optional[List[str]] = Query(None),
    state: Optional[str] = None,
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
    if idade_min is not None: q = q.filter(Crime.idade_vitima >= idade_min)
    if idade_max is not None: q = q.filter(Crime.idade_vitima <= idade_max)
    if sexo: q = q.filter(Crime.sexo_vitima.in_(sexo))
    if cor: q = q.filter(Crime.cor_vitima.in_(cor))
    if state: q = q.filter(Crime.state == state)
    if south is not None and north is not None:
        q = q.filter(Crime.latitude.between(south, north))
    if west is not None and east is not None:
        q = q.filter(Crime.longitude.between(west, east))
    q = q.group_by(Crime.municipio_fato)
    crimes_results = [HeatmapPoint(latitude=float(r.lat), longitude=float(r.lng),
        weight=r.cnt, municipio=r.municipio_fato) for r in q.all() if r.lat and r.lng]

    # Also query staging table for non-RS municipalities
    q2 = db.query(
        CrimeStaging.municipio, CrimeStaging.state,
        (func.coalesce(func.sum(CrimeStaging.occurrences), 0) +
         func.coalesce(func.sum(CrimeStaging.victims), 0)).label("cnt")
    ).filter(CrimeStaging.municipio.isnot(None), CrimeStaging.state != "RS")
    if tipo: q2 = q2.filter(CrimeStaging.crime_type.in_(tipo))
    if semestre:
        year_str, sem = semestre.split('-')
        q2 = q2.filter(CrimeStaging.year == int(year_str))
        if sem == "S1": q2 = q2.filter(CrimeStaging.month.between(1, 6))
        else: q2 = q2.filter(CrimeStaging.month.between(7, 12))
    elif ano:
        q2 = q2.filter(CrimeStaging.year == int(ano))
    if sexo: q2 = q2.filter(CrimeStaging.sexo_vitima.in_(sexo))
    if state: q2 = q2.filter(CrimeStaging.state == state)
    staging_rows = q2.group_by(CrimeStaging.municipio, CrimeStaging.state).all()

    # For staging municipalities, geocode or look up coordinates
    staging_results = []
    for r in staging_rows:
        if not r.cnt or int(r.cnt) == 0:
            continue
        mun_name = r.municipio
        # Try GeocodeCache first
        geo = db.query(GeocodeCache).filter(
            GeocodeCache.municipio == normalize_name(mun_name), GeocodeCache.bairro == "").first()
        if geo and geo.latitude and geo.longitude:
            lat, lng = geo.latitude, geo.longitude
        else:
            # Fall back to state centroid
            centroid = STATE_CENTROIDS.get(r.state)
            if not centroid:
                continue
            lat, lng = centroid
        # Apply bounds filter
        if south is not None and north is not None:
            if not (south <= lat <= north):
                continue
        if west is not None and east is not None:
            if not (west <= lng <= east):
                continue
        staging_results.append(HeatmapPoint(latitude=lat, longitude=lng,
            weight=int(r.cnt), municipio=mun_name))

    # Merge: crimes (RS) + staging (non-RS), no overlap since we filtered state != "RS" in staging
    return crimes_results + staging_results

@app.get("/api/heatmap/bairros", response_model=List[HeatmapPoint])
def heatmap_bairros(municipio: Optional[str] = None, tipo: Optional[List[str]] = Query(None),
    grupo: Optional[str] = None, data_inicio: Optional[str] = None,
    data_fim: Optional[str] = None, ano: Optional[str] = None, semestre: Optional[str] = None,
    idade_min: Optional[int] = None, idade_max: Optional[int] = None,
    sexo: Optional[List[str]] = Query(None), cor: Optional[List[str]] = Query(None),
    state: Optional[str] = None,
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
    if idade_min is not None: q = q.filter(Crime.idade_vitima >= idade_min)
    if idade_max is not None: q = q.filter(Crime.idade_vitima <= idade_max)
    if sexo: q = q.filter(Crime.sexo_vitima.in_(sexo))
    if cor: q = q.filter(Crime.cor_vitima.in_(cor))
    if state: q = q.filter(Crime.state == state)
    if south is not None and north is not None:
        q = q.filter(Crime.latitude.between(south, north))
    if west is not None and east is not None:
        q = q.filter(Crime.longitude.between(west, east))
    rows = q.group_by(Crime.municipio_fato, Crime.bairro).having(func.count(Crime.id) >= 5).all()
    # Load GeocodeCache with normalized keys
    cache_rows = db.query(GeocodeCache).filter(GeocodeCache.bairro != "").all()
    cache = {(normalize_name(c.municipio), normalize_name(c.bairro)): (c.latitude, c.longitude) for c in cache_rows}
    # Merge rows by normalized bairro name + fuzzy (no hardcoded aliases)
    merged: dict[tuple[str, str], dict] = {}
    fuzzy_key_map: dict[tuple[str, str], tuple[str, str]] = {}
    for r in rows:
        if not (r.lat and r.lng):
            continue
        mun_norm = normalize_name(r.municipio_fato)
        bairro_norm = normalize_name(r.bairro)
        key = (mun_norm, bairro_norm)
        # Fuzzy merge (BOM FIM / BOMFIM → same key)
        fuzzy = (mun_norm, normalize_fuzzy(bairro_norm))
        if fuzzy in fuzzy_key_map:
            key = fuzzy_key_map[fuzzy]
        else:
            fuzzy_key_map[fuzzy] = key
        if key in merged:
            merged[key]['cnt'] += r.cnt
        else:
            merged[key] = {'municipio': r.municipio_fato, 'bairro': r.bairro,
                            'cnt': r.cnt, 'lat': float(r.lat), 'lng': float(r.lng)}

    # PIP pass: for merged bairros that don't match any polygon by name,
    # check if their geocoded point falls inside an existing polygon → re-merge
    polygon_names_by_mun: dict[str, set[str]] = {}
    for mun, polys in BAIRRO_POLYGON_INDEX.items():
        polygon_names_by_mun[mun] = {p[0] for p in polys}

    pip_remap: dict[tuple[str, str], tuple[str, str, str]] = {}
    for key, m in merged.items():
        mun_norm, bairro_norm = key
        poly_names = polygon_names_by_mun.get(mun_norm, set())
        if bairro_norm in poly_names or normalize_fuzzy(bairro_norm) in {normalize_fuzzy(pn) for pn in poly_names}:
            continue  # already matches a polygon — no remap needed
        cache_coords = cache.get(key)
        lat, lng = cache_coords if cache_coords else (m['lat'], m['lng'])
        result = _find_containing_polygon(lat, lng, mun_norm)
        if not result and cache_coords:
            # Also try with Crime average coords (what the frontend displays)
            result = _find_containing_polygon(m['lat'], m['lng'], mun_norm)
        if result:
            pip_remap[key] = (mun_norm, result[0], result[1])

    for old_key, (mun_norm, new_bairro_norm, new_display) in pip_remap.items():
        old_data = merged.pop(old_key)
        new_key = (mun_norm, new_bairro_norm)
        if new_key in merged:
            merged[new_key]['cnt'] += old_data['cnt']
        else:
            merged[new_key] = {'municipio': old_data['municipio'], 'bairro': new_display,
                                'cnt': old_data['cnt'], 'lat': old_data['lat'], 'lng': old_data['lng']}

    # Build municipality centroid lookup for "unknown bairro" detection
    from services.geocoder import MAJOR_CITIES_RS, _haversine_km
    mun_cache_rows = db.query(GeocodeCache).filter(GeocodeCache.bairro == "").all()
    mun_centroids: dict[str, tuple[float, float]] = {}
    for c in mun_cache_rows:
        mun_centroids[normalize_name(c.municipio)] = (c.latitude, c.longitude)
    for mun_name, coords in MAJOR_CITIES_RS.items():
        mun_centroids[mun_name] = coords

    # Group bairros at municipality centroid (within 0.5km) OR with < 3 occurrences into "Bairro desconhecido"
    unknown_bucket: dict[str, dict] = {}  # keyed by mun_norm
    results = []
    for key, m in merged.items():
        mun_norm = key[0]
        lat, lng = cache.get(key, (m['lat'], m['lng']))
        centroid = mun_centroids.get(mun_norm)
        # Validate bairro coords against municipality centroid; snap if too far (cross-city geocoding error)
        if centroid and _haversine_km(lat, lng, centroid[0], centroid[1]) > 30:
            lat, lng = centroid[0], centroid[1]
        is_at_centroid = centroid and _haversine_km(lat, lng, centroid[0], centroid[1]) < 0.5
        is_low_count = m['cnt'] < 3
        if is_at_centroid or is_low_count:
            if mun_norm not in unknown_bucket:
                c_lat, c_lng = centroid if centroid else (lat, lng)
                unknown_bucket[mun_norm] = {'municipio': m['municipio'], 'cnt': 0,
                                             'lat': c_lat, 'lng': c_lng, 'components': []}
            unknown_bucket[mun_norm]['cnt'] += m['cnt']
            unknown_bucket[mun_norm]['components'].append({'bairro': m['bairro'], 'weight': m['cnt']})
        else:
            results.append(HeatmapPoint(latitude=lat, longitude=lng, weight=m['cnt'],
                municipio=m['municipio'], bairro=m['bairro']))
    # Add unknown buckets
    for mun_norm, ub in unknown_bucket.items():
        if ub['cnt'] >= 5:  # only show if substantial
            components = sorted(ub['components'], key=lambda x: x['weight'], reverse=True)
            results.append(HeatmapPoint(latitude=ub['lat'], longitude=ub['lng'], weight=ub['cnt'],
                municipio=ub['municipio'], bairro='Bairro desconhecido',
                components=[BairroComponent(**c) for c in components]))
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

@app.get("/api/sexo-values")
def get_sexo_values(db: Session = Depends(get_db)):
    q = db.query(Crime.sexo_vitima, func.count(Crime.id)).filter(
        Crime.sexo_vitima.isnot(None), Crime.sexo_vitima != ""
    ).group_by(Crime.sexo_vitima).order_by(func.count(Crime.id).desc())
    return [{"value": r[0], "count": r[1]} for r in q.all()]

@app.get("/api/cor-values")
def get_cor_values(db: Session = Depends(get_db)):
    q = db.query(Crime.cor_vitima, func.count(Crime.id)).filter(
        Crime.cor_vitima.isnot(None), Crime.cor_vitima != ""
    ).group_by(Crime.cor_vitima).order_by(func.count(Crime.id).desc())
    return [{"value": r[0], "count": r[1]} for r in q.all()]

@app.get("/api/grupo-values")
def get_grupo_values(db: Session = Depends(get_db)):
    q = db.query(Crime.grupo_fato, func.count(Crime.id)).filter(
        Crime.grupo_fato.isnot(None), Crime.grupo_fato != "",
        Crime.grupo_fato.in_(["CRIMES", "CONTRAVENCOES"])
    ).group_by(Crime.grupo_fato).order_by(func.count(Crime.id).desc())
    return [{"value": r[0], "count": r[1]} for r in q.all()]

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

@app.get("/api/filter-options")
def filter_options(
    tipo: Optional[List[str]] = Query(None),
    grupo: Optional[str] = None,
    semestre: Optional[str] = None,
    ano: Optional[str] = None,
    idade_min: Optional[int] = None,
    idade_max: Optional[int] = None,
    sexo: Optional[List[str]] = Query(None),
    cor: Optional[List[str]] = Query(None),
    db: Session = Depends(get_db)):
    """Return available filter options with counts, applying cross-filtering."""
    def base_query():
        return db.query(Crime)

    def apply_common(q, skip=None):
        if skip != 'tipo' and tipo:
            q = q.filter(Crime.tipo_enquadramento.in_(tipo))
        if skip != 'grupo' and grupo:
            q = q.filter(Crime.grupo_fato == grupo)
        if semestre:
            q = q.filter(Crime.year_month.in_(semester_months(semestre)))
        elif ano:
            q = q.filter(Crime.year_month.like(f"{ano}-%"))
        if skip != 'sexo' and sexo:
            q = q.filter(Crime.sexo_vitima.in_(sexo))
        if skip != 'cor' and cor:
            q = q.filter(Crime.cor_vitima.in_(cor))
        if idade_min is not None:
            q = q.filter(Crime.idade_vitima >= idade_min)
        if idade_max is not None:
            q = q.filter(Crime.idade_vitima <= idade_max)
        return q

    # Grupo options (apply all filters except grupo)
    gq = apply_common(base_query(), skip='grupo')
    gq = gq.with_entities(Crime.grupo_fato, func.count(Crime.id)).filter(
        Crime.grupo_fato.isnot(None), Crime.grupo_fato != "",
        Crime.grupo_fato.in_(["CRIMES", "CONTRAVENCOES"])
    ).group_by(Crime.grupo_fato).order_by(func.count(Crime.id).desc())
    grupo_opts = [{"value": r[0], "count": r[1]} for r in gq.all()]

    # Tipo options (apply all filters except tipo)
    tq = apply_common(base_query(), skip='tipo')
    tq = tq.with_entities(Crime.tipo_enquadramento, func.count(Crime.id)).filter(
        Crime.tipo_enquadramento.isnot(None), Crime.tipo_enquadramento != ""
    ).group_by(Crime.tipo_enquadramento).order_by(func.count(Crime.id).desc())
    tipo_opts = [{"value": r[0], "count": r[1]} for r in tq.all()]

    # Sexo options (apply all filters except sexo)
    sq = apply_common(base_query(), skip='sexo')
    sq = sq.with_entities(Crime.sexo_vitima, func.count(Crime.id)).filter(
        Crime.sexo_vitima.isnot(None), Crime.sexo_vitima != ""
    ).group_by(Crime.sexo_vitima).order_by(func.count(Crime.id).desc())
    sexo_opts = [{"value": r[0], "count": r[1]} for r in sq.all()]

    # Cor options (apply all filters except cor)
    cq = apply_common(base_query(), skip='cor')
    cq = cq.with_entities(Crime.cor_vitima, func.count(Crime.id)).filter(
        Crime.cor_vitima.isnot(None), Crime.cor_vitima != ""
    ).group_by(Crime.cor_vitima).order_by(func.count(Crime.id).desc())
    cor_opts = [{"value": r[0], "count": r[1]} for r in cq.all()]

    return {"grupo": grupo_opts, "tipo": tipo_opts, "sexo": sexo_opts, "cor": cor_opts}

@app.get("/api/location-stats")
def location_stats(municipio: str, bairro: Optional[str] = None,
    tipo: Optional[List[str]] = Query(None), grupo: Optional[str] = None,
    semestre: Optional[str] = None,
    ano: Optional[str] = None,
    idade_min: Optional[int] = None, idade_max: Optional[int] = None,
    sexo: Optional[List[str]] = Query(None), cor: Optional[List[str]] = Query(None),
    db: Session = Depends(get_db)):
    q = db.query(Crime).filter(Crime.municipio_fato.ilike(f"%{municipio}%"))
    if bairro:
        q = q.filter(Crime.bairro.ilike(f"%{bairro}%"))
    if semestre:
        q = q.filter(Crime.year_month.in_(semester_months(semestre)))
    elif ano:
        q = q.filter(Crime.year_month.like(f"{ano}-%"))
    if tipo:
        q = q.filter(Crime.tipo_enquadramento.in_(tipo))
    if grupo:
        q = q.filter(Crime.grupo_fato == grupo)
    if idade_min is not None: q = q.filter(Crime.idade_vitima >= idade_min)
    if idade_max is not None: q = q.filter(Crime.idade_vitima <= idade_max)
    if sexo: q = q.filter(Crime.sexo_vitima.in_(sexo))
    if cor: q = q.filter(Crime.cor_vitima.in_(cor))
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

STATE_CENTROIDS = {
    "RS": (-30.03, -51.22), "SP": (-23.55, -46.63), "RJ": (-22.91, -43.17),
    "MG": (-19.92, -43.94), "PR": (-25.43, -49.27), "SC": (-27.59, -48.55),
    "BA": (-12.97, -38.51), "PE": (-8.05, -34.87), "CE": (-3.72, -38.53),
    "PA": (-1.46, -48.50), "MA": (-2.53, -44.28), "GO": (-16.69, -49.25),
    "AM": (-3.12, -60.02), "ES": (-20.32, -40.34), "PB": (-7.12, -34.84),
    "RN": (-5.79, -35.21), "AL": (-9.67, -35.74), "PI": (-5.09, -42.80),
    "MT": (-15.60, -56.10), "MS": (-20.44, -54.65), "SE": (-10.91, -37.07),
    "RO": (-8.76, -63.90), "TO": (-10.18, -48.33), "AC": (-9.97, -67.81),
    "AP": (0.03, -51.05), "RR": (2.82, -60.67), "DF": (-15.78, -47.93),
}

@app.get("/api/heatmap/states")
def heatmap_states(tipo: Optional[List[str]] = Query(None),
    ano: Optional[str] = None, semestre: Optional[str] = None,
    idade_min: Optional[int] = None, idade_max: Optional[int] = None,
    sexo: Optional[List[str]] = Query(None), cor: Optional[List[str]] = Query(None),
    db: Session = Depends(get_db)):
    # Query 1: crimes table (detailed RS data)
    q1 = db.query(Crime.state, func.count(Crime.id).label("cnt")).filter(Crime.state.isnot(None))
    if tipo: q1 = q1.filter(Crime.tipo_enquadramento.in_(tipo))
    if semestre: q1 = q1.filter(Crime.year_month.in_(semester_months(semestre)))
    elif ano: q1 = q1.filter(Crime.year_month.like(f"{ano}-%"))
    if idade_min is not None: q1 = q1.filter(Crime.idade_vitima >= idade_min)
    if idade_max is not None: q1 = q1.filter(Crime.idade_vitima <= idade_max)
    if sexo: q1 = q1.filter(Crime.sexo_vitima.in_(sexo))
    if cor: q1 = q1.filter(Crime.cor_vitima.in_(cor))
    crimes_by_state = {r.state: r.cnt for r in q1.group_by(Crime.state).all()}

    # Query 2: staging table (all 27 states)
    q2 = db.query(
        CrimeStaging.state,
        (func.coalesce(func.sum(CrimeStaging.occurrences), 0) +
         func.coalesce(func.sum(CrimeStaging.victims), 0)).label("cnt")
    ).filter(CrimeStaging.state.isnot(None))
    if tipo: q2 = q2.filter(CrimeStaging.crime_type.in_(tipo))
    if semestre:
        year_str, sem = semestre.split('-')
        q2 = q2.filter(CrimeStaging.year == int(year_str))
        if sem == "S1": q2 = q2.filter(CrimeStaging.month.between(1, 6))
        else: q2 = q2.filter(CrimeStaging.month.between(7, 12))
    elif ano:
        q2 = q2.filter(CrimeStaging.year == int(ano))
    if sexo: q2 = q2.filter(CrimeStaging.sexo_vitima.in_(sexo))
    staging_by_state = {r.state: int(r.cnt) for r in q2.group_by(CrimeStaging.state).all() if r.cnt}

    # Merge: staging as base, crimes overrides for states it covers (avoids double-counting)
    merged = {**staging_by_state, **crimes_by_state}

    return [{"state": s, "latitude": c[0], "longitude": c[1], "weight": w}
            for s, w in merged.items()
            if (c := STATE_CENTROIDS.get(s))]

@app.get("/api/captcha")
def get_captcha():
    a, b = random.randint(1, 20), random.randint(1, 20)
    answer = str(a + b)
    ts = str(int(time.time()))
    payload = f"{answer}:{ts}"
    sig = hmac.new(CAPTCHA_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    token = base64.b64encode(f"{payload}:{sig}".encode()).decode()
    return {"question": f"Quanto é {a} + {b}?", "token": token}

class BugReportPayload(BaseModel):
    description: str
    email: Optional[str] = None
    image: Optional[str] = None
    captcha_token: str
    captcha_answer: str

@app.post("/api/bug-reports")
def create_bug_report(payload: BugReportPayload, db: Session = Depends(get_db)):
    # Validate captcha
    try:
        decoded = base64.b64decode(payload.captcha_token).decode()
        parts = decoded.split(":")
        if len(parts) != 3:
            raise ValueError("Invalid token")
        answer, ts, sig = parts
        expected_sig = hmac.new(CAPTCHA_SECRET.encode(), f"{answer}:{ts}".encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected_sig):
            raise ValueError("Invalid signature")
        if abs(time.time() - int(ts)) > 300:
            raise HTTPException(status_code=400, detail="Captcha expirado, tente novamente")
        if payload.captcha_answer.strip() != answer:
            raise HTTPException(status_code=400, detail="Resposta do captcha incorreta")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Captcha inválido")
    # Save image if provided
    image_path = ""
    if payload.image and payload.image.startswith("data:image"):
        bug_dir = os.path.join(os.path.dirname(__file__), "data", "bug-reports")
        os.makedirs(bug_dir, exist_ok=True)
        # Extract base64 data
        header, b64data = payload.image.split(",", 1)
        ext = "png" if "png" in header else "jpg"
        fname = f"bug_{int(time.time())}_{random.randint(1000,9999)}.{ext}"
        fpath = os.path.join(bug_dir, fname)
        with open(fpath, "wb") as f:
            f.write(base64.b64decode(b64data))
        image_path = fname
    report = BugReport(description=payload.description, email=payload.email or "", image_path=image_path)
    db.add(report)
    db.commit()
    return {"message": "Bug reportado com sucesso", "id": report.id}

@app.get("/api/admin/bug-reports")
def list_bug_reports(db: Session = Depends(get_db)):
    reports = db.query(BugReport).order_by(BugReport.created_at.desc()).all()
    return [{"id": r.id, "description": r.description, "email": r.email,
             "image_path": r.image_path, "created_at": str(r.created_at), "status": r.status} for r in reports]

@app.get("/api/admin/geocoding-status")
def geocoding_status(db: Session = Depends(get_db)):
    """Return geocoding coverage statistics."""
    total_bairro_pairs = db.query(Crime.municipio_fato, Crime.bairro).filter(
        Crime.bairro.isnot(None), Crime.bairro != ""
    ).distinct().count()
    cached_count = db.query(GeocodeCache).filter(GeocodeCache.bairro != "").count()
    with_coords = db.query(Crime).filter(Crime.latitude.isnot(None)).count()
    without_coords = db.query(Crime).filter(Crime.latitude.is_(None)).count()
    total = with_coords + without_coords
    rate = round(with_coords / total * 100, 2) if total > 0 else 0
    return {
        "total_bairro_pairs": total_bairro_pairs,
        "cached_geocodes": cached_count,
        "crimes_with_coords": with_coords,
        "crimes_without_coords": without_coords,
        "geocoding_rate_pct": rate,
    }

@app.post("/api/admin/validate-geocache")
def validate_geocache(db: Session = Depends(get_db)):
    """Delete GeocodeCache entries where bairro coords are > 50km from their municipality centroid."""
    from services.geocoder import _haversine_km, MAJOR_CITIES_RS, MAX_BAIRRO_DISTANCE_KM
    cache_rows = db.query(GeocodeCache).filter(GeocodeCache.bairro != "").all()
    # Build municipio centroid lookup
    mun_centroids: dict[str, tuple[float, float]] = {}
    for c in db.query(GeocodeCache).filter(GeocodeCache.bairro == "").all():
        mun_centroids[c.municipio] = (c.latitude, c.longitude)
    for mun, coords in MAJOR_CITIES_RS.items():
        mun_centroids[mun] = coords
    deleted = 0
    for row in cache_rows:
        centroid = mun_centroids.get(row.municipio)
        if not centroid:
            continue
        dist = _haversine_km(row.latitude, row.longitude, centroid[0], centroid[1])
        if dist > MAX_BAIRRO_DISTANCE_KM:
            logging.info(f"Deleting geocache: {row.bairro}, {row.municipio} ({dist:.0f}km from centroid)")
            db.delete(row)
            deleted += 1
    db.commit()
    return {"message": f"Validated {len(cache_rows)} entries, deleted {deleted} outliers"}

@app.post("/api/admin/check-updates")
def check_updates():
    """Manually trigger SSP data check + ingestion + geocoding."""
    def _run():
        from services.scheduler import auto_ingest_job
        auto_ingest_job()
    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return {"message": "Update check started in background"}

@app.post("/api/admin/ingest-rs-history")
def ingest_rs_history():
    """Ingest all RS historical occurrence data (2022-2026). Runs in background."""
    def _run():
        from services.data_ingestion import KNOWN_URLS, ingest_and_geocode
        sess = SessionLocal()
        try:
            for url in KNOWN_URLS:
                try:
                    count = ingest_and_geocode(url, sess, state="RS")
                    logging.info(f"RS ingested: {url} → {count} records")
                except Exception as e:
                    logging.error(f"RS ingest failed: {url} → {e}")
        finally:
            sess.close()
    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return {"message": "RS historical ingestion started in background (2022-2026)"}

@app.post("/api/admin/load-staging")
def load_staging():
    """Trigger full staging data load (downloads + parsing). Runs in background."""
    def _run():
        from services.staging_loader import run_full_staging_load
        results = run_full_staging_load()
        logging.info(f"Staging load results: {results}")
    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return {"message": "Staging load started in background. Check /api/admin/staging-stats for progress."}

@app.get("/api/admin/state-data-quality")
def state_data_quality(db: Session = Depends(get_db)):
    """Per-source, per-state data quality diagnostics."""
    # Check if any row has BOTH occurrences > 0 AND victims > 0 (potential double-count)
    double_count = db.query(func.count(CrimeStaging.id)).filter(
        CrimeStaging.occurrences > 0, CrimeStaging.victims > 0
    ).scalar() or 0
    # Per-state breakdown from crimes table
    crimes_by_state = {r[0]: r[1] for r in
        db.query(Crime.state, func.count(Crime.id)).filter(Crime.state.isnot(None)).group_by(Crime.state).all()}
    # Per-state, per-source from staging
    staging_breakdown = db.query(
        CrimeStaging.state, CrimeStaging.source,
        func.count(CrimeStaging.id),
        func.coalesce(func.sum(CrimeStaging.occurrences), 0),
        func.coalesce(func.sum(CrimeStaging.victims), 0)
    ).group_by(CrimeStaging.state, CrimeStaging.source).all()
    staging_detail = {}
    for state, source, rows, occ, vic in staging_breakdown:
        staging_detail.setdefault(state, []).append({
            "source": source, "rows": rows, "occurrences": int(occ), "victims": int(vic)
        })
    return {
        "double_count_rows": double_count,
        "crimes_table_by_state": crimes_by_state,
        "staging_by_state_source": staging_detail,
    }

@app.get("/api/admin/staging-stats")
def staging_stats(db: Session = Depends(get_db)):
    """Return row counts grouped by state and source."""
    total = db.query(func.count(CrimeStaging.id)).scalar() or 0
    by_source = db.query(
        CrimeStaging.source, func.count(CrimeStaging.id)
    ).group_by(CrimeStaging.source).all()
    by_state = db.query(
        CrimeStaging.state, func.count(CrimeStaging.id)
    ).group_by(CrimeStaging.state).order_by(func.count(CrimeStaging.id).desc()).all()
    distinct_states = db.query(func.count(distinct(CrimeStaging.state))).scalar() or 0
    return {
        "total_rows": total,
        "distinct_states": distinct_states,
        "by_source": {r[0]: r[1] for r in by_source},
        "by_state": {r[0]: r[1] for r in by_state},
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
