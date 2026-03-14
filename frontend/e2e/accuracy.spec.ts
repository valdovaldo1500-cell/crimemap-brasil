import { test, expect } from '@playwright/test';

const BASE_API = process.env.BASE_API ?? 'https://crimebrasil.com.br';

async function waitForMapReady(page: import('@playwright/test').Page) {
  await page.waitForSelector('.leaflet-tile-loaded', { timeout: 30_000 });
  await page.waitForFunction(() => {
    return document.body.textContent?.includes('Ocorrências');
  }, { timeout: 30_000 });
}

async function openSidebarAndWait(page: import('@playwright/test').Page) {
  await page.locator('button', { hasText: /Filtros/i }).first().click();
  await page.locator('aside').waitFor({ state: 'visible', timeout: 60_000 });
  await page.locator('aside h3').filter({ hasText: 'Tipo de Crime' }).locator('xpath=..').locator('label').first().waitFor({ state: 'attached', timeout: 60_000 });
}

// ============================================================
// Group: DetailPanel count accuracy
// ============================================================

test('Accuracy: heatmap bairros has nonzero weight for POA', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/heatmap/bairros?municipio=PORTO+ALEGRE&selected_states=RS&ultimos_meses=12`, { timeout: 60_000 });
  expect(resp.ok()).toBeTruthy();
  const data = await resp.json();
  expect(data.length).toBeGreaterThan(0);

  const totalWeight = data.reduce((sum: number, p: { weight: number }) => sum + p.weight, 0);
  expect(totalWeight).toBeGreaterThan(0);
});

test('Accuracy: no duplicate component names in POA bairros', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/heatmap/bairros?municipio=PORTO+ALEGRE&selected_states=RS&ultimos_meses=12`, { timeout: 60_000 });
  expect(resp.ok()).toBeTruthy();
  const data = await resp.json();
  expect(data.length).toBeGreaterThan(0);

  for (const point of data) {
    const components: Array<{ name: string; weight: number }> = point.components || [];
    if (components.length <= 1) continue;
    // Filter empty names — they may be legitimate placeholders for unknown bairros
    const names = components.map((c) => c.name).filter((n) => n && n.length > 0);
    if (names.length <= 1) continue;
    const uniqueNames = [...new Set(names)];
    expect(names.length).toBe(uniqueNames.length,
      `Duplicate component names in bairro "${point.bairro}": ${JSON.stringify(names)}`
    );
  }
});

test('Accuracy: location-stats total matches heatmap weight for POA bairros', async ({ request }) => {
  const heatResp = await request.get(`${BASE_API}/api/heatmap/bairros?municipio=PORTO+ALEGRE&selected_states=RS&ultimos_meses=12`, { timeout: 60_000 });
  expect(heatResp.ok()).toBeTruthy();
  const heatData = await heatResp.json();
  expect(heatData.length).toBeGreaterThan(0);

  // Check first 5 non-merged bairros
  const simpleBairros = heatData.filter((p: { bairro: string }) => p.bairro && !p.bairro.includes('+') && p.bairro !== 'Bairro desconhecido');
  const sample = simpleBairros.slice(0, 5);

  for (const point of sample) {
    const bairro: string = point.bairro;
    const heatWeight: number = point.weight;
    const rawNames: string[] = point.raw_bairro_names || [];

    const extraParam = rawNames.length ? `&extra_bairros=${encodeURIComponent(rawNames.join(','))}` : '';
    const statsResp = await request.get(
      `${BASE_API}/api/location-stats?municipio=PORTO+ALEGRE&state=RS&bairro=${encodeURIComponent(bairro)}&ultimos_meses=12${extraParam}`,
      { timeout: 30_000 }
    );
    if (!statsResp.ok()) continue;
    const statsData = await statsResp.json();
    const statsTotal: number = statsData.total || 0;

    if (heatWeight === 0 && statsTotal === 0) continue;
    const diff = Math.abs(heatWeight - statsTotal) / Math.max(heatWeight, statsTotal);
    expect(diff).toBeLessThan(0.10,
      `Parity mismatch for "${bairro}": heatmap=${heatWeight} stats=${statsTotal} diff=${(diff * 100).toFixed(1)}%`
    );
  }
});

