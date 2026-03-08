"""CrimeBrasil"""
import os, logging, re, threading, unicodedata, hmac, hashlib, time, random, base64, json
import os as _os, json as _json
from typing import Optional, List
from functools import lru_cache
from fastapi import FastAPI, Depends, Query, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from sqlalchemy.orm import Session
from sqlalchemy import func, distinct, desc, literal_column
from database import init_db, get_db, Crime, GeocodeCache, BugReport, CrimeStaging, SessionLocal
from schemas import CrimeOut, HeatmapPoint, BairroComponent, CrimeTypeCount, MunicipioCount, StatsResponse
from services.geocoder import GeocoderService, batch_geocode_new_bairros
from services.population import get_municipio_population, get_state_population, get_bairro_population, get_municipio_population_by_code
from services.crime_categories import get_filter_info, get_compatible_types, get_max_granularity, STATE_QUALITY, PARTIAL_STATES, categorize_crime_types

CAPTCHA_SECRET = os.getenv("CAPTCHA_SECRET", "crimebrasil-captcha-2024")

logging.basicConfig(level=logging.INFO)

# Simple TTL cache for expensive query results
_query_cache: dict[str, tuple[float, any]] = {}
_CACHE_TTL = 120  # seconds

def _cache_get(key: str):
    entry = _query_cache.get(key)
    if entry and time.time() - entry[0] < _CACHE_TTL:
        return entry[1]
    return None

def _cache_set(key: str, value):
    _query_cache[key] = (time.time(), value)

def normalize_name(s: str) -> str:
    """Strip accents and uppercase — works for Brazilian Portuguese."""
    nfkd = unicodedata.normalize('NFD', s)
    return ''.join(c for c in nfkd if unicodedata.category(c) != 'Mn').upper().strip()

def normalize_fuzzy(s: str) -> str:
    """Aggressive normalization: strip accents, spaces, hyphens, apostrophes."""
    n = normalize_name(s)
    return re.sub(r"[\s'\-]+", "", n)

def _load_bairro_polygons():
    """Load rs-bairros.geojson into a spatial index keyed by municipio."""
    # Try local backend/geo/ first (baked into Docker image), then legacy paths
    path = _os.path.join(_os.path.dirname(__file__), "geo", "rs-bairros.geojson")
    if not _os.path.exists(path):
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

def _load_bairro_centroids():
    """Load pre-computed bairro polygon centroids from JSON (Docker-safe, no GeoJSON needed)."""
    path = _os.path.join(_os.path.dirname(__file__), "bairro_centroids.json")
    if not _os.path.exists(path):
        return {}
    with open(path) as f:
        raw = _json.load(f)
    return {mun: {b: tuple(coord) for b, coord in bairros.items()} for mun, bairros in raw.items()}

BAIRRO_CENTROIDS = _load_bairro_centroids()

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

_SEMESTRE_RE = re.compile(r'^\d{4}-S[12]$')

def validate_semestre(semestre: Optional[str]) -> None:
    """Raise 400 if semestre is provided but doesn't match YYYY-S1 or YYYY-S2."""
    if semestre and not _SEMESTRE_RE.match(semestre):
        raise HTTPException(status_code=400, detail="semestre must be in format YYYY-S1 or YYYY-S2")

def validate_age_filters(idade_min: Optional[int], idade_max: Optional[int]) -> None:
    """Raise 400 if either age bound is negative."""
    if idade_min is not None and idade_min < 0:
        raise HTTPException(status_code=400, detail="idade_min cannot be negative")
    if idade_max is not None and idade_max < 0:
        raise HTTPException(status_code=400, detail="idade_max cannot be negative")

def validate_bounds(south: Optional[float], north: Optional[float],
                    west: Optional[float], east: Optional[float]) -> None:
    """Raise 400 if lat/lon viewport bounds are outside valid geographic ranges."""
    if south is not None and not (-90.0 <= south <= 90.0):
        raise HTTPException(status_code=400, detail="south must be between -90 and 90")
    if north is not None and not (-90.0 <= north <= 90.0):
        raise HTTPException(status_code=400, detail="north must be between -90 and 90")
    if west is not None and not (-180.0 <= west <= 180.0):
        raise HTTPException(status_code=400, detail="west must be between -180 and 180")
    if east is not None and not (-180.0 <= east <= 180.0):
        raise HTTPException(status_code=400, detail="east must be between -180 and 180")

ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:3001",
    "https://crimebrasil.com.br",
    "https://www.crimebrasil.com.br",
]

limiter = Limiter(key_func=get_remote_address)

app = FastAPI(title="CrimeBrasil", version="2.0.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def startup():
    init_db()
    # Ensure composite indices exist on existing databases (idempotent)
    from database import engine
    from sqlalchemy import text
    with engine.connect() as conn:
        for stmt in [
            "CREATE INDEX IF NOT EXISTS idx_state_tipo ON crimes(state, tipo_enquadramento)",
            "CREATE INDEX IF NOT EXISTS idx_state_grupo ON crimes(state, grupo_fato)",
            "CREATE INDEX IF NOT EXISTS idx_state_sexo ON crimes(state, sexo_vitima)",
            "CREATE INDEX IF NOT EXISTS idx_state_cor ON crimes(state, cor_vitima)",
            "CREATE INDEX IF NOT EXISTS idx_state_ym_tipo ON crimes(state, year_month, tipo_enquadramento)",
            "CREATE INDEX IF NOT EXISTS idx_staging_state_type_counts ON crimes_staging(state, crime_type, occurrences, victims)",
        ]:
            conn.execute(text(stmt))
        conn.commit()
        conn.execute(text("ANALYZE"))
        conn.commit()
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
@limiter.limit("60/minute")
def heatmap_municipios(request: Request,
    tipo: Optional[List[str]] = Query(None), grupo: Optional[str] = None,
    data_inicio: Optional[str] = None, data_fim: Optional[str] = None,
    ano: Optional[str] = None, semestre: Optional[str] = None,
    idade_min: Optional[int] = None, idade_max: Optional[int] = None,
    sexo: Optional[List[str]] = Query(None), cor: Optional[List[str]] = Query(None),
    state: Optional[str] = None,
    selected_states: Optional[List[str]] = Query(None),
    south: Optional[float] = None, west: Optional[float] = None,
    north: Optional[float] = None, east: Optional[float] = None,
    db: Session = Depends(get_db)):
    validate_semestre(semestre)
    validate_age_filters(idade_min, idade_max)
    validate_bounds(south, north, west, east)

    # Auto-filter: when partial state (MG) is combined with others, apply compatible types
    effective_tipo = tipo
    if selected_states and not tipo:
        from services.crime_categories import get_compatible_types
        has_partial = any(s in PARTIAL_STATES for s in selected_states)
        if has_partial and len(selected_states) > 1:
            compatible = get_compatible_types(selected_states)
            if compatible:
                all_types = set()
                for types in compatible.values():
                    all_types.update(types)
                if all_types:
                    effective_tipo = list(all_types)

    q = db.query(
        Crime.municipio_fato,
        func.count(Crime.id).label("cnt"),
        func.avg(Crime.latitude).label("lat"),
        func.avg(Crime.longitude).label("lng"),
    ).filter(Crime.latitude.isnot(None))
    if effective_tipo: q = q.filter(Crime.tipo_enquadramento.in_(effective_tipo))
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
    if selected_states: q = q.filter(Crime.state.in_(selected_states))
    if south is not None and north is not None:
        q = q.filter(Crime.latitude.between(south, north))
    if west is not None and east is not None:
        q = q.filter(Crime.longitude.between(west, east))
    q = q.group_by(Crime.municipio_fato)
    crimes_results = [HeatmapPoint(latitude=float(r.lat), longitude=float(r.lng),
        weight=r.cnt, municipio=r.municipio_fato,
        population=get_municipio_population(r.municipio_fato, "RS")) for r in q.all() if r.lat and r.lng]

    # Also query staging table for all detailed states (RS, RJ, MG)
    # Crimes table data takes priority for dedup (see merge below)
    q2 = db.query(
        CrimeStaging.municipio, CrimeStaging.state,
        (func.coalesce(func.sum(CrimeStaging.occurrences), 0) +
         func.coalesce(func.sum(CrimeStaging.victims), 0)).label("cnt")
    ).filter(CrimeStaging.municipio.isnot(None), CrimeStaging.state.in_(["RS", "RJ", "MG"]))
    if effective_tipo: q2 = q2.filter(CrimeStaging.crime_type.in_(effective_tipo))
    if semestre:
        year_str, sem = semestre.split('-')
        q2 = q2.filter(CrimeStaging.year == int(year_str))
        if sem == "S1": q2 = q2.filter(CrimeStaging.month.between(1, 6))
        else: q2 = q2.filter(CrimeStaging.month.between(7, 12))
    elif ano:
        q2 = q2.filter(CrimeStaging.year == int(ano))
    if sexo: q2 = q2.filter(CrimeStaging.sexo_vitima.in_(sexo))
    if state: q2 = q2.filter(CrimeStaging.state == state)
    if selected_states: q2 = q2.filter(CrimeStaging.state.in_(selected_states))
    staging_rows = q2.group_by(CrimeStaging.municipio, CrimeStaging.state).all()

    # For staging municipalities, geocode or look up coordinates
    staging_results = []
    for r in staging_rows:
        if not r.cnt or int(r.cnt) == 0:
            continue
        mun_name = r.municipio
        lat, lng = None, None
        # Try municipality centroid from GeoJSON first (most accurate)
        mun_norm = normalize_name(mun_name) if mun_name else ""
        if mun_norm and mun_norm in MUNICIPIO_CENTROIDS:
            lat, lng = MUNICIPIO_CENTROIDS[mun_norm]
        else:
            # Try GeocodeCache
            geo = db.query(GeocodeCache).filter(
                GeocodeCache.municipio == mun_norm, GeocodeCache.bairro == "").first()
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
            weight=int(r.cnt), municipio=mun_name,
            population=get_municipio_population(mun_name, r.state)))

    # Merge: crimes data takes priority over staging for same municipality
    crimes_munis = {r.municipio for r in crimes_results}
    deduped_staging = [r for r in staging_results if r.municipio not in crimes_munis]
    return crimes_results + deduped_staging

