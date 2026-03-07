import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from database import Base, Crime, get_db
from main import app


@pytest.fixture
def client():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine)

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db

    # Seed test data
    db = TestSession()
    for i in range(5):
        db.add(Crime(
            municipio_fato="PORTO ALEGRE", bairro="CENTRO",
            data_fato="15/01/2025", grupo_fato="CONTRA PESSOA",
            tipo_enquadramento="AMEACA", latitude=-30.03, longitude=-51.22,
            year_month="2025-01",
        ))
    for i in range(3):
        db.add(Crime(
            municipio_fato="PORTO ALEGRE", bairro="CENTRO",
            data_fato="15/01/2025", grupo_fato="CONTRA PATRIMONIO",
            tipo_enquadramento="FURTO", latitude=-30.03, longitude=-51.22,
            year_month="2025-01",
        ))
    for i in range(2):
        db.add(Crime(
            municipio_fato="PORTO ALEGRE", bairro="CENTRO",
            data_fato="15/08/2025", grupo_fato="CONTRA PESSOA",
            tipo_enquadramento="AMEACA", latitude=-30.03, longitude=-51.22,
            year_month="2025-08",
        ))
    db.commit()
    db.close()

    yield TestClient(app)
    app.dependency_overrides.clear()


def test_location_stats_returns_breakdown(client):
    resp = client.get("/api/location-stats", params={"municipio": "PORTO ALEGRE"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 10
    assert len(data["crime_types"]) == 2
    types = {ct["tipo_enquadramento"] for ct in data["crime_types"]}
    assert "AMEACA" in types
    assert "FURTO" in types


def test_location_stats_filters_by_semestre(client):
    resp = client.get("/api/location-stats", params={
        "municipio": "PORTO ALEGRE", "semestre": "2025-S1"
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 8  # Only Jan records (S1 = Jan-Jun)
