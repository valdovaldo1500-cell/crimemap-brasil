#!/usr/bin/env python3
"""
Crime Brasil QA Accuracy Test
Compares API output against original source CSVs/ZIPs.
Tests RS (ZIPs), RJ (CISP CSV), MG (violent CSVs).
Exit code 0 if all pass, 1 if any fail.
"""

import csv
import io
import os
import re
import sys
import time
import zipfile
from pathlib import Path

import requests

BASE_URL = "https://crimebrasil.com.br"
DATA_DIR = Path("/home/valdo/crime-map/backend/data")
STAGING_DIR = DATA_DIR / "staging"

PASSES = 0
FAILS = 0
WARNS = 0

PERF_MS = {"state": 2000, "city": 1500, "bairro": 2000, "filter": 1000}

# RJ 42 individual crime columns (excludes composites)
RJ_CRIME_COLS = [
    'hom_doloso', 'lesao_corp_morte', 'latrocinio', 'hom_por_interv_policial', 'feminicidio',
    'tentat_hom', 'tentativa_feminicidio', 'lesao_corp_dolosa', 'estupro',
    'roubo_transeunte', 'roubo_celular', 'roubo_em_coletivo', 'roubo_rua', 'roubo_veiculo',
    'roubo_carga', 'roubo_comercio', 'roubo_residencia', 'roubo_banco', 'roubo_cx_eletronico',
    'roubo_conducao_saque', 'roubo_apos_saque', 'roubo_bicicleta', 'outros_roubos',
    'furto_veiculos', 'furto_transeunte', 'furto_coletivo', 'furto_celular', 'furto_bicicleta',
    'outros_furtos', 'sequestro', 'extorsao', 'sequestro_relampago', 'estelionato',
    'apreensao_drogas', 'posse_drogas', 'trafico_drogas', 'apreensao_drogas_sem_autor',
    'recuperacao_veiculos', 'apf', 'aaapai', 'cmp', 'cmba',
]


def api_get(path, params=None, timeout=15, retries=4):
    url = f"{BASE_URL}{path}"
    for attempt in range(retries + 1):
        try:
            t0 = time.time()
            r = requests.get(url, params=params, timeout=timeout)
            ms = (time.time() - t0) * 1000
            if r.status_code == 429:
                wait = 15 * (attempt + 1)
                print(f"  [429 rate limit] waiting {wait}s...")
                time.sleep(wait)
                continue
            r.raise_for_status()
            return r.json(), ms
        except requests.exceptions.HTTPError:
            raise RuntimeError(f"HTTP {r.status_code} on {path} {params}")
        except Exception as e:
            if attempt == retries:
                raise RuntimeError(f"API error {path} {params}: {e}")
            time.sleep(5)


def check(label, src, api, ms, perf_key="city", tol=0.0):
    global PASSES, FAILS, WARNS
    diff = abs(src - api)
    ok = diff <= max(1, int(src * tol)) if tol > 0 else (diff == 0)
    perf_ok = ms <= PERF_MS[perf_key]
    status = "PASS" if ok else "FAIL"
    extras = []
    if not ok:
        pct = (diff / src * 100) if src > 0 else 0
        extras.append(f"diff={diff:,} ({pct:.1f}%)")
    if not perf_ok:
        extras.append(f"SLOW:{ms:.0f}ms")
        WARNS += 1
    extra_str = f" [{', '.join(extras)}]" if extras else ""
    print(f"  [{status}] {label}: src={src:,} api={api:,} ({ms:.0f}ms){extra_str}")
    if ok:
        PASSES += 1
    else:
        FAILS += 1
    time.sleep(1.5)


# ──────────────────────────────────────────────────────────────
# Source data loaders
# ──────────────────────────────────────────────────────────────

def get_zip_year(name):
    # Try "jan-YYYY" or "jan-dez-YYYY" pattern first
    m = re.search(r'jan(?:eiro)?(?:-a-dezembro|-dez)?[- ](\d{4})', name, re.I)
    if m:
        return int(m.group(1))
    m = re.search(r'-(\d{4})-de-janeiro', name, re.I)
    if m:
        return int(m.group(1))
    # Fall back to first year in 2022-2026 range found in name
    years = [int(y) for y in re.findall(r'\b(20[2-6]\d)\b', name)]
    years = [y for y in years if 2022 <= y <= 2026]
    return years[0] if years else None