@app.get("/api/heatmap/bairros", response_model=List[HeatmapPoint])
@limiter.limit("60/minute")
def heatmap_bairros(request: Request,
    municipio: Optional[str] = None, tipo: Optional[List[str]] = Query(None),
    grupo: Optional[str] = None, data_inicio: Optional[str] = None,
    data_fim: Optional[str] = None, ano: Optional[str] = None, semestre: Optional[str] = None,
    idade_min: Optional[int] = None, idade_max: Optional[int] = None,
    sexo: Optional[List[str]] = Query(None), cor: Optional[List[str]] = Query(None),
    state: Optional[str] = None,
    selected_states: Optional[List[str]] = Query(None),
    south: Optional[float] = None, west: Optional[float] = None,
    north: Optional[float] = None, east: Optional[float] = None,
    db: Session = Depends(get_db)):
    validate_semestre(semestre)
    validate_age_filters(idade_min, idade_max)
    validate_bounds(south, north, west, east)

    # Auto-filter: when partial state (MG) is combined with others, apply compatible types
    effective_tipo = tipo
    if selected_states and not tipo:
        has_partial = any(s in PARTIAL_STATES for s in selected_states)
        if has_partial and len(selected_states) > 1:
            compatible = get_compatible_types(selected_states)
            if compatible:
                all_types = set()
                for types in compatible.values():
                    all_types.update(types)
                if all_types:
                    effective_tipo = list(all_types)
    q = db.query(Crime.municipio_fato, Crime.bairro,
        func.count(Crime.id).label("cnt"),
        func.avg(Crime.latitude).label("lat"), func.avg(Crime.longitude).label("lng")
    ).filter(Crime.latitude.isnot(None), Crime.bairro.isnot(None), Crime.bairro != "")
    if municipio: q = q.filter(Crime.municipio_fato.ilike(f"%{municipio}%"))
    if effective_tipo: q = q.filter(Crime.tipo_enquadramento.in_(effective_tipo))
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
    if selected_states: q = q.filter(Crime.state.in_(selected_states))
    if south is not None and north is not None:
        q = q.filter(Crime.latitude.between(south, north))
    if west is not None and east is not None:
        q = q.filter(Crime.longitude.between(west, east))
    rows = q.group_by(Crime.municipio_fato, Crime.bairro).having(func.count(Crime.id) >= 5).all()
    # Build targeted GeocodeCache lookup — only fetch rows matching result municipios (not full table scan)
    result_municipios = list({r.municipio_fato for r in rows if r.municipio_fato})
    cache: dict[tuple[str, str], tuple[float, float]] = {}
    if result_municipios:
        cache_q = db.query(GeocodeCache).filter(GeocodeCache.bairro != "")
        if len(result_municipios) <= 50:
            norm_munis = [normalize_name(m) for m in result_municipios]
            cache_q = cache_q.filter(GeocodeCache.municipio.in_(norm_munis))
        cache_rows = cache_q.all()
        cache = {(normalize_name(c.municipio), normalize_name(c.bairro)): (c.latitude, c.longitude) for c in cache_rows}
    # Merge rows by normalized bairro name + fuzzy (no hardcoded aliases)
    BAIRRO_ALIASES = {
        "PORTO ALEGRE": {"CENTRO": "CENTRO HISTORICO"},
    }
    merged: dict[tuple[str, str], dict] = {}
    fuzzy_key_map: dict[tuple[str, str], tuple[str, str]] = {}
    for r in rows:
        if not (r.lat and r.lng):
            continue
        mun_norm = normalize_name(r.municipio_fato)
        bairro_norm = normalize_name(r.bairro)
        # Apply bairro name aliases before fuzzy merge
        alias_map = BAIRRO_ALIASES.get(mun_norm.upper())
        if alias_map:
            alias = alias_map.get(bairro_norm.upper())
            if alias:
                bairro_norm = normalize_name(alias)
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

    # Build set of bairro keys that match a polygon by name (exact or fuzzy)
    polygon_matched_keys: set[tuple[str, str]] = set()
    for key in merged:
        mun_norm, bairro_norm = key
        poly_names = polygon_names_by_mun.get(mun_norm, set())
        if bairro_norm in poly_names:
            polygon_matched_keys.add(key)
        elif normalize_fuzzy(bairro_norm) in {normalize_fuzzy(pn) for pn in poly_names}:
            polygon_matched_keys.add(key)
            # Update display name to match polygon's actual name for frontend GeoJSON matching
            for pn in poly_names:
                if normalize_fuzzy(pn) == normalize_fuzzy(bairro_norm) and pn != bairro_norm:
                    merged[key]['bairro'] = next(
                        (p[1] for p in BAIRRO_POLYGON_INDEX.get(mun_norm, []) if p[0] == pn),
                        merged[key]['bairro']
                    )
                    break

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
        mun_norm, bairro_norm = key
        # Prefer pre-computed polygon centroid > geocode cache > crime average
        mun_centroids_poly = BAIRRO_CENTROIDS.get(mun_norm, {})
        poly_coord = mun_centroids_poly.get(bairro_norm) or mun_centroids_poly.get(normalize_fuzzy(bairro_norm))
        if poly_coord:
            lat, lng = poly_coord
        else:
            lat, lng = cache.get(key, (m['lat'], m['lng']))
        centroid = mun_centroids.get(mun_norm)
        # Validate bairro coords against municipality centroid; snap if too far (cross-city geocoding error)
        if centroid and _haversine_km(lat, lng, centroid[0], centroid[1]) > 30:
            lat, lng = centroid[0], centroid[1]
        is_at_centroid = centroid and _haversine_km(lat, lng, centroid[0], centroid[1]) < 0.5
        is_low_count = m['cnt'] < 3
        if (is_at_centroid or is_low_count) and key not in polygon_matched_keys:
            if mun_norm not in unknown_bucket:
                c_lat, c_lng = centroid if centroid else (lat, lng)
                unknown_bucket[mun_norm] = {'municipio': m['municipio'], 'cnt': 0,
                                             'lat': c_lat, 'lng': c_lng, 'components': []}
            unknown_bucket[mun_norm]['cnt'] += m['cnt']
            unknown_bucket[mun_norm]['components'].append({'bairro': m['bairro'], 'weight': m['cnt']})
        else:
            bairro_pop = get_bairro_population(m['municipio'], m['bairro'], "RS")
            mun_pop = get_municipio_population(m['municipio'], "RS") if bairro_pop is None else None
            results.append(HeatmapPoint(latitude=lat, longitude=lng, weight=m['cnt'],
                municipio=m['municipio'], bairro=m['bairro'],
                population=bairro_pop or mun_pop))
    # Add unknown buckets
    for mun_norm, ub in unknown_bucket.items():
        if ub['cnt'] >= 5:  # only show if substantial
            components = sorted(ub['components'], key=lambda x: x['weight'], reverse=True)
            results.append(HeatmapPoint(latitude=ub['lat'], longitude=ub['lng'], weight=ub['cnt'],
                municipio=ub['municipio'], bairro='Bairro desconhecido',
                population=get_municipio_population(ub['municipio'], "RS"),
                components=[BairroComponent(**c) for c in components]))

    # --- Cluster-merging pass ---
    # Group results by municipality, then merge points within 0.3 km of each other.
    from collections import defaultdict
    mun_groups: dict[str, list] = defaultdict(list)
    for pt in results:
        mun_key = normalize_name(pt.municipio) if pt.municipio else ""
        mun_groups[mun_key].append(pt)

    merged_results = []
    for mun_key, pts in mun_groups.items():
        # Greedy single-linkage clustering with 0.3 km threshold.
        # Each element of `clusters` is a list of indices into `pts`.
        assigned = [False] * len(pts)
        clusters: list[list[int]] = []
        for i in range(len(pts)):
            if assigned[i]:
                continue
            cluster = [i]
            assigned[i] = True
            for j in range(i + 1, len(pts)):
                if assigned[j]:
                    continue
                # Check if point j is within 0.3 km of ANY point already in this cluster.
                for ci in cluster:
                    if _haversine_km(pts[ci].latitude, pts[ci].longitude,
                                     pts[j].latitude, pts[j].longitude) <= 0.3:
                        cluster.append(j)
                        assigned[j] = True
                        break
            clusters.append(cluster)

        for cluster in clusters:
            if len(cluster) == 1:
                # Isolated point — pass through unchanged.
                merged_results.append(pts[cluster[0]])
                continue

            # Find the highest-weight point; it provides the representative coordinates.
            cluster_pts = [pts[i] for i in cluster]
            anchor = max(cluster_pts, key=lambda p: p.weight)

            total_weight = sum(p.weight for p in cluster_pts)

            # Collect all leaf components (individual bairros) from the cluster.
            # Points that already have components (e.g. "Bairro desconhecido") expand them;
            # regular points contribute a single component entry.
            all_components: list[BairroComponent] = []
            for p in cluster_pts:
                if p.components:
                    all_components.extend(p.components)
                else:
                    all_components.append(BairroComponent(bairro=p.bairro or "", weight=p.weight))
            all_components.sort(key=lambda c: c.weight, reverse=True)

            # Build the display bairro name from the anchor.
            anchor_bairro = anchor.bairro or ""
            n_others = len(cluster_pts) - 1
            merged_bairro = f"{anchor_bairro} (+{n_others})"

            # Population: sum of non-None populations, or None if all None.
            pop_values = [p.population for p in cluster_pts if p.population is not None]
            merged_pop = sum(pop_values) if pop_values else None

            merged_results.append(HeatmapPoint(
                latitude=anchor.latitude,
                longitude=anchor.longitude,
                weight=total_weight,
                municipio=anchor.municipio,
                bairro=merged_bairro,
                population=merged_pop,
                components=all_components,
            ))

    # --- Staging fallback: add municipality-level data for RJ/MG ---
    # At bairro zoom, RS has per-bairro data but RJ/MG only have municipality aggregates.
    # Include them as level="municipio" so the frontend renders municipality polygons instead.
    staging_states = []
    if selected_states:
        staging_states = [s for s in selected_states if s in ("RJ", "MG")]
    elif not state:
        # No state filter: include RJ/MG if viewport overlaps their bounds
        staging_states = ["RJ", "MG"]
    elif state in ("RJ", "MG"):
        staging_states = [state]

    if staging_states:
        sq = db.query(
            CrimeStaging.municipio, CrimeStaging.state,
            (func.coalesce(func.sum(CrimeStaging.occurrences), 0) +
             func.coalesce(func.sum(CrimeStaging.victims), 0)).label("cnt")
        ).filter(CrimeStaging.municipio.isnot(None), CrimeStaging.state.in_(staging_states))
        if effective_tipo: sq = sq.filter(CrimeStaging.crime_type.in_(effective_tipo))
        if semestre:
            year_str, sem = semestre.split('-')
            sq = sq.filter(CrimeStaging.year == int(year_str))
            if sem == "S1": sq = sq.filter(CrimeStaging.month.between(1, 6))
            else: sq = sq.filter(CrimeStaging.month.between(7, 12))
        elif ano:
            sq = sq.filter(CrimeStaging.year == int(ano))
        if sexo: sq = sq.filter(CrimeStaging.sexo_vitima.in_(sexo))
        staging_rows = sq.group_by(CrimeStaging.municipio, CrimeStaging.state).all()

        for r in staging_rows:
            if not r.cnt or int(r.cnt) == 0:
                continue
            mun_name = r.municipio
            mun_norm = normalize_name(mun_name) if mun_name else ""
            lat, lng = None, None
            if mun_norm and mun_norm in MUNICIPIO_CENTROIDS:
                lat, lng = MUNICIPIO_CENTROIDS[mun_norm]
            else:
                geo = db.query(GeocodeCache).filter(
                    GeocodeCache.municipio == mun_norm, GeocodeCache.bairro == "").first()
                if geo and geo.latitude and geo.longitude:
                    lat, lng = geo.latitude, geo.longitude
                else:
                    centroid = STATE_CENTROIDS.get(r.state)
                    if not centroid:
                        continue
                    lat, lng = centroid
            # Apply viewport bounds filter
            if south is not None and north is not None:
                if not (south <= lat <= north):
                    continue
            if west is not None and east is not None:
                if not (west <= lng <= east):
                    continue
            merged_results.append(HeatmapPoint(
                latitude=lat, longitude=lng, weight=int(r.cnt),
                municipio=mun_name, bairro=None, level="municipio",
                population=get_municipio_population(mun_name, r.state)))

    return merged_results

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
    # Sum population across all municipalities present in the data
    all_munis = q.with_entities(distinct(Crime.municipio_fato)).all()
    total_pop = 0
    for (mun_name,) in all_munis:
        p = get_municipio_population(mun_name, "RS")
        if p:
            total_pop += p
    return StatsResponse(total_crimes=total, total_municipios=munis,
        total_population=total_pop if total_pop > 0 else None,
        period_start=dates[0] or "", period_end=dates[1] or "",
        top_crime_types=[CrimeTypeCount(tipo_enquadramento=t[0], count=t[1]) for t in tt],
        top_municipios=[MunicipioCount(municipio=m[0], count=m[1]) for m in tm])

