from unittest.mock import patch, call
from services.scheduler import auto_ingest_job, start_scheduler, stop_scheduler


def test_auto_ingest_no_new_urls():
    """When no new URLs found, ingestion should not be called."""
    with patch('services.update_checker.get_new_urls', return_value=[]) as mock_urls, \
         patch('services.data_ingestion.ingest_and_geocode') as mock_ingest:
        auto_ingest_job()

    mock_urls.assert_called_once()
    mock_ingest.assert_not_called()


def test_auto_ingest_with_new_urls():
    """Each new URL should trigger ingest_and_geocode."""
    urls = ["http://example.com/a.zip", "http://example.com/b.zip"]
    with patch('services.update_checker.get_new_urls', return_value=urls), \
         patch('services.data_ingestion.ingest_and_geocode', return_value=100) as mock_ingest:
        auto_ingest_job()

    assert mock_ingest.call_count == 2
    mock_ingest.assert_has_calls([call(urls[0]), call(urls[1])])


def test_scheduler_starts_stops():
    """Scheduler should start and stop without errors."""
    import services.scheduler as sched
    sched._scheduler = None  # Reset state
    start_scheduler(interval_days=1)
    assert sched._scheduler is not None
    stop_scheduler()
    assert sched._scheduler is None