def load_rs_data():
    print("\n[RS] Loading ZIP data...")
    mun_counts = {}      # year -> {mun_upper: count}
    bairro_counts = {}   # year -> {mun_upper: {bairro_upper: count}}

    for zpath in sorted(DATA_DIR.glob("*.zip")):
        year = get_zip_year(zpath.name)
        if year is None:
            print(f"  WARN: could not detect year for {zpath.name}")
            continue
        print(f"  {zpath.name} → year {year}")
        try:
            with zipfile.ZipFile(zpath) as zf:
                csvs = [n for n in zf.namelist() if n.lower().endswith('.csv')]
                if not csvs:
                    continue
                for csv_name in csvs:
                    with zf.open(csv_name) as f:
                        reader = csv.reader(
                            io.TextIOWrapper(f, encoding='utf-8', errors='replace'),
                            delimiter=';'
                        )
                        header = next(reader)
                        col_map = {h.strip(): i for i, h in enumerate(header)}
                        mun_col = next((col_map[k] for k in ['Municipio Fato', 'municipio_fato', 'MUNICIPIO FATO'] if k in col_map), None)
                        bairro_col = next((col_map[k] for k in ['Bairro', 'bairro', 'BAIRRO'] if k in col_map), None)
                        if mun_col is None:
                            print(f"  WARN: no municipio col in {csv_name}, header={header[:5]}")
                            continue
                        yd = mun_counts.setdefault(year, {})
                        yb = bairro_counts.setdefault(year, {})
                        for row in reader:
                            if len(row) <= mun_col:
                                continue
                            mun = row[mun_col].strip().upper()
                            if not mun:
                                continue
                            yd[mun] = yd.get(mun, 0) + 1
                            if bairro_col and len(row) > bairro_col:
                                bairro = row[bairro_col].strip().upper()
                                if bairro:
                                    bd = yb.setdefault(mun, {})
                                    bd[bairro] = bd.get(bairro, 0) + 1
        except Exception as e:
            print(f"  ERROR loading {zpath.name}: {e}")

    for year, yd in mun_counts.items():
        total = sum(yd.values())
        print(f"  RS {year}: {total:,} records, {len(yd)} municipalities")
    return mun_counts, bairro_counts


def load_rj_data():
    print("\n[RJ] Loading CISP CSV...")
    rj = {}   # year -> {munic_upper: count}
    p = STAGING_DIR / "rj_isp_cisp.csv"
    if not p.exists():
        print(f"  ERROR: {p} not found")
        return rj
    with open(p, encoding='utf-8', errors='replace') as f:
        reader = csv.reader(f, delimiter=';')
        header = next(reader)
        col_map = {h.strip(): i for i, h in enumerate(header)}
        ano_col = col_map.get('ano')
        munic_col = col_map.get('munic')
        if ano_col is None or munic_col is None:
            print(f"  ERROR: missing ano/munic cols. Found: {list(col_map.keys())[:10]}")
            return rj
        crime_cols = [col_map[c] for c in RJ_CRIME_COLS if c in col_map]
        missing = [c for c in RJ_CRIME_COLS if c not in col_map]
        if missing:
            print(f"  WARN: missing crime cols: {missing}")
        for row in reader:
            try:
                year = int(row[ano_col])
            except (ValueError, IndexError):
                continue
            munic = row[munic_col].strip().upper() if munic_col < len(row) else ''
            if not munic:
                continue
            cnt = sum(int(row[ci] or 0) for ci in crime_cols if ci < len(row) and row[ci].strip().lstrip('-').isdigit())
            yd = rj.setdefault(year, {})
            yd[munic] = yd.get(munic, 0) + cnt
    for year, yd in sorted(rj.items()):
        if 2019 <= year <= 2024:
            print(f"  RJ {year}: {sum(yd.values()):,} occurrences, {len(yd)} municipalities")
    return rj