@app.get("/api/filter-options")
@limiter.limit("60/minute")
def filter_options(request: Request,
    tipo: Optional[List[str]] = Query(None),
    grupo: Optional[str] = None,
    semestre: Optional[str] = None,
    ano: Optional[str] = None,
    idade_min: Optional[int] = None,
    idade_max: Optional[int] = None,
    sexo: Optional[List[str]] = Query(None),
    cor: Optional[List[str]] = Query(None),
    selected_states: Optional[List[str]] = Query(None),
    db: Session = Depends(get_db)):
    """Return available filter options with counts, applying cross-filtering."""
    validate_semestre(semestre)
    validate_age_filters(idade_min, idade_max)

    # Check response cache
    cache_key = f"filter_options:{tipo}:{grupo}:{semestre}:{ano}:{idade_min}:{idade_max}:{sexo}:{cor}:{selected_states}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

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
        if selected_states:
            q = q.filter(Crime.state.in_(selected_states))
        return q

    # Grupo options (apply all filters except grupo)
    gq = apply_common(base_query(), skip='grupo')
    gq = gq.with_entities(Crime.grupo_fato, func.count()).filter(
        Crime.grupo_fato.isnot(None), Crime.grupo_fato != "",
        Crime.grupo_fato.in_(["CRIMES", "CONTRAVENCOES"])
    ).group_by(Crime.grupo_fato).order_by(func.count().desc())
    grupo_opts = [{"value": r[0], "count": r[1]} for r in gq.all()]

    # Tipo options (apply all filters except tipo)
    tq = apply_common(base_query(), skip='tipo')
    tq = tq.with_entities(Crime.tipo_enquadramento, func.count()).filter(
        Crime.tipo_enquadramento.isnot(None), Crime.tipo_enquadramento != ""
    ).group_by(Crime.tipo_enquadramento).order_by(func.count().desc())
    tipo_opts = [{"value": r[0], "count": r[1]} for r in tq.all()]

    # Merge tipo from CrimeStaging for non-RS states
    if selected_states:
        non_rs_states = [s for s in selected_states if s not in ('RS', 'SP')]
        if non_rs_states:
            existing_values = {t['value'] for t in tipo_opts}
            staging_q = db.query(
                CrimeStaging.crime_type,
                (func.coalesce(func.sum(CrimeStaging.occurrences), 0) +
                 func.coalesce(func.sum(CrimeStaging.victims), 0)).label("cnt")
            ).filter(
                CrimeStaging.state.in_(non_rs_states),
                CrimeStaging.crime_type.isnot(None),
                CrimeStaging.crime_type != ""
            )
            if semestre:
                year_str, sem_str = semestre.split('-')
                month_range = list(range(1, 7) if sem_str == "S1" else range(7, 13))
                staging_q = staging_q.filter(
                    CrimeStaging.year == int(year_str),
                    CrimeStaging.month.in_(month_range)
                )
            elif ano:
                staging_q = staging_q.filter(CrimeStaging.year == int(ano))
            staging_q = staging_q.group_by(CrimeStaging.crime_type)
            for row in staging_q.all():
                if row.crime_type not in existing_values:
                    tipo_opts.append({"value": row.crime_type, "count": int(row.cnt)})
                    existing_values.add(row.crime_type)

    # Sexo options (apply all filters except sexo)
    sq = apply_common(base_query(), skip='sexo')
    sq = sq.with_entities(Crime.sexo_vitima, func.count()).filter(
        Crime.sexo_vitima.isnot(None), Crime.sexo_vitima != ""
    ).group_by(Crime.sexo_vitima).order_by(func.count().desc())
    sexo_opts = [{"value": r[0], "count": r[1]} for r in sq.all()]

    # Cor options (apply all filters except cor)
    cq = apply_common(base_query(), skip='cor')
    cq = cq.with_entities(Crime.cor_vitima, func.count()).filter(
        Crime.cor_vitima.isnot(None), Crime.cor_vitima != ""
    ).group_by(Crime.cor_vitima).order_by(func.count().desc())
    cor_opts = [{"value": r[0], "count": r[1]} for r in cq.all()]

    states = selected_states or []
    if states:
        from services.crime_categories import get_compatible_types
        states_with_rs = list(set(states + ['RS']))
        compatible = get_compatible_types(states_with_rs)
        if compatible:
            all_compat = set()
            for types in compatible.values():
                all_compat.update(types)
            if all_compat:
                tipo_opts = [t for t in tipo_opts if t['value'] in all_compat]

        has_non_rs = any(s != 'RS' for s in states)
        if has_non_rs:
            sexo_opts = []
            cor_opts = []
            grupo_opts = []  # Grupo (CRIMES/CONTRAVENCOES) is RS-specific

    total = sum(t['count'] for t in tipo_opts)
    result = {"grupo": grupo_opts, "tipo": tipo_opts, "sexo": sexo_opts, "cor": cor_opts, "total": total}
    _cache_set(cache_key, result)
    return result

