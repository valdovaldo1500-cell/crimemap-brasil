from unittest.mock import patch, MagicMock
from database import GeocodeCache, Crime
from services.geocoder import GeocoderService, batch_geocode_new_bairros


def test_centro_fallback_before_municipality(db):
    """When bairro lookup fails, should try 'Centro' before municipality centroid."""
    geo = GeocoderService()
    calls = []

    def mock_geocode(query):
        calls.append(query)
        if "CENTRO" in query.upper():
            loc = MagicMock()
            loc.latitude = -30.03
            loc.longitude = -51.22
            return loc
        if "JARDIM" in query.upper():
            return None  # bairro fails
        # municipality-level
        loc = MagicMock()
        loc.latitude = -30.05
        loc.longitude = -51.25
        return loc

    with patch.object(geo, '_rate_limit'), \
         patch.object(geo.geolocator, 'geocode', side_effect=mock_geocode):
        result = geo.geocode_location("PORTO ALEGRE", "JARDIM BOTANICO", db)

    assert result == (-30.03, -51.22), "Should return Centro coords"
    assert any("CENTRO" in c for c in calls), "Should have tried Centro"


def test_centro_no_infinite_recursion(db):
    """When bairro='CENTRO' and API fails, should fall through to municipality."""
    geo = GeocoderService()

    def mock_geocode(query):
        if "CENTRO" in query.upper() and "RS, Brasil" in query:
            return None  # Centro lookup fails
        if "Rio Grande do Sul" in query:
            loc = MagicMock()
            loc.latitude = -30.05
            loc.longitude = -51.25
            return loc
        return None

    # Use a city NOT in MAJOR_CITIES_RS to avoid the early-return shortcut
    with patch.object(geo, '_rate_limit'), \
         patch.object(geo.geolocator, 'geocode', side_effect=mock_geocode):
        result = geo.geocode_location("CIDADEZINHA", "CENTRO", db)

    assert result == (-30.05, -51.25), "Should fall through to municipality"


def test_centro_result_cached_for_original_bairro(db):
    """When Centro fallback succeeds, should cache under original bairro name."""
    geo = GeocoderService()

    def mock_geocode(query):
        if "CENTRO" in query.upper():
            loc = MagicMock()
            loc.latitude = -30.03
            loc.longitude = -51.22
            return loc
        return None

    with patch.object(geo, '_rate_limit'), \
         patch.object(geo.geolocator, 'geocode', side_effect=mock_geocode):
        geo.geocode_location("CANOAS", "MATHIAS VELHO", db)

    cached = db.query(GeocodeCache).filter(
        GeocodeCache.municipio == "CANOAS",
        GeocodeCache.bairro == "MATHIAS VELHO"
    ).first()
    assert cached is not None, "Original bairro should be cached"
    assert cached.latitude == -30.03


def test_batch_geocode_skips_cached(db):
    """Pre-populated cache entries should not trigger API calls."""
    db.add(Crime(municipio_fato="CANOAS", bairro="CENTRO", data_fato="01/01/2025",
                 grupo_fato="X", tipo_enquadramento="Y", latitude=-30.0, longitude=-51.0,
                 year_month="2025-01"))
    for i in range(15):
        db.add(Crime(municipio_fato="CANOAS", bairro="CENTRO", data_fato="01/01/2025",
                     grupo_fato="X", tipo_enquadramento="Y", latitude=-30.0, longitude=-51.0,
                     year_month="2025-01"))
    db.add(GeocodeCache(municipio="CANOAS", bairro="CENTRO",
                        latitude=-29.92, longitude=-51.18, source="nominatim"))
    db.commit()

    with patch.object(GeocoderService, 'geocode_location') as mock_geo:
        done, total = batch_geocode_new_bairros(db=db)

    mock_geo.assert_not_called()
    assert done == 0
