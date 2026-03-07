# Crime Brasil

Mapa interativo de criminalidade do Brasil com dados de multiplas fontes estaduais e federais.

**crimebrasil.com.br**

## Fontes de Dados

| Fonte | Estados | Qualidade | Descricao |
|-------|---------|-----------|-----------|
| SSP/RS | RS | Completo | Dados abertos da Secretaria de Seguranca Publica (Lei 15.610/2021) |
| ISP/RJ | RJ | Completo | Instituto de Seguranca Publica do RJ |
| SEJUSP/MG | MG | Parcial | Apenas crimes violentos |
| SINESP/MJ | Todos (27 UFs) | Basico | Dados agregados do Ministerio da Justica |

## Inicio Rapido

### Docker (recomendado)

```bash
docker compose up --build
```

- Frontend: http://localhost:3001
- Backend API: http://localhost:8000

### Local

```bash
# Backend
cd backend
pip install -r requirements.txt
mkdir -p data
python3 -c "from database import init_db; init_db()"
uvicorn main:app --reload --port 8000

# Frontend (outro terminal)
cd frontend
npm install
npm run dev
```

## Estrutura

```
crime-map/
  backend/
    main.py                    # FastAPI app + endpoints
    database.py                # Modelos SQLAlchemy
    schemas.py                 # Schemas Pydantic
    services/
      staging_loader.py        # ETL multi-estado
      scheduler.py             # APScheduler (2 jobs semanais)
      data_ingestion.py        # Importacao RS/SP SSP
      crime_categories.py      # Mapeamento de categorias
      population.py            # Dados populacionais
      geocoder.py              # Geocodificacao
      update_checker.py        # Verificacao de novos arquivos SSP
  frontend/
    src/
      app/page.tsx             # Pagina principal
      components/CrimeMap.tsx  # Componente do mapa Leaflet
      lib/api.ts               # Cliente API
    public/geo/                # Arquivos GeoJSON
  docker-compose.yml
  CLAUDE.md                    # Guia do projeto
  CHANGELOG.md                 # Historico de mudancas
```

## API Endpoints

### Publicos

| Endpoint | Descricao |
|----------|-----------|
| `GET /api/heatmap/municipios` | Mapa de calor por municipio |
| `GET /api/heatmap/bairros` | Mapa de calor por bairro (RS) |
| `GET /api/heatmap/states` | Mapa de calor por estado |
| `GET /api/filter-options` | Opcoes de filtro disponiveis |
| `GET /api/stats` | Estatisticas gerais |
| `GET /api/available-states` | Estados com metadados de qualidade |
| `GET /api/state-filter-info` | Info de compatibilidade entre estados |
| `GET /api/data-sources` | Metadados das fontes de dados |
| `GET /api/search?q=` | Busca por local |
| `POST /api/bug-report` | Reportar bug |

### Admin

| Endpoint | Descricao |
|----------|-----------|
| `POST /api/admin/load-staging` | Carregar dados staging (usa cache) |
| `POST /api/admin/refresh-staging` | Deletar cache e re-baixar todos os dados |
| `POST /api/admin/check-updates` | Verificar novos dados SSP |
| `POST /api/admin/ingest-rs-history` | Importar historico RS 2022-2026 |
| `POST /api/admin/geocode-bairros` | Geocodificar bairros |
| `GET /api/admin/staging-stats` | Estatisticas do staging |
| `GET /api/admin/state-data-quality` | Diagnostico de qualidade |

## Tecnologias

- **Backend**: FastAPI, SQLAlchemy, SQLite, APScheduler, Pandas
- **Frontend**: Next.js 14, Leaflet, Tailwind CSS
- **Infra**: Docker Compose