@app.get("/api/location-stats")
@limiter.limit("60/minute")
def location_stats(request: Request,
    municipio: str = Query(...),
    bairro: Optional[str] = None,
    tipo: Optional[List[str]] = Query(None), grupo: Optional[str] = None,
    semestre: Optional[str] = None,
    ano: Optional[str] = None,
    idade_min: Optional[int] = None, idade_max: Optional[int] = None,
    sexo: Optional[List[str]] = Query(None), cor: Optional[List[str]] = Query(None),
    state: Optional[str] = None,
    db: Session = Depends(get_db)):
    if not municipio or not municipio.strip():
        raise HTTPException(status_code=400, detail="municipio parameter is required")
    validate_semestre(semestre)
    validate_age_filters(idade_min, idade_max)
    q = db.query(Crime).filter(Crime.municipio_fato == municipio)
    q = q.filter(Crime.latitude.isnot(None))
    if bairro:
        q = q.filter(Crime.bairro == bairro)
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

    if total > 0:
        breakdown = q.with_entities(Crime.tipo_enquadramento, func.count(Crime.id)) \
            .group_by(Crime.tipo_enquadramento).order_by(func.count(Crime.id).desc()).limit(10).all()
        crime_types = [{"tipo_enquadramento": t[0], "count": t[1]} for t in breakdown]
    else:
        # Fallback: query CrimeStaging for non-RS municipalities
        sq = db.query(
            CrimeStaging.crime_type,
            (func.coalesce(func.sum(CrimeStaging.occurrences), 0) +
             func.coalesce(func.sum(CrimeStaging.victims), 0)).label("cnt")
        ).filter(CrimeStaging.municipio == municipio)
        if state:
            sq = sq.filter(CrimeStaging.state == state)
        if semestre:
            year_str, sem_str = semestre.split('-')
            month_range = range(1, 7) if sem_str == "S1" else range(7, 13)
            sq = sq.filter(
                CrimeStaging.year == int(year_str),
                CrimeStaging.month.in_(list(month_range))
            )
        elif ano:
            sq = sq.filter(CrimeStaging.year == int(ano))
        if tipo:
            sq = sq.filter(CrimeStaging.crime_type.in_(tipo))
        if sexo:
            sq = sq.filter(CrimeStaging.sexo_vitima.in_(sexo))
        sq = sq.filter(CrimeStaging.crime_type.isnot(None))
        sq = sq.group_by(CrimeStaging.crime_type).order_by(desc(literal_column("cnt"))).limit(10)
        rows = sq.all()
        total = sum(r.cnt for r in rows)
        crime_types = [{"tipo_enquadramento": r.crime_type, "count": r.cnt} for r in rows if r.cnt > 0]

    # Population lookup with state-aware fallback
    lookup_state = state or "RS"
    pop = None
    if bairro:
        pop = get_bairro_population(municipio, bairro, lookup_state)
    if pop is None:
        pop = get_municipio_population(municipio, lookup_state)
    crime_categories = categorize_crime_types(crime_types)
    return {"municipio": municipio, "bairro": bairro, "total": total,
        "population": pop if pop else None,
        "crime_types": crime_types, "crime_categories": crime_categories}

