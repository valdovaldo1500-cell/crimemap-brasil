import os, csv, logging, zipfile, tempfile, time
import requests
from database import Crime, DataSource, GeocodeCache, SessionLocal, init_db
from services.geocoder import GeocoderService, MAJOR_CITIES_RS

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")

COLUMN_MAPS = {
    "RS": {
        0:"sequencia",1:"data_fato",2:"hora_fato",3:"grupo_fato",
        4:"tipo_enquadramento",5:"tipo_fato",6:"municipio_fato",
        7:"local_fato",8:"bairro",9:"quantidade_vitimas",
        10:"idade_vitima",11:"sexo_vitima",12:"cor_vitima",
    },
}

def download_file(url, dest_dir=DATA_DIR):
    os.makedirs(dest_dir, exist_ok=True)
    fn = url.split("/")[-1]
    fp = os.path.join(dest_dir, fn)
    if os.path.exists(fp): return fp
<<<<<<< HEAD
    headers = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"}
    for attempt in range(3):
        try:
            logger.info(f"Downloading {url} (attempt {attempt+1}/3)...")
            r = requests.get(url, timeout=300, verify=False, headers=headers, stream=True)
            r.raise_for_status()
            with open(fp, "wb") as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)
            return fp
        except Exception as e:
            logger.warning(f"Download attempt {attempt+1} failed: {e}")
            if os.path.exists(fp):
                os.remove(fp)
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))
=======
    logger.info(f"Downloading {url}...")
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    with open(fp, "wb") as f: f.write(r.content)
    return fp
>>>>>>> feature/choropleth-mode

def extract_csv(zip_path):
    if zip_path.endswith(".csv"): return zip_path
    d = tempfile.mkdtemp()
    with zipfile.ZipFile(zip_path, "r") as zf: zf.extractall(d)
    for root, _, files in os.walk(d):
        for f in files:
            if f.endswith(".csv"): return os.path.join(root, f)
    raise FileNotFoundError(f"No CSV in {zip_path}")

def parse_int(v):
    try: return int(float(v)) if v and v.strip() else None
    except: return None

def ingest_csv(csv_path, source_filename="", db=None, state="RS"):
    if db is None: db = SessionLocal()
    column_map = COLUMN_MAPS.get(state)
    if not column_map:
        logger.error(f"No column map for state: {state}")
        return 0
    geocoder = GeocoderService()
    geo_cache = {}
    for gc in db.query(GeocodeCache).all():
        geo_cache[(gc.municipio, gc.bairro)] = (gc.latitude, gc.longitude)
    for city, coords in MAJOR_CITIES_RS.items():
        geo_cache[(city, "")] = coords
    count = 0
    batch = []
    for enc in ["latin-1", "utf-8", "cp1252"]:
        try:
            with open(csv_path, "r", encoding=enc) as f:
                reader = csv.reader(f, delimiter=";")
                next(reader)
                for row in reader:
                    if len(row) < 7: continue
                    d = {}
                    for idx, col in column_map.items():
                        if idx < len(row):
                            d[col] = row[idx].strip() if row[idx] else None
                    d["sequencia"] = parse_int(d.get("sequencia"))
                    d["quantidade_vitimas"] = parse_int(d.get("quantidade_vitimas"))
                    d["idade_vitima"] = parse_int(d.get("idade_vitima"))
                    mun = (d.get("municipio_fato") or "").upper().strip()
                    ba = (d.get("bairro") or "").strip()
                    coords = geo_cache.get((mun, ba)) or geo_cache.get((mun, ""))
                    if not coords and mun:
                        coords = geocoder.geocode_location(mun, ba, db)
                        if coords: geo_cache[(mun, ba if ba else "")] = coords
                    if coords:
                        d["latitude"], d["longitude"] = coords
                    ds = d.get("data_fato", "")
                    if ds and "/" in ds:
                        parts = ds.split("/")
                        if len(parts)==3: d["year_month"] = f"{parts[2]}-{parts[1]}"
                    d["source_file"] = source_filename
                    d["state"] = state
                    batch.append(Crime(**d))
                    count += 1
                    if len(batch) >= 1000:
                        db.bulk_save_objects(batch)
                        db.commit()
                        batch = []
                        if count % 5000 == 0:
                            logger.info(f"  {count} records...")
            break
        except UnicodeDecodeError: continue
    if batch:
        db.bulk_save_objects(batch)
        db.commit()
    logger.info(f"Total: {count} records from {source_filename} (state={state})")
    return count

def ingest_from_url(url, db=None, state="RS"):
    if db is None: db = SessionLocal()
    fn = url.split("/")[-1]
    existing = db.query(DataSource).filter(DataSource.filename == fn).first()
    if existing and existing.status == "ingested":
        logger.info(f"Already ingested: {fn}")
        return existing.records_count
    src = existing or DataSource(filename=fn, url=url, status="pending")
    if not existing: db.add(src); db.commit()
    try:
        fp = download_file(url)
        csv_path = extract_csv(fp)
        count = ingest_csv(csv_path, source_filename=fn, db=db, state=state)
        src.records_count = count
        src.status = "ingested"
        db.commit()
        return count
    except Exception as e:
        logger.error(f"Error: {fn}: {e}")
        src.status = "error"
        db.commit()
        raise

def ingest_and_geocode(url, db=None, state="RS"):
    """Ingest CSV from URL, then batch-geocode new bairros."""
    count = ingest_from_url(url, db, state=state)
    from services.geocoder import batch_geocode_new_bairros
    batch_geocode_new_bairros(db)
    return count


KNOWN_URLS = [
    # RS historical occurrence data (2022-2026)
    "https://www.ssp.rs.gov.br/upload/arquivos/202401/16144253-2022-de-janeiro-a-dezembro.zip",
    "https://www.ssp.rs.gov.br/upload/arquivos/202501/20100119-2023-janeiro-a-dezembro.zip",
    "https://www.ssp.rs.gov.br/upload/arquivos/202601/16132801-spj-dados-abertos-ocorrencias-jan-dez-2024-em-05-01-2026.zip",
    "https://www.ssp.rs.gov.br/upload/arquivos/202601/16132458-spj-dados-abertos-ocorrencias-jan-dez-2025-em-05-01-2026.zip",
    "https://www.ssp.rs.gov.br/upload/arquivos/202602/19140211-spj-dados-abertos-ocorrencias-jan-2026-em-05-02-2026.zip",
]

if __name__ == "__main__":
    init_db()
    db = SessionLocal()
    for url in KNOWN_URLS:
        try: ingest_from_url(url, db, state="RS")
        except Exception as e: logger.error(f"Failed: {url} - {e}")
    db.close()
