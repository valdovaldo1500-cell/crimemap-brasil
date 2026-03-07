import math, time, logging
from geopy.geocoders import Nominatim
from geopy.exc import GeocoderTimedOut, GeocoderServiceError
logger = logging.getLogger(__name__)

def _haversine_km(lat1, lon1, lat2, lon2):
    """Haversine distance between two lat/lng points in kilometers."""
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * 2 * math.asin(math.sqrt(a))

MAJOR_CITIES_RS = {
    "PORTO ALEGRE":(-30.0346,-51.2177),"CAXIAS DO SUL":(-29.1681,-51.1794),
    "CANOAS":(-29.9178,-51.1836),"SANTA MARIA":(-29.6842,-53.8069),
    "PELOTAS":(-31.7654,-52.3376),"RIO GRANDE":(-32.0350,-52.0986),
    "NOVO HAMBURGO":(-29.6788,-51.1305),"GRAVATAI":(-29.9447,-50.9919),
    "VIAMAO":(-30.0810,-51.0234),"PASSO FUNDO":(-28.2624,-52.4068),
    "SAO LEOPOLDO":(-29.7604,-51.1470),"ALVORADA":(-29.9908,-51.0811),
    "SANTA CRUZ DO SUL":(-29.7176,-52.4258),"BAGE":(-31.3289,-54.1069),
    "ERECHIM":(-27.6342,-52.2737),"URUGUAIANA":(-29.7548,-57.0882),
    "BENTO GONCALVES":(-29.1715,-51.5189),"CACHOEIRA DO SUL":(-30.039,-52.894),
    "IJUI":(-28.3878,-53.9146),"SANTO ANGELO":(-28.2994,-54.2631),
    "SANTA ROSA":(-27.8706,-54.4814),"SAO BORJA":(-28.6608,-56.0042),
    "ALEGRETE":(-29.7831,-55.7917),"TORRES":(-29.3350,-49.7264),
    "VACARIA":(-28.7536,-50.7067),"SAPUCAIA DO SUL":(-29.8275,-51.1449),
    "CACHOEIRINHA":(-29.9511,-51.0940),"LAJEADO":(-29.4669,-51.9614),
    "CAPAO DA CANOA":(-29.7456,-50.0097),"GUAIBA":(-30.1142,-51.3250),
    "MONTENEGRO":(-29.6886,-51.4612),"FARROUPILHA":(-29.2250,-51.3478),
    "SANTIAGO":(-29.1917,-54.8667),"SAO GABRIEL":(-30.3356,-54.3200),
    "OSORIO":(-29.8869,-50.2706),"ESTEIO":(-29.8617,-51.1785),
    "SANTANA DO LIVRAMENTO":(-30.8908,-55.5328),"CRUZ ALTA":(-28.6384,-53.6064),
    "TRAMANDAI":(-29.9847,-50.1318),"CAMAQUA":(-30.8511,-51.8117),
    "SAPIRANGA":(-29.6358,-51.0052),"TAQUARA":(-29.6506,-50.7811),
    "CHARQUEADAS":(-29.9556,-51.6244),"CAMPO BOM":(-29.6753,-51.0598),
    "VENANCIO AIRES":(-29.6060,-52.1917),"ELDORADO DO SUL":(-30.0864,-51.3672),
    "PAROBE":(-29.6286,-50.8339),"IGREJINHA":(-29.5747,-50.7906),
    "GENERAL CAMARA":(-29.9019,-51.7583),"FREDERICO WESTPHALEN":(-27.3594,-53.3942),
    "CARAZINHO":(-28.2839,-52.7864),"MARAU":(-28.4489,-52.2000),
    "TRES PASSOS":(-27.4561,-53.9317),"SARANDI":(-27.9425,-52.9231),
    "ROSARIO DO SUL":(-30.2558,-54.9142),"ITAQUI":(-29.1253,-56.5531),
    "SAO SEBASTIAO DO CAI":(-29.5881,-51.3739),
    "CARLOS BARBOSA":(-29.2961,-51.5031),"GARIBALDI":(-29.2564,-51.5336),
    "TEUTONIA":(-29.4478,-51.8061),"ESTRELA":(-29.5028,-51.9611),
    "ARROIO DO MEIO":(-29.3997,-51.9442),"ENCANTADO":(-29.2333,-51.8694),
    "DOIS IRMAOS":(-29.5828,-51.0878),"IVOTI":(-29.5933,-51.1564),
    "PORTAO":(-29.7025,-51.2450),"NOVA PETROPOLIS":(-29.3747,-51.1136),
    "CANELA":(-29.3656,-50.8119),"GRAMADO":(-29.3786,-50.8742),
    "SERAFINA CORREA":(-28.7119,-51.9347),
}


MAX_BAIRRO_DISTANCE_KM = 50