def _normalize_muni(name: str) -> str:
    """Normalize municipality name for dedup counting."""
    nfkd = unicodedata.normalize('NFD', name)
    stripped = ''.join(c for c in nfkd if unicodedata.category(c) != 'Mn')
    return stripped.upper().replace('-', ' ').strip()

def _is_garbage_muni(name: str) -> bool:
    """Filter out garbage municipality entries."""
    if not name or ';' in name:
        return True
    cleaned = name.strip().upper()
    return cleaned in ('', '-', 'NAO INFORMADO', 'NÃO INFORMADO', 'IGNORADO', 'NAO IDENTIFICADO')

@app.get("/api/system-info")
@limiter.limit("60/minute")
def system_info(request: Request, db: Session = Depends(get_db)):
    crimes_munis = db.query(distinct(Crime.municipio_fato)).all()
    staging_munis = db.query(distinct(CrimeStaging.municipio)).filter(
        CrimeStaging.state.in_(["RS", "RJ", "MG"])
    ).all()
    normalized = set()
    for (m,) in crimes_munis:
        if m and not _is_garbage_muni(m):
            normalized.add(_normalize_muni(m))
    for (m,) in staging_munis:
        if m and not _is_garbage_muni(m):
            normalized.add(_normalize_muni(m))
    crimes_dates = db.query(func.min(Crime.data_fato), func.max(Crime.data_fato)).first()
    staging_range = db.query(
        func.min(CrimeStaging.year), func.max(CrimeStaging.year)
    ).filter(CrimeStaging.state.in_(["RS", "RJ", "MG"])).first()
    start_year = min(int(crimes_dates[0][-4:]) if crimes_dates and crimes_dates[0] else 9999, staging_range[0] or 9999)
    end_year = max(int(crimes_dates[1][-4:]) if crimes_dates and crimes_dates[1] else 0, staging_range[1] or 0)
    return {
        "total_municipios": len(normalized),
        "period_start_year": start_year,
        "period_end_year": end_year,
    }

@app.get("/api/state-stats")
@limiter.limit("60/minute")
def state_stats(request: Request,
    state: str = Query(...),
    tipo: Optional[List[str]] = Query(None), grupo: Optional[str] = None,
    semestre: Optional[str] = None,
    ano: Optional[str] = None,
    selected_states: Optional[List[str]] = Query(None),
    idade_min: Optional[int] = None, idade_max: Optional[int] = None,
    sexo: Optional[List[str]] = Query(None), cor: Optional[List[str]] = Query(None),
    db: Session = Depends(get_db)):
    validate_semestre(semestre)
    validate_age_filters(idade_min, idade_max)
    effective_tipo = tipo
    if selected_states and not tipo:
        has_partial = any(s in PARTIAL_STATES for s in selected_states)
        if has_partial and len(selected_states) > 1:
            compatible = get_compatible_types(selected_states)
            if compatible:
                all_types = set()
                for types in compatible.values():
                    all_types.update(types)
                if all_types:
                    effective_tipo = list(all_types)
    # Try detailed Crime table first
    q = db.query(Crime).filter(Crime.state == state, Crime.latitude.isnot(None))
    if semestre:
        q = q.filter(Crime.year_month.in_(semester_months(semestre)))
    elif ano:
        q = q.filter(Crime.year_month.like(f"{ano}-%"))
    if effective_tipo:
        q = q.filter(Crime.tipo_enquadramento.in_(effective_tipo))
    if grupo:
        q = q.filter(Crime.grupo_fato == grupo)
    if idade_min is not None:
        q = q.filter(Crime.idade_vitima >= idade_min)
    if idade_max is not None:
        q = q.filter(Crime.idade_vitima <= idade_max)
    if sexo:
        q = q.filter(Crime.sexo_vitima.in_(sexo))
    if cor:
        q = q.filter(Crime.cor_vitima.in_(cor))
    total = q.count()
    if total > 0:
        breakdown = (q.with_entities(Crime.tipo_enquadramento, func.count(Crime.id))
            .group_by(Crime.tipo_enquadramento)
            .order_by(func.count(Crime.id).desc())
            .limit(10).all())
        crime_types = [{"tipo_enquadramento": t[0], "count": t[1]} for t in breakdown]
    else:
        # Fall back to CrimeStaging for states without detailed Crime data
        sq = db.query(
            CrimeStaging.crime_type,
            (func.coalesce(func.sum(CrimeStaging.occurrences), 0) +
             func.coalesce(func.sum(CrimeStaging.victims), 0)).label("cnt")
        ).filter(CrimeStaging.state == state)
        if semestre:
            year_str, sem_str = semestre.split('-')
            month_range = range(1, 7) if sem_str == "S1" else range(7, 13)
            sq = sq.filter(
                CrimeStaging.year == int(year_str),
                CrimeStaging.month.in_(list(month_range))
            )
        elif ano:
            sq = sq.filter(CrimeStaging.year == int(ano))
        if effective_tipo:
            sq = sq.filter(CrimeStaging.crime_type.in_(effective_tipo))
        # Fix: use desc(literal_column(...)) instead of func.text(...) — valid SQLAlchemy/SQLite
        sq = sq.group_by(CrimeStaging.crime_type).order_by(desc(literal_column("cnt"))).limit(10)
        rows = sq.all()
        total = sum(r.cnt for r in rows)
        crime_types = [{"tipo_enquadramento": r.crime_type, "count": r.cnt} for r in rows if r.cnt > 0]
    pop = get_state_population(state)
    # Fix #9: return None instead of 0 so frontend never divides by zero
    crime_categories = categorize_crime_types(crime_types)
    return {"state": state, "total": total, "population": pop if pop else None, "crime_types": crime_types, "crime_categories": crime_categories}

@app.get("/api/years")
@limiter.limit("120/minute")
def get_years(request: Request, db: Session = Depends(get_db)):
    year_col = func.substr(Crime.year_month, 1, 4).label("year")
    crimes_years = {r.year for r in db.query(year_col).distinct().all() if r.year}
    staging_years = {str(r[0]) for r in db.query(distinct(CrimeStaging.year)).filter(
        CrimeStaging.state.in_(["RS", "RJ", "MG"]), CrimeStaging.year.isnot(None)
    ).all() if r[0]}
    all_years = sorted(crimes_years | staging_years, reverse=True)
    return all_years

@app.get("/api/semesters")
@limiter.limit("120/minute")
def get_semesters(request: Request, db: Session = Depends(get_db)):
    semesters = set()
    # From crimes table (RS detailed)
    rows = db.query(distinct(Crime.year_month)).filter(Crime.year_month.isnot(None)).all()
    for (ym,) in rows:
        year, month = ym.split('-')
        semesters.add(f"{year}-{'S1' if int(month) <= 6 else 'S2'}")
    # From crimes_staging (RJ, MG, etc.)
    staging_rows = db.query(
        CrimeStaging.year, CrimeStaging.month
    ).filter(
        CrimeStaging.state.in_(["RS", "RJ", "MG"]),
        CrimeStaging.year.isnot(None)
    ).distinct().all()
    for yr, mo in staging_rows:
        if mo is not None and mo > 0:
            semesters.add(f"{yr}-{'S1' if mo <= 6 else 'S2'}")
        else:
            # Yearly data (e.g. SINESP VDE) — add both semesters
            semesters.add(f"{yr}-S1")
            semesters.add(f"{yr}-S2")
    return sorted(semesters, reverse=True)

