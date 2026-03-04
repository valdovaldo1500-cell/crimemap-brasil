import logging
from apscheduler.schedulers.background import BackgroundScheduler

logger = logging.getLogger(__name__)
_scheduler: BackgroundScheduler | None = None


def auto_ingest_job():
    """Periodic job: check SSP for new files, ingest, geocode."""
    from services.update_checker import get_new_urls
    from services.data_ingestion import ingest_and_geocode
    new_urls = get_new_urls()
    if not new_urls:
        logger.info("No new data files found")
        return
    for url in new_urls:
        try:
            count = ingest_and_geocode(url)
            logger.info(f"Ingested {count} records from {url}")
        except Exception as e:
            logger.error(f"Failed to ingest {url}: {e}")


def start_scheduler(interval_days=7):
    global _scheduler
    if _scheduler is not None:
        return
    _scheduler = BackgroundScheduler()
    _scheduler.add_job(auto_ingest_job, 'interval', days=interval_days, id='auto_ingest')
    _scheduler.start()
    logger.info(f"Scheduler started: checking SSP every {interval_days} days")


def stop_scheduler():
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("Scheduler stopped")
