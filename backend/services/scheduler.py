import logging
from datetime import datetime, timedelta
from apscheduler.schedulers.background import BackgroundScheduler

logger = logging.getLogger(__name__)
_scheduler: BackgroundScheduler | None = None


def auto_ingest_job():
    """Periodic job: check SSP for new files, ingest, geocode."""
    from services.update_checker import get_new_urls
    from services.data_ingestion import ingest_and_geocode
    for state in ["RS", "SP"]:
        new_urls = get_new_urls(state=state)
        if not new_urls:
            logger.info(f"No new data files found for {state}")
            continue
        for url in new_urls:
            try:
                count = ingest_and_geocode(url, state=state)
                logger.info(f"Ingested {count} records from {url} (state={state})")
            except Exception as e:
                logger.error(f"Failed to ingest {url}: {e}")


def staging_refresh_job():
    """Periodic job: refresh all staging data (SINESP, RJ ISP, MG)."""
    from services.staging_loader import refresh_staging_data
    try:
        results = refresh_staging_data()
        logger.info(f"Staging refresh complete: {results.get('_total', 0)} rows, {results.get('_distinct_states', 0)} states")
    except Exception as e:
        logger.error(f"Staging refresh failed: {e}")


def start_scheduler(interval_days=7):
    global _scheduler
    if _scheduler is not None:
        return
    _scheduler = BackgroundScheduler()
    _scheduler.add_job(auto_ingest_job, 'interval', days=interval_days, id='auto_ingest')
    _scheduler.add_job(staging_refresh_job, 'interval', days=interval_days,
                       id='staging_refresh',
                       next_run_time=datetime.now() + timedelta(days=3))
    _scheduler.start()
    logger.info(f"Scheduler started: auto_ingest every {interval_days} days, staging_refresh every {interval_days} days (offset 3 days)")


def stop_scheduler():
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("Scheduler stopped")