class GeocoderService:
    def __init__(self):
        self.geolocator = Nominatim(user_agent="crimemap-rs-v1", timeout=10)
        self._req = 0

    def _rate_limit(self):
        self._req += 1
        time.sleep(1.1)

    def _get_municipality_centroid(self, mun, db=None):
        """Get municipality centroid from MAJOR_CITIES_RS or GeocodeCache (bairro='')."""
        if mun in MAJOR_CITIES_RS:
            return MAJOR_CITIES_RS[mun]
        if db:
            from database import GeocodeCache
            cached = db.query(GeocodeCache).filter(
                GeocodeCache.municipio == mun, GeocodeCache.bairro == "").first()
            if cached:
                return (cached.latitude, cached.longitude)
        return None

    def _validate_distance(self, lat, lng, mun, db=None):
        """Return True if coords are within MAX_BAIRRO_DISTANCE_KM of municipality centroid."""
        centroid = self._get_municipality_centroid(mun, db)
        if not centroid:
            return True  # no centroid to validate against
        dist = _haversine_km(lat, lng, centroid[0], centroid[1])
        if dist > MAX_BAIRRO_DISTANCE_KM:
            logger.warning(f"Geocode for {mun} at ({lat},{lng}) is {dist:.0f}km from centroid — rejecting")
            return False
        return True

    def geocode_location(self, municipio, bairro="", db=None):
        from database import GeocodeCache
        mun = municipio.upper().strip()
        ba = (bairro or "").strip()
        if not ba and mun in MAJOR_CITIES_RS:
            coords = MAJOR_CITIES_RS[mun]
            if db: self._save_cache(db, mun, "", coords[0], coords[1])
            return coords
        if db:
            cached = db.query(GeocodeCache).filter(
                GeocodeCache.municipio == mun, GeocodeCache.bairro == ba).first()
            if cached: return (cached.latitude, cached.longitude)
        try:
            self._rate_limit()
            q = f"{ba}, {mun}, RS, Brasil" if ba else f"{mun}, Rio Grande do Sul, Brasil"
            loc = self.geolocator.geocode(q)
            if loc:
                coords = (loc.latitude, loc.longitude)
                # Validate bairro geocode is near the municipality
                if ba and not self._validate_distance(coords[0], coords[1], mun, db):
                    # Use municipality centroid instead
                    centroid = self._get_municipality_centroid(mun, db)
                    if centroid:
                        coords = centroid
                        if db: self._save_cache(db, mun, ba, coords[0], coords[1])
                        return coords
                if db: self._save_cache(db, mun, ba, coords[0], coords[1])
                return coords
            if ba:
                if ba.upper() != "CENTRO":
                    centro = self.geocode_location(municipio, "CENTRO", db)
                    if centro:
                        self._save_cache(db, mun, ba, centro[0], centro[1])
                        return centro
                return self.geocode_location(municipio, "", db)
        except (GeocoderTimedOut, GeocoderServiceError) as e:
            logger.warning(f"Geocoding failed {municipio}/{bairro}: {e}")
        return None

    def _save_cache(self, db, municipio, bairro, lat, lng):
        from database import GeocodeCache
        try:
            exists = db.query(GeocodeCache).filter(
                GeocodeCache.municipio == municipio, GeocodeCache.bairro == bairro).first()
            if not exists:
                db.add(GeocodeCache(municipio=municipio, bairro=bairro,
                    latitude=lat, longitude=lng, source="nominatim"))
                db.commit()
        except Exception:
            db.rollback()


def batch_geocode_new_bairros(db=None, municipio_filter=None, min_crimes=10):
    """Geocode (municipio, bairro) pairs missing from cache. Returns (done, total)."""
    import unicodedata
    from database import Crime, GeocodeCache, SessionLocal
    from sqlalchemy import func

    def _normalize(s):
        nfkd = unicodedata.normalize('NFD', s)
        return ''.join(c for c in nfkd if unicodedata.category(c) != 'Mn').upper().strip()

    if db is None:
        db = SessionLocal()
    q = db.query(Crime.municipio_fato, Crime.bairro).filter(
        Crime.bairro.isnot(None), Crime.bairro != "")
    if municipio_filter:
        q = q.filter(Crime.municipio_fato.ilike(f"%{municipio_filter}%"))
    q = q.group_by(Crime.municipio_fato, Crime.bairro).having(func.count(Crime.id) >= min_crimes)
    seen: dict[tuple[str, str], tuple[str, str]] = {}
    for r in q.all():
        key = (_normalize(r.municipio_fato), _normalize(r.bairro))
        if key not in seen:
            seen[key] = (r.municipio_fato, r.bairro)
    pairs = list(seen.values())
    cache_rows = db.query(GeocodeCache).filter(GeocodeCache.bairro != "").all()
    cached = {(_normalize(c.municipio), _normalize(c.bairro)) for c in cache_rows}
    to_geocode = [(m, b) for m, b in pairs if (_normalize(m), _normalize(b)) not in cached]
    total = len(to_geocode)
    if total == 0:
        return (0, 0)
    geocoder = GeocoderService()
    done = 0
    for mun, bairro in to_geocode:
        try:
            geocoder.geocode_location(mun, bairro, db=db)
            done += 1
            if done % 50 == 0:
                logger.info(f"Geocoded {done}/{total} bairros")
        except Exception as e:
            logger.warning(f"Failed to geocode {bairro}, {mun}: {e}")
    logger.info(f"Batch geocoding complete: {done}/{total} bairros")
    return (done, total)
