import logging, requests
from bs4 import BeautifulSoup
from database import DataSource, SessionLocal

logger = logging.getLogger(__name__)
SSP_URL = "https://www.ssp.rs.gov.br/dados-abertos"

def check_for_new_data():
    try:
        resp = requests.get(SSP_URL, timeout=30, verify=False)
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
        logger.error(f"Error checking updates: {e}")
        return []

def get_new_urls():
    db = SessionLocal()
    all_links = check_for_new_data()
    ingested = {ds.url for ds in db.query(DataSource).all()}
    new = [u for u in all_links if u not in ingested]
    db.close()
    return new
