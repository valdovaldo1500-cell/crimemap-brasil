import os, csv, tempfile
from unittest.mock import patch, MagicMock
from database import Crime
from services.data_ingestion import ingest_csv, ingest_and_geocode


def test_ingest_and_geocode_chains_correctly():
    """Both ingest and geocode should be called in sequence."""
    with patch('services.data_ingestion.ingest_from_url', return_value=100) as mock_ingest, \
         patch('services.geocoder.batch_geocode_new_bairros', return_value=(5, 5)) as mock_geo:
        result = ingest_and_geocode("http://example.com/data.zip")

    assert result == 100
    mock_ingest.assert_called_once()
    mock_geo.assert_called_once()


def test_ingest_csv_column_mapping(db):
    """CSV rows should map correctly to Crime model fields."""
    tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, encoding='latin-1')
    writer = csv.writer(tmp, delimiter=';')
    writer.writerow(['seq', 'data', 'hora', 'grupo', 'tipo', 'tipo_fato', 'municipio',
                     'local', 'bairro', 'qtd', 'idade', 'sexo', 'cor'])
    writer.writerow(['1', '15/03/2025', '14:30', 'CONTRA PESSOA', 'AMEACA',
                     'AMEACA', 'PORTO ALEGRE', 'RUA X', 'CENTRO', '1', '30', 'M', 'BRANCA'])
    tmp.close()
    try:
        with patch('services.data_ingestion.GeocoderService') as MockGeo:
            instance = MockGeo.return_value
            instance.geocode_location.return_value = (-30.03, -51.22)
            count = ingest_csv(tmp.name, source_filename="test.csv", db=db)
    finally:
        os.unlink(tmp.name)

    assert count == 1
    crime = db.query(Crime).first()
    assert crime.municipio_fato == "PORTO ALEGRE"
    assert crime.bairro == "CENTRO"
    assert crime.tipo_enquadramento == "AMEACA"
    assert crime.year_month == "2025-03"