def load_mg_data():
    print("\n[MG] Loading violent CSVs...")
    mg = {}  # year -> {mun_upper: count}
    for p in sorted(STAGING_DIR.glob("mg_violent_*.csv")):
        with open(p, encoding='utf-8', errors='replace') as f:
            reader = csv.reader(f, delimiter=';')
            header = [h.lstrip('\ufeff').strip() for h in next(reader)]
            col_map = {h: i for i, h in enumerate(header)}
            reg_col = col_map.get('registros')
            mun_col = col_map.get('municipio')
            ano_col = col_map.get('ano')
            if any(c is None for c in [reg_col, mun_col, ano_col]):
                print(f"  WARN: missing cols in {p.name}: {header}")
                continue
            for row in reader:
                try:
                    year = int(row[ano_col])
                    cnt = int(row[reg_col] or 0)
                except (ValueError, IndexError):
                    continue
                mun = row[mun_col].strip().upper() if mun_col < len(row) else ''
                if not mun:
                    continue
                yd = mg.setdefault(year, {})
                yd[mun] = yd.get(mun, 0) + cnt
    for year, yd in sorted(mg.items()):
        if 2019 <= year <= 2024:
            print(f"  MG {year}: {sum(yd.values()):,} occurrences, {len(yd)} municipalities")
    return mg


# ──────────────────────────────────────────────────────────────
# API helpers
# ──────────────────────────────────────────────────────────────

def state_total_from_api(state, year):
    data, ms = api_get("/api/state-stats", {"state": state, "ano": year})
    return data.get("total", 0), ms


def city_total_from_api(municipio, state, year):
    data, ms = api_get("/api/location-stats", {"municipio": municipio, "state": state, "ano": year})
    return data.get("total", 0), ms


def bairro_total_from_api(municipio, bairro, state, year):
    data, ms = api_get("/api/location-stats", {"municipio": municipio, "bairro": bairro, "state": state, "ano": year})
    return data.get("total", 0), ms


def normalize_api_name(name_upper):
    """Convert uppercase source name to title-case API name with Portuguese accents."""
    # Basic title case
    s = name_upper.title()
    # Fix common prepositions
    for prep in ['Do', 'Da', 'De', 'Dos', 'Das', 'E', 'Em']:
        s = re.sub(r'\b' + prep + r'\b', prep.lower(), s)
    # Re-capitalize first word
    s = s[0].upper() + s[1:] if s else s
    # Portuguese diacritical fixes (common city names)
    replacements = {
        'Sao ': 'São ', 'Goncalo': 'Gonçalo', 'Niteroi': 'Niterói',
        'Iguacu': 'Iguaçu', 'Uberlandia': 'Uberlândia', 'Juiz de Fora': 'Juiz de Fora',
    }
    for k, v in replacements.items():
        s = s.replace(k, v)
    return s


