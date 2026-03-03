# CrimeMap RS

Mapa interativo de ocorrencias criminais do Rio Grande do Sul, Brasil.

Dados: Secretaria da Seguranca Publica do RS (SSP-RS) - Dados Abertos (Lei 15.610/2021)

## Requisitos

- Python 3.11+
- Node.js 20+
- Ou Docker + Docker Compose

## Inicio Rapido

### Opcao 1: Local

```bash
# Backend
cd backend
pip install -r requirements.txt
mkdir -p data
python3 -c "from database import init_db; init_db()"
python3 services/data_ingestion.py  # Baixa e importa dados
uvicorn main:app --reload --port 8000

# Frontend (outro terminal)
cd frontend
npm install
npm run dev
```

Acesse: http://localhost:3000

### Opcao 2: Docker

```bash
docker-compose up --build
```

## Estrutura

```
crimemap-rs/
  backend/           # FastAPI + SQLAlchemy
    main.py          # API endpoints
    database.py      # Modelos SQLAlchemy
    schemas.py       # Schemas Pydantic
    services/
      geocoder.py    # Geocodificacao de municipios
      data_ingestion.py  # Download e importacao de dados
  frontend/          # Next.js + Leaflet
    src/
      app/page.tsx   # Pagina principal
      components/CrimeMap.tsx  # Componente do mapa
      lib/api.ts     # Cliente API
  docker-compose.yml
```

## API Endpoints

- `GET /api/heatmap/municipios` - Heatmap por municipio (zoom out)
- `GET /api/heatmap/bairros` - Heatmap por bairro (zoom in)
- `GET /api/crimes` - Lista de crimes paginada
- `GET /api/crime-types` - Tipos de crime
- `GET /api/municipios` - Lista de municipios
- `GET /api/stats` - Estatisticas gerais
- `GET /api/search?q=` - Busca por local

## Fonte dos Dados

https://www.ssp.rs.gov.br/dados-abertos