@app.get("/api/autocomplete")
@limiter.limit("120/minute")
def autocomplete(request: Request, q: str, db: Session = Depends(get_db)):
    if len(q) < 3:
        return []
    term = f"%{q}%"
    results = []
    # Query 1: crimes table (RS detailed data)
    munis = db.query(
        Crime.municipio_fato,
        func.count(Crime.id).label("cnt"),
        func.avg(Crime.latitude).label("lat"),
        func.avg(Crime.longitude).label("lng")
    ).filter(
        Crime.municipio_fato.ilike(term),
        Crime.latitude.isnot(None)
    ).group_by(Crime.municipio_fato).order_by(func.count(Crime.id).desc()).limit(5).all()
    # Track by normalized name to deduplicate with staging results
    muni_seen: dict[str, dict] = {}
    for m in munis:
        if m.lat and m.lng:
            entry = {"type": "municipio", "name": m.municipio_fato,
                "latitude": float(m.lat), "longitude": float(m.lng), "count": m.cnt}
            muni_seen[normalize_name(m.municipio_fato)] = entry

    # Query 2: staging table (RS, RJ, MG only — not all 27 states)
    staging_munis = db.query(
        CrimeStaging.municipio, CrimeStaging.state,
        (func.coalesce(func.sum(CrimeStaging.occurrences), 0) +
         func.coalesce(func.sum(CrimeStaging.victims), 0)).label("cnt")
    ).filter(
        CrimeStaging.municipio.ilike(term),
        CrimeStaging.municipio.isnot(None),
        CrimeStaging.state.in_(["RS", "RJ", "MG"])
    ).group_by(CrimeStaging.municipio, CrimeStaging.state).order_by(
        desc(literal_column("cnt"))
    ).limit(15).all()
    for sm in staging_munis:
        if not sm.municipio or not sm.cnt:
            continue
        norm_name = normalize_name(sm.municipio)
        if norm_name in muni_seen:
            continue  # already have from crimes table (higher quality)
        # Look up coordinates from GeoJSON centroids or geocode cache
        lat, lng = None, None
        centroid = MUNICIPIO_CENTROIDS.get(norm_name)
        if centroid:
            lat, lng = centroid
        else:
            geo = db.query(GeocodeCache).filter(
                GeocodeCache.municipio == sm.municipio, GeocodeCache.bairro == ""
            ).first()
            if geo and geo.latitude and geo.longitude:
                lat, lng = geo.latitude, geo.longitude
            else:
                sc = STATE_CENTROIDS.get(sm.state)
                if sc:
                    lat, lng = sc
        if lat and lng:
            display_name = f"{sm.municipio} ({sm.state})" if sm.state else sm.municipio
            entry = {"type": "municipio", "name": display_name,
                "latitude": lat, "longitude": lng, "count": int(sm.cnt)}
            muni_seen[norm_name] = entry

    results.extend(sorted(muni_seen.values(), key=lambda x: -x['count'])[:10])

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
    # Override bairro coords from GeocodeCache — targeted query, not full table scan
    if bairro_merged:
        bairro_munis = list({k[0] for k in bairro_merged.keys()})
        gc_q = db.query(GeocodeCache).filter(GeocodeCache.bairro != "")
        gc_q = gc_q.filter(GeocodeCache.municipio.in_(bairro_munis))
        geo_cache_rows = gc_q.all()
        geo_cache = {(normalize_name(c.municipio), normalize_name(c.bairro)): (c.latitude, c.longitude) for c in geo_cache_rows}
        for key, item in bairro_merged.items():
            cached = geo_cache.get(key)
            if cached and cached[0] and cached[1]:
                item['latitude'] = cached[0]
                item['longitude'] = cached[1]
    results.extend(bairro_merged.values())

    # Add state-level results if query matches a state name (RS, RJ, MG only)
    STATE_NAMES = {
        "RS": "Rio Grande do Sul", "RJ": "Rio de Janeiro", "MG": "Minas Gerais",
    }
    q_norm = normalize_name(q.strip())
    for sigla, full_name in STATE_NAMES.items():
        name_norm = normalize_name(full_name)
        if q_norm in sigla or q_norm in name_norm:
            centroid = STATE_CENTROIDS.get(sigla)
            if centroid:
                results.insert(0, {
                    "type": "state", "name": f"{full_name} ({sigla})",
                    "latitude": centroid[0], "longitude": centroid[1],
                    "count": 0, "sigla": sigla,
                })

    return results

@app.get("/api/search")
def search_location(q: str, db: Session = Depends(get_db)):
    results = []
    seen_munis: set[str] = set()
    for m in db.query(distinct(Crime.municipio_fato)).filter(Crime.municipio_fato.ilike("%" + q + "%")).limit(10).all():
        geo = db.query(GeocodeCache).filter(GeocodeCache.municipio == m[0], GeocodeCache.bairro == "").first()
        results.append({"type":"municipio","name":m[0],"latitude":geo.latitude if geo else None,"longitude":geo.longitude if geo else None})
        seen_munis.add(normalize_name(m[0]))
    # Also search staging table for non-RS municipalities (RS, RJ, MG only)
    staging_munis = db.query(
        CrimeStaging.municipio, CrimeStaging.state
    ).filter(
        CrimeStaging.municipio.ilike("%" + q + "%"),
        CrimeStaging.municipio.isnot(None),
        CrimeStaging.state.in_(["RS", "RJ", "MG"])
    ).group_by(CrimeStaging.municipio, CrimeStaging.state).limit(15).all()
    for sm in staging_munis:
        if not sm.municipio:
            continue
        norm = normalize_name(sm.municipio)
        if norm in seen_munis:
            continue
        seen_munis.add(norm)
        lat, lng = None, None
        centroid = MUNICIPIO_CENTROIDS.get(norm)
        if centroid:
            lat, lng = centroid
        else:
            geo = db.query(GeocodeCache).filter(GeocodeCache.municipio == sm.municipio, GeocodeCache.bairro == "").first()
            if geo and geo.latitude and geo.longitude:
                lat, lng = geo.latitude, geo.longitude
            else:
                sc = STATE_CENTROIDS.get(sm.state)
                if sc:
                    lat, lng = sc
        display_name = f"{sm.municipio} ({sm.state})" if sm.state else sm.municipio
        results.append({"type":"municipio","name":display_name,"latitude":lat,"longitude":lng})
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

# Municipality centroids loaded from all state GeoJSON files at startup
# Maps (state, normalized_name) → (lat, lng) and ibge_code → (lat, lng)
MUNICIPIO_CENTROIDS: dict[str, tuple[float, float]] = {}
IBGE_CODE_CENTROIDS: dict[str, tuple[float, float]] = {}

