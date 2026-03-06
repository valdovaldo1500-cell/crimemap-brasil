# Changelog

## 2026-03-05
### Novidades
- Scheduler automatico para atualizar dados de todos os estados semanalmente
- Popup "Fontes" com URLs, contagem de registros e data de atualizacao
- Popup "Novidades" com historico de mudancas
- Popup "Como usar" com manual do usuario
- Endpoint `GET /api/data-sources` com metadados das fontes
- Endpoint `POST /api/admin/refresh-staging` para re-download forcado
- Documentacao do projeto (CLAUDE.md, README.md atualizado)

### Correcoes
- Range de anos do SINESP VDE agora e dinamico (nao para em 2026)

## 2026-03-01
### Novidades
- Suporte multi-estado: RS, RJ, MG + todos os 27 estados via SINESP
- Pipeline de staging data com 6 fontes de dados
- Categorias de crime cross-state com filtro automatico para MG
- Dados por bairro para RS com GeoJSON de fronteiras
- Visualizacao por estado (zoom < 7)
- Modo taxa (/100K hab.) com dados populacionais
- Modo regioes (coropleto) para municipios e estados
- Filtros cascata: tipo, grupo, sexo, cor, idade
- Selecao de estados com aviso de dados parciais (MG)
- Granularidade: ano/semestre com gating para dados SINESP (anual apenas)

## 2026-02-15
### Novidades
- Sistema de geocodificacao com cache para bairros
- GeoJSON de municipios para RS, RJ, MG
- GeoJSON de bairros para RS
- Busca por cidade ou bairro com autocomplete
- Sistema de report de bugs com captcha

## 2026-02-01
### Novidades
- Versao inicial: mapa de crimes do RS
- Dados da SSP/RS (Lei 15.610/2021)
- Heatmap por municipio e bairro
- Filtros por tipo de crime e periodo
- Docker Compose para deploy
