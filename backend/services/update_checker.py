import logging, requests
from bs4 import BeautifulSoup
from database import DataSource, SessionLocal

logger = logging.getLogger(__name__)

SSP_RS_URL = "https://www.ssp.rs.gov.br/dados-abertos"

def check_for_new_data_rs():
    try:
        resp = requests.get(SSP_RS_URL, timeout=30)
        soup = BeautifulSoup(resp.text, "html.parser")
        links = []
        for a in soup.find_all("a", href=True):
            href = a["href"]
            if "dados-abertos" in href.lower() and href.endswith(".zip"):
                if not href.startswith("http"):
                    href = f"https://www.ssp.rs.gov.br{href}"
                links.append(href)
        return links
    except Exception as e:
        logger.error(f"Error checking RS updates: {e}")
        return []

def get_new_urls(state="RS"):
    db = SessionLocal()
    if state == "RS":
        all_links = check_for_new_data_rs()
    else:
        all_links = []
    ingested = {ds.url for ds in db.query(DataSource).all()}
    new = [u for u in all_links if u not in ingested]
    db.close()
    return new