def _load_municipio_centroids():
    """Build centroid lookup from all state GeoJSON files."""
    import glob as _glob
    geo_dirs = [
        _os.path.join(_os.path.dirname(__file__), "..", "frontend", "public", "geo"),
        "/app/geo",
    ]
    # Map state IBGE code prefix → sigla
    state_prefixes = {"43": "RS", "33": "RJ", "31": "MG"}
    for geo_dir in geo_dirs:
        if not _os.path.isdir(geo_dir):
            continue
        for geo_path in sorted(_glob.glob(_os.path.join(geo_dir, "*-municipios.geojson"))):
            try:
                with open(geo_path) as f:
                    geo = _json.load(f)
                for feat in geo.get("features", []):
                    props = feat.get("properties", {})
                    code = props.get("codarea", "")
                    name = props.get("name", "")
                    if not code or not name:
                        continue
                    # Compute centroid from geometry
                    geom = feat.get("geometry", {})
                    coords = geom.get("coordinates", [])
                    geom_type = geom.get("type", "")
                    try:
                        all_points = []
                        if geom_type == "Polygon" and coords:
                            all_points = coords[0]
                        elif geom_type == "MultiPolygon" and coords:
                            for poly in coords:
                                if poly:
                                    all_points.extend(poly[0])
                        if all_points:
                            avg_lng = sum(p[0] for p in all_points) / len(all_points)
                            avg_lat = sum(p[1] for p in all_points) / len(all_points)
                            name_norm = normalize_name(name)
                            MUNICIPIO_CENTROIDS[name_norm] = (avg_lat, avg_lng)
                            IBGE_CODE_CENTROIDS[str(code)] = (avg_lat, avg_lng)
                    except Exception:
                        pass
            except Exception as e:
                logging.warning(f"Failed to load centroids from {geo_path}: {e}")
        if MUNICIPIO_CENTROIDS:
            break
    logging.info(f"Loaded {len(MUNICIPIO_CENTROIDS)} municipality centroids from GeoJSON")

_load_municipio_centroids()


@app.get("/api/heatmap/states")
@limiter.limit("60/minute")
def heatmap_states(request: Request,
    tipo: Optional[List[str]] = Query(None),
    ano: Optional[str] = None, semestre: Optional[str] = None,
    idade_min: Optional[int] = None, idade_max: Optional[int] = None,
    sexo: Optional[List[str]] = Query(None), cor: Optional[List[str]] = Query(None),
    selected_states: Optional[List[str]] = Query(None),
    db: Session = Depends(get_db)):
    validate_semestre(semestre)
    validate_age_filters(idade_min, idade_max)

    # Check response cache
    cache_key = f"heatmap_states:{tipo}:{ano}:{semestre}:{idade_min}:{idade_max}:{sexo}:{cor}:{selected_states}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    # Auto-filter: when partial state (MG) is combined with others, apply compatible types
    effective_tipo = tipo
    if selected_states and not tipo:
        from services.crime_categories import get_compatible_types
        has_partial = any(s in PARTIAL_STATES for s in selected_states)
        if has_partial and len(selected_states) > 1:
            compatible = get_compatible_types(selected_states)
            if compatible:
                all_types = set()
                for types in compatible.values():
                    all_types.update(types)
                if all_types:
                    effective_tipo = list(all_types)

    # Query 1: crimes table (detailed RS data)
    q1 = db.query(Crime.state, func.count().label("cnt")).filter(Crime.state.isnot(None))
    if effective_tipo: q1 = q1.filter(Crime.tipo_enquadramento.in_(effective_tipo))
    if semestre: q1 = q1.filter(Crime.year_month.in_(semester_months(semestre)))
    elif ano: q1 = q1.filter(Crime.year_month.like(f"{ano}-%"))
    if idade_min is not None: q1 = q1.filter(Crime.idade_vitima >= idade_min)
    if idade_max is not None: q1 = q1.filter(Crime.idade_vitima <= idade_max)
    if sexo: q1 = q1.filter(Crime.sexo_vitima.in_(sexo))
    if cor: q1 = q1.filter(Crime.cor_vitima.in_(cor))
    if selected_states: q1 = q1.filter(Crime.state.in_(selected_states))
    crimes_by_state = {r.state: r.cnt for r in q1.group_by(Crime.state).all()}

    # Query 2: staging table — only states with detailed data (RS, RJ, MG)
    detailed_states = list(STATE_QUALITY.keys())
    q2 = db.query(
        CrimeStaging.state,
        (func.coalesce(func.sum(CrimeStaging.occurrences), 0) +
         func.coalesce(func.sum(CrimeStaging.victims), 0)).label("cnt")
    ).filter(CrimeStaging.state.isnot(None), CrimeStaging.state.in_(detailed_states))
    if effective_tipo: q2 = q2.filter(CrimeStaging.crime_type.in_(effective_tipo))
    if semestre:
        year_str, sem = semestre.split('-')
        q2 = q2.filter(CrimeStaging.year == int(year_str))
        if sem == "S1": q2 = q2.filter(CrimeStaging.month.between(1, 6))
        else: q2 = q2.filter(CrimeStaging.month.between(7, 12))
    elif ano:
        q2 = q2.filter(CrimeStaging.year == int(ano))
    if sexo: q2 = q2.filter(CrimeStaging.sexo_vitima.in_(sexo))
    if selected_states: q2 = q2.filter(CrimeStaging.state.in_(selected_states))
    staging_by_state = {r.state: int(r.cnt) for r in q2.group_by(CrimeStaging.state).all() if r.cnt}

    # Merge: staging as base, crimes overrides for states it covers (avoids double-counting)
    merged = {**staging_by_state, **crimes_by_state}

    # Fix #9: return None for population if 0/null so frontend never divides by zero
    def _safe_pop(state_code: str) -> Optional[int]:
        p = get_state_population(state_code)
        return p if p else None

    # Fetch top 5 crime types per state for hover detail
    # For states in crimes table: query crimes
    crimes_states = set(crimes_by_state.keys())
    state_crime_types: dict[str, list[dict]] = {}
    for state_code in merged:
        if state_code in crimes_states:
            bq = db.query(Crime.tipo_enquadramento, func.count().label("cnt")).filter(Crime.state == state_code)
            if effective_tipo: bq = bq.filter(Crime.tipo_enquadramento.in_(effective_tipo))
            if semestre: bq = bq.filter(Crime.year_month.in_(semester_months(semestre)))
            elif ano: bq = bq.filter(Crime.year_month.like(f"{ano}-%"))
            if idade_min is not None: bq = bq.filter(Crime.idade_vitima >= idade_min)
            if idade_max is not None: bq = bq.filter(Crime.idade_vitima <= idade_max)
            if sexo: bq = bq.filter(Crime.sexo_vitima.in_(sexo))
            if cor: bq = bq.filter(Crime.cor_vitima.in_(cor))
            rows = bq.group_by(Crime.tipo_enquadramento).order_by(func.count().desc()).limit(5).all()
            state_crime_types[state_code] = [{"tipo": r[0], "count": r[1]} for r in rows if r[1] > 0]
        else:
            sq = db.query(
                CrimeStaging.crime_type,
                (func.coalesce(func.sum(CrimeStaging.occurrences), 0) +
                 func.coalesce(func.sum(CrimeStaging.victims), 0)).label("cnt")
            ).filter(CrimeStaging.state == state_code, CrimeStaging.crime_type.isnot(None))
            if effective_tipo: sq = sq.filter(CrimeStaging.crime_type.in_(effective_tipo))
            if semestre:
                year_str2, sem2 = semestre.split('-')
                sq = sq.filter(CrimeStaging.year == int(year_str2))
                if sem2 == "S1": sq = sq.filter(CrimeStaging.month.between(1, 6))
                else: sq = sq.filter(CrimeStaging.month.between(7, 12))
            elif ano:
                sq = sq.filter(CrimeStaging.year == int(ano))
            rows = sq.group_by(CrimeStaging.crime_type).order_by(desc(literal_column("cnt"))).limit(5).all()
            state_crime_types[state_code] = [{"tipo": r.crime_type, "count": int(r.cnt)} for r in rows if r.cnt > 0]

    result = [{"state": s, "latitude": c[0], "longitude": c[1], "weight": w,
             "population": _safe_pop(s),
             "crime_types": state_crime_types.get(s, [])}
            for s, w in merged.items()
            if (c := STATE_CENTROIDS.get(s))]
    _cache_set(cache_key, result)
    return result