test('Accuracy: location-stats total >= type breakdown sum', async ({ request }) => {
  const cities = [
    { municipio: 'PORTO ALEGRE', state: 'RS' },
    { municipio: 'CANOAS', state: 'RS' },
    { municipio: 'RIO DE JANEIRO', state: 'RJ' },
  ];

  for (const { municipio, state } of cities) {
    const resp = await request.get(
      `${BASE_API}/api/location-stats?municipio=${encodeURIComponent(municipio)}&state=${state}&ultimos_meses=12`,
      { timeout: 30_000 }
    );
    if (!resp.ok()) continue;
    const d = await resp.json();
    const total: number = d.total || 0;
    const breakdownSum: number = (d.crime_types || []).reduce((s: number, ct: { count: number }) => s + ct.count, 0);

    if (total === 0 && breakdownSum === 0) continue;
    expect(total).toBeGreaterThanOrEqual(breakdownSum,
      `${state}/${municipio}: total=${total} < breakdown_sum=${breakdownSum}`
    );
  }
});

// ============================================================
// Group: Rate calculation accuracy
// ============================================================

test('Accuracy: rate math consistent with total/population for Porto Alegre', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/location-stats?municipio=PORTO+ALEGRE&state=RS&ultimos_meses=12`, { timeout: 30_000 });
  expect(resp.ok()).toBeTruthy();
  const d = await resp.json();

  if (!d.total || !d.population || d.rate === null || d.rate === undefined) return;

  const expectedRate = (d.total / d.population) * 100_000;
  expect(Math.abs(d.rate - expectedRate)).toBeLessThan(1.0,
    `POA rate=${d.rate.toFixed(2)} expected=${expectedRate.toFixed(2)}`
  );
});

test('Accuracy: rate is never NaN or Infinity', async ({ request }) => {
  const locations = [
    'municipio=PORTO+ALEGRE&state=RS',
    'municipio=CANOAS&state=RS',
    'municipio=RIO+DE+JANEIRO&state=RJ',
    'municipio=BELO+HORIZONTE&state=MG',
  ];

  for (const loc of locations) {
    const resp = await request.get(`${BASE_API}/api/location-stats?${loc}&ultimos_meses=12`, { timeout: 30_000 });
    if (!resp.ok()) continue;
    const d = await resp.json();
    if (d.rate === null || d.rate === undefined) continue;
    expect(Number.isFinite(d.rate)).toBe(true, `rate=${d.rate} is NaN or Infinity for ${loc}`);
  }
});

test('Accuracy: population_source field present in location-stats', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/location-stats?municipio=PORTO+ALEGRE&state=RS&ultimos_meses=12`, { timeout: 30_000 });
  expect(resp.ok()).toBeTruthy();
  const d = await resp.json();
  expect(d).toHaveProperty('population_source');
  expect(['bairro', 'municipio', null]).toContain(d.population_source);
});

// ============================================================
// Group: Filter → map consistency
// ============================================================

test('Accuracy: filter-options returns tipo list for RS', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/filter-options?selected_states=RS&ultimos_meses=12`);
  expect(resp.ok()).toBeTruthy();
  const d = await resp.json();
  expect(Array.isArray(d.tipo)).toBe(true);
  expect(d.tipo.length).toBeGreaterThan(5);
});

test('Accuracy: 12m filter-options has >= types than 3m', async ({ request }) => {
  const resp3 = await request.get(`${BASE_API}/api/filter-options?selected_states=RS&ultimos_meses=3`);
  const resp12 = await request.get(`${BASE_API}/api/filter-options?selected_states=RS&ultimos_meses=12`);
  expect(resp3.ok()).toBeTruthy();
  expect(resp12.ok()).toBeTruthy();

  const tipos3 = (await resp3.json()).tipo || [];
  const tipos12 = (await resp12.json()).tipo || [];
  expect(tipos12.length).toBeGreaterThanOrEqual(tipos3.length);
});

test('Accuracy: RS+MG filter-options has fewer tipos than RS alone', async ({ request }) => {
  const respRS = await request.get(`${BASE_API}/api/filter-options?selected_states=RS`);
  const respMGRS = await request.get(`${BASE_API}/api/filter-options?selected_states=RS%2CMG`);
  expect(respRS.ok()).toBeTruthy();
  expect(respMGRS.ok()).toBeTruthy();

  const rsTipos = (await respRS.json()).tipo || [];
  const mgRsTipos = (await respMGRS.json()).tipo || [];
  expect(mgRsTipos.length).toBeLessThan(rsTipos.length);
  expect(mgRsTipos.length).toBeGreaterThan(0);
});

test('Accuracy: MG alone shows violent crime types', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/filter-options?selected_states=MG`);
  expect(resp.ok()).toBeTruthy();
  const d = await resp.json();
  const tipos: string[] = (d.tipo || []).map((t: { value?: string } | string) =>
    typeof t === 'string' ? t.toUpperCase() : (t.value || '').toUpperCase()
  );
  const hasViolent = tipos.some(t => t.includes('HOMICIDIO') || t.includes('HOMICÍDIO') || t.includes('ROUBO') || t.includes('ESTUPRO'));
  expect(hasViolent).toBe(true, `MG filter-options missing violent crime types. Got: ${tipos.slice(0, 10)}`);
});

