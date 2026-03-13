"""GA4 Analytics service — query report data via the Google Analytics Data API."""

import os
from functools import lru_cache
from google.analytics.data_v1beta import BetaAnalyticsDataClient
from google.analytics.data_v1beta.types import (
    DateRange,
    Dimension,
    Metric,
    RunReportRequest,
    RunRealtimeReportRequest,
)
from google.oauth2 import service_account

PROPERTY_ID = "528349131"
SA_KEY_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "ga4-service-account.json")


@lru_cache(maxsize=1)
def _client() -> BetaAnalyticsDataClient:
    creds = service_account.Credentials.from_service_account_file(
        SA_KEY_PATH,
        scopes=["https://www.googleapis.com/auth/analytics.readonly"],
    )
    return BetaAnalyticsDataClient(credentials=creds)


def get_pageviews(days: int = 30) -> dict:
    """Total pageviews and sessions for the last N days."""
    req = RunReportRequest(
        property=f"properties/{PROPERTY_ID}",
        date_ranges=[DateRange(start_date=f"{days}daysAgo", end_date="today")],
        metrics=[
            Metric(name="screenPageViews"),
            Metric(name="sessions"),
            Metric(name="activeUsers"),
            Metric(name="newUsers"),
        ],
    )
    resp = _client().run_report(req)
    row = resp.rows[0] if resp.rows else None
    return {
        "pageviews": int(row.metric_values[0].value) if row else 0,
        "sessions": int(row.metric_values[1].value) if row else 0,
        "active_users": int(row.metric_values[2].value) if row else 0,
        "new_users": int(row.metric_values[3].value) if row else 0,
        "days": days,
    }


def get_top_pages(days: int = 30, limit: int = 10) -> list[dict]:
    """Top pages by pageviews."""
    req = RunReportRequest(
        property=f"properties/{PROPERTY_ID}",
        date_ranges=[DateRange(start_date=f"{days}daysAgo", end_date="today")],
        dimensions=[Dimension(name="pagePath")],
        metrics=[Metric(name="screenPageViews")],
        limit=limit,
        order_bys=[{"metric": {"metric_name": "screenPageViews"}, "desc": True}],
    )
    resp = _client().run_report(req)
    return [
        {"path": r.dimension_values[0].value, "pageviews": int(r.metric_values[0].value)}
        for r in resp.rows
    ]


def get_top_countries(days: int = 30, limit: int = 10) -> list[dict]:
    """Top countries by active users."""
    req = RunReportRequest(
        property=f"properties/{PROPERTY_ID}",
        date_ranges=[DateRange(start_date=f"{days}daysAgo", end_date="today")],
        dimensions=[Dimension(name="country")],
        metrics=[Metric(name="activeUsers")],
        limit=limit,
        order_bys=[{"metric": {"metric_name": "activeUsers"}, "desc": True}],
    )
    resp = _client().run_report(req)
    return [
        {"country": r.dimension_values[0].value, "users": int(r.metric_values[0].value)}
        for r in resp.rows
    ]


def get_daily_users(days: int = 30) -> list[dict]:
    """Daily active users over the last N days."""
    req = RunReportRequest(
        property=f"properties/{PROPERTY_ID}",
        date_ranges=[DateRange(start_date=f"{days}daysAgo", end_date="today")],
        dimensions=[Dimension(name="date")],
        metrics=[Metric(name="activeUsers"), Metric(name="screenPageViews")],
        order_bys=[{"dimension": {"dimension_name": "date"}, "desc": False}],
    )
    resp = _client().run_report(req)
    return [
        {
            "date": r.dimension_values[0].value,
            "users": int(r.metric_values[0].value),
            "pageviews": int(r.metric_values[1].value),
        }
        for r in resp.rows
    ]


def get_realtime_users() -> dict:
    """Active users in the last 30 minutes."""
    req = RunRealtimeReportRequest(
        property=f"properties/{PROPERTY_ID}",
        metrics=[Metric(name="activeUsers")],
    )
    resp = _client().run_realtime_report(req)
    row = resp.rows[0] if resp.rows else None
    return {"active_users_30min": int(row.metric_values[0].value) if row else 0}