@app.get("/api/data-availability")
@limiter.limit("60/minute")
def data_availability(request: Request,
    ano: Optional[str] = None,
    semestre: Optional[str] = None,
    selected_states: Optional[List[str]] = Query(None),
    db: Session = Depends(get_db)):
    """Check which selected states have data for the given period."""
    validate_semestre(semestre)
    if not selected_states:
        return {"states": {}}

    result = {}
    for state_code in selected_states:
        # Check crimes table (RS)
        cq = db.query(func.count(Crime.id)).filter(Crime.state == state_code)
        if semestre:
            cq = cq.filter(Crime.year_month.in_(semester_months(semestre)))
        elif ano:
            cq = cq.filter(Crime.year_month.like(f"{ano}-%"))
        crimes_count = cq.scalar() or 0

        # Check staging table
        sq = db.query(
            func.coalesce(func.sum(CrimeStaging.occurrences), 0) +
            func.coalesce(func.sum(CrimeStaging.victims), 0)
        ).filter(CrimeStaging.state == state_code)
        if semestre:
            year_str, sem = semestre.split('-')
            sq = sq.filter(CrimeStaging.year == int(year_str))
            if sem == "S1": sq = sq.filter(CrimeStaging.month.between(1, 6))
            else: sq = sq.filter(CrimeStaging.month.between(7, 12))
        elif ano:
            sq = sq.filter(CrimeStaging.year == int(ano))
        staging_count = sq.scalar() or 0

        total = crimes_count + int(staging_count)
        result[state_code] = {"has_data": total > 0, "count": total}

    return {"states": result}


@app.get("/api/state-filter-info")
def state_filter_info(
    selected_states: Optional[List[str]] = Query(None),
):
    """Get filter metadata for selected states.

    Returns compatible crime types, max granularity, and whether auto-filtering is needed.
    """
    states = selected_states or []
    return get_filter_info(states)


@app.get("/api/available-states")
def available_states(db: Session = Depends(get_db)):
    """List states with available data and their quality levels."""
    # Get row counts per state from staging
    staging_counts = dict(
        db.query(CrimeStaging.state, func.count(CrimeStaging.id))
        .group_by(CrimeStaging.state).all()
    )
    # Get RS count from crimes table
    rs_count = db.query(func.count(Crime.id)).filter(Crime.state == "RS").scalar() or 0

    states = []
    for sigla, (lat, lng) in STATE_CENTROIDS.items():
        count = staging_counts.get(sigla, 0)
        if sigla == "RS":
            count = rs_count or count
        quality = STATE_QUALITY.get(sigla, "basic" if count > 0 else "none")
        if count == 0 and sigla not in STATE_QUALITY:
            quality = "none"
        states.append({
            "sigla": sigla,
            "quality": quality,
            "record_count": count,
            "is_partial": sigla in PARTIAL_STATES,
        })
    return sorted(states, key=lambda s: (-{"full": 3, "partial": 2, "basic": 1, "none": 0}[s["quality"]], s["sigla"]))


@app.get("/api/data-sources")
def data_sources(db: Session = Depends(get_db)):
    """Return metadata for all data sources including record counts and last-updated timestamps."""
    import os as _os2
    from datetime import datetime as _dt, timezone

    staging_dir = _os2.path.join(_os2.path.dirname(__file__), "data", "staging")

    # Static source definitions
    sources = [
        {
            "id": "rs_ssp",
            "name": "SSP/RS",
            "state": "RS",
            "quality": "full",
            "url": None,
            "description": "Dados abertos da Secretaria de Segurança Pública do RS",
            "source_prefix": None,  # uses crimes table
        },
        {
            "id": "rj_isp",
            "name": "ISP/RJ",
            "state": "RJ",
            "quality": "full",
            "url": None,
            "description": "Instituto de Segurança Pública do RJ",
            "source_prefix": "rj_isp",
            "files": ["rj_isp_municipal.csv", "rj_isp_cisp.csv"],
        },
        {
            "id": "mg_sejusp",
            "name": "SEJUSP/MG",
            "state": "MG",
            "quality": "partial",
            "url": None,
            "description": "Crimes violentos de Minas Gerais",
            "caveat": "Apenas crimes violentos",
            "source_prefix": "mg_violent",
            "files": ["mg_violent_0.csv"],
        },
        {
            "id": "sinesp_vde",
            "name": "Ministério da Justiça e Segurança Pública",
            "state": "Todos",
            "quality": "basic",
            "url": None,
            "description": "Sistema Nacional de Estatísticas de Segurança Pública (15 tipos de crime)",
            "source_prefix": "sinesp",
            "files": ["sinesp_municipal.xlsx", "sinesp_uf.xlsx"],
        },
    ]

    def _file_mtime(filename):
        path = _os2.path.join(staging_dir, filename)
        if _os2.path.exists(path):
            return _dt.fromtimestamp(_os2.path.getmtime(path), tz=timezone.utc).isoformat()
        return None

    result = []
    for src in sources:
        entry = {
            "id": src["id"],
            "name": src["name"],
            "state": src["state"],
            "quality": src["quality"],
            "url": src["url"],
            "description": src["description"],
        }
        if "caveat" in src:
            entry["caveat"] = src["caveat"]

        # Record count
        if src["source_prefix"] is None:
            # RS data from crimes table
            entry["record_count"] = db.query(func.count(Crime.id)).filter(Crime.state == "RS").scalar() or 0
            # Last updated from most recent data_fato
            entry["last_updated"] = None
        else:
            entry["record_count"] = db.query(func.count(CrimeStaging.id)).filter(
                CrimeStaging.source.like(f"{src['source_prefix']}%")
            ).scalar() or 0
            # Last updated from file mtime
            mtimes = []
            for fn in src.get("files", []):
                mt = _file_mtime(fn)
                if mt:
                    mtimes.append(mt)
            entry["last_updated"] = max(mtimes) if mtimes else None

        result.append(entry)

    return result


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
def ingest_rs_history(force: bool = False):
    """Ingest all RS historical occurrence data (2022-2026). Runs in background."""
    def _run():
        from services.data_ingestion import KNOWN_URLS, ingest_from_url
        from database import DataSource as DS
        sess = SessionLocal()
        try:
            for url in KNOWN_URLS:
                fn = url.split("/")[-1]
                if force:
                    existing = sess.query(DS).filter(DS.filename == fn).first()
                    if existing:
                        # Delete old crime records for this source before re-ingesting
                        deleted = sess.query(Crime).filter(Crime.source_file == fn).delete()
                        existing.status = "pending"
                        sess.commit()
                        logging.info(f"RS force reset: {fn} (deleted {deleted} old records)")
                try:
                    # Use ingest_from_url (not ingest_and_geocode) to skip slow
                    # per-file batch geocoding (Nominatim 1.1s/req rate limit).
                    # Existing geo_cache handles most coords during CSV parsing.
                    count = ingest_from_url(url, sess, state="RS")
                    logging.info(f"RS ingested: {url} → {count} records")
                except Exception as e:
                    logging.error(f"RS ingest failed: {url} → {e}")
        finally:
            sess.close()
    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return {"message": f"RS historical ingestion started in background (2022-2026, force={force})"}

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

@app.post("/api/admin/refresh-staging")
def refresh_staging():
    """Delete cached staging files and re-download + re-parse all sources."""
    def _run():
        from services.staging_loader import refresh_staging_data
        refresh_staging_data()
    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return {"message": "Staging refresh started (cached files deleted, re-downloading). Check /api/admin/staging-stats."}

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