# ──────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("Crime Brasil QA Accuracy Test")
    print(f"Target: {BASE_URL}")
    print("=" * 60)

    # Verify API is reachable
    try:
        r = requests.get(f"{BASE_URL}/api/stats", timeout=10)
        r.raise_for_status()
        print("API reachable ✓")
    except Exception as e:
        print(f"ERROR: API not reachable: {e}")
        sys.exit(2)

    rs_mun, rs_bairro = load_rs_data()
    rj_data = load_rj_data()
    mg_data = load_mg_data()

    # ──────────────────────────────────────────────────────────
    # RS Tests
    # ──────────────────────────────────────────────────────────
    print("\n" + "=" * 40)
    print("RS TESTS")
    print("=" * 40)

    RS_CITIES = ['PORTO ALEGRE', 'CANOAS', 'CAXIAS DO SUL', 'SANTA MARIA', 'PELOTAS']
    RS_YEARS = [y for y in [2022, 2023, 2024] if y in rs_mun]

    for year in RS_YEARS:
        src_total = sum(rs_mun[year].values())
        api_total, ms = state_total_from_api('RS', year)
        check(f"RS state {year}", src_total, api_total, ms, "state", tol=0.01)

        for city in RS_CITIES:
            src = rs_mun[year].get(city, 0)
            if src == 0:
                print(f"  [SKIP] RS {city} {year}: no source data")
                continue
            api_city = normalize_api_name(city)
            api_val, ms = city_total_from_api(api_city, 'RS', year)
            check(f"RS {api_city} {year}", src, api_val, ms, "city", tol=0.02)

    # RS Bairro tests (Porto Alegre top 50)
    print(f"\n[RS Bairros - Porto Alegre]")
    bairro_year = max((y for y in RS_YEARS if y in rs_bairro), default=None)
    if bairro_year:
        poa_bairros = rs_bairro.get(bairro_year, {}).get('PORTO ALEGRE', {})
        top50 = sorted(poa_bairros.items(), key=lambda x: -x[1])[:50]
        tested = 0
        for bairro_upper, src in top50:
            if src < 10:
                continue
            api_bairro = normalize_api_name(bairro_upper)
            api_val, ms = bairro_total_from_api('Porto Alegre', api_bairro, 'RS', bairro_year)
            check(f"RS POA/{api_bairro} {bairro_year}", src, api_val, ms, "bairro", tol=0.02)
            tested += 1
        print(f"  Tested {tested} bairros")
    else:
        print("  SKIP: no RS bairro data available")

    # ──────────────────────────────────────────────────────────
    # RJ Tests
    # ──────────────────────────────────────────────────────────
    print("\n" + "=" * 40)
    print("RJ TESTS")
    print("=" * 40)

    RJ_CITIES_UPPER = ['RIO DE JANEIRO', 'SAO GONCALO', 'DUQUE DE CAXIAS', 'NOVA IGUACU', 'NITEROI']
    RJ_YEARS = [y for y in [2019, 2021, 2023] if y in rj_data]

    for year in RJ_YEARS:
        src_total = sum(rj_data[year].values())
        api_total, ms = state_total_from_api('RJ', year)
        check(f"RJ state {year}", src_total, api_total, ms, "state")

        for city_up in RJ_CITIES_UPPER:
            # Try with and without accents
            src = rj_data[year].get(city_up, 0)
            if src == 0:
                # Try variations
                for key in rj_data[year]:
                    import unicodedata
                    def no_accent(s):
                        return unicodedata.normalize('NFD', s).encode('ascii', 'ignore').decode()
                    if no_accent(key) == no_accent(city_up):
                        src = rj_data[year][key]
                        break
            if src == 0:
                print(f"  [SKIP] RJ {city_up} {year}: no source data")
                continue
            api_city = normalize_api_name(city_up)
            api_val, ms = city_total_from_api(api_city, 'RJ', year)
            check(f"RJ {api_city} {year}", src, api_val, ms, "city")

    # ──────────────────────────────────────────────────────────
    # MG Tests
    # ──────────────────────────────────────────────────────────
    print("\n" + "=" * 40)
    print("MG TESTS")
    print("=" * 40)

    MG_CITIES_UPPER = ['BELO HORIZONTE', 'UBERLÂNDIA', 'CONTAGEM', 'JUIZ DE FORA', 'BETIM']
    MG_YEARS = [y for y in [2020, 2022, 2023] if y in mg_data]

    for year in MG_YEARS:
        src_total = sum(mg_data[year].values())
        api_total, ms = state_total_from_api('MG', year)
        check(f"MG state {year}", src_total, api_total, ms, "state")

        for city_up in MG_CITIES_UPPER:
            src = mg_data[year].get(city_up, 0)
            if src == 0:
                print(f"  [SKIP] MG {city_up} {year}: no source data")
                continue
            api_city = normalize_api_name(city_up)
            api_val, ms = city_total_from_api(api_city, 'MG', year)
            check(f"MG {api_city} {year}", src, api_val, ms, "city")

    # ──────────────────────────────────────────────────────────
    # Summary
    # ──────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print(f"RESULTS: {PASSES} PASS | {FAILS} FAIL | {WARNS} PERF WARN")
    print("=" * 60)
    sys.exit(0 if FAILS == 0 else 1)


if __name__ == "__main__":
    main()