// ============================================================
// Group: Geographic accuracy
// ============================================================

test('Accuracy: no PANTANO bairros in Porto Alegre heatmap', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/heatmap/bairros?municipio=PORTO+ALEGRE&selected_states=RS&ultimos_meses=12`, { timeout: 60_000 });
  expect(resp.ok()).toBeTruthy();
  const data = await resp.json();

  const pantano = data.filter((p: { bairro: string }) => p.bairro?.toUpperCase().startsWith('PANTANO'));
  expect(pantano).toHaveLength(0);
});

test('Accuracy: Bairro desconhecido fraction < 30% of POA weight', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/heatmap/bairros?municipio=PORTO+ALEGRE&selected_states=RS&ultimos_meses=12`, { timeout: 60_000 });
  expect(resp.ok()).toBeTruthy();
  const data = await resp.json();
  if (data.length === 0) return;

  const totalWeight: number = data.reduce((s: number, p: { weight: number }) => s + p.weight, 0);
  const unknownWeight: number = data
    .filter((p: { bairro: string }) => !p.bairro || p.bairro === 'Bairro desconhecido' || p.bairro === '-')
    .reduce((s: number, p: { weight: number }) => s + p.weight, 0);

  if (totalWeight === 0) return;
  const fraction = unknownWeight / totalWeight;
  expect(fraction).toBeLessThan(0.30,
    `"Bairro desconhecido" is ${(fraction * 100).toFixed(1)}% of POA weight (threshold: 30%)`
  );
});

test('Accuracy: no street names appearing as bairros in POA', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/heatmap/bairros?municipio=PORTO+ALEGRE&selected_states=RS&ultimos_meses=12`, { timeout: 60_000 });
  expect(resp.ok()).toBeTruthy();
  const data = await resp.json();

  const streetPrefixes = ['RUA ', 'AV ', 'AVENIDA ', 'ESTRADA ', 'TRAVESSA ', 'RODOVIA '];
  const streetBairros = data.filter((p: { bairro: string }) => {
    const b = (p.bairro || '').toUpperCase();
    return streetPrefixes.some(pfx => b.startsWith(pfx));
  });
  expect(streetBairros).toHaveLength(0);
});

test('Accuracy: no duplicate municipality dots in RS heatmap', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/heatmap/municipios?selected_states=RS&ultimos_meses=12`, { timeout: 60_000 });
  expect(resp.ok()).toBeTruthy();
  const data = await resp.json();
  if (data.length === 0) return;

  // Normalize: strip accents + uppercase
  function normMun(s: string): string {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
  }

  const seen = new Map<string, string[]>();
  for (const point of data) {
    const mun: string = point.municipio || '';
    if (!mun || mun === '-') continue;
    const norm = normMun(mun);
    if (!seen.has(norm)) seen.set(norm, []);
    seen.get(norm)!.push(mun);
  }

  const duplicates = [...seen.entries()].filter(([, v]) => v.length > 1);
  expect(duplicates).toHaveLength(0);
});

// ============================================================
// Group: API contract
// ============================================================

test('Accuracy: state-stats total >= breakdown sum for RS', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/state-stats?state=RS&ultimos_meses=12`, { timeout: 30_000 });
  expect(resp.ok()).toBeTruthy();
  const d = await resp.json();
  const total: number = d.total || 0;
  const breakdownSum: number = (d.crime_types || []).reduce((s: number, ct: { count: number }) => s + ct.count, 0);
  if (total === 0 && breakdownSum === 0) return;
  expect(total).toBeGreaterThanOrEqual(breakdownSum);
});

test('Accuracy: state-stats total >= breakdown sum for RJ', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/state-stats?state=RJ&ultimos_meses=12`, { timeout: 30_000 });
  expect(resp.ok()).toBeTruthy();
  const d = await resp.json();
  const total: number = d.total || 0;
  const breakdownSum: number = (d.crime_types || []).reduce((s: number, ct: { count: number }) => s + ct.count, 0);
  if (total === 0 && breakdownSum === 0) return;
  expect(total).toBeGreaterThanOrEqual(breakdownSum);
});

test('Accuracy: heatmap municipios weight > 0 for all RS points', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/heatmap/municipios?selected_states=RS&ultimos_meses=12`, { timeout: 60_000 });
  expect(resp.ok()).toBeTruthy();
  const data = await resp.json();
  const zeroWeight = data.filter((p: { weight: number }) => p.weight <= 0);
  expect(zeroWeight).toHaveLength(0);
});
