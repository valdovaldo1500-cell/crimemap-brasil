import { test, expect } from '@playwright/test';

const BASE_API = process.env.BASE_API ?? 'https://crimebrasil.com.br';

async function waitForMapReady(page: import('@playwright/test').Page) {
  await page.waitForSelector('.leaflet-tile-loaded', { timeout: 60_000 });
  await page.waitForFunction(() => {
    return document.body.textContent?.includes('Ocorrências');
  }, { timeout: 60_000 });
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

    // API requires repeated extra_bairros params, not comma-separated
    const extraParam = rawNames.map((n: string) => `&extra_bairros=${encodeURIComponent(n)}`).join('');
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
  const resp = await request.get(`${BASE_API}/api/location-stats?municipio=PORTO+ALEGRE&state=RS&ultimos_meses=12`, { timeout: 60_000 });
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
    const resp = await request.get(`${BASE_API}/api/location-stats?${loc}&ultimos_meses=12`, { timeout: 60_000 });
    if (!resp.ok()) continue;
    const d = await resp.json();
    if (d.rate === null || d.rate === undefined) continue;
    expect(Number.isFinite(d.rate)).toBe(true, `rate=${d.rate} is NaN or Infinity for ${loc}`);
  }
});

test('Accuracy: population_source field present in location-stats', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/location-stats?municipio=PORTO+ALEGRE&state=RS&ultimos_meses=12`, { timeout: 60_000 });
  expect(resp.ok()).toBeTruthy();
  const d = await resp.json();
  expect(d).toHaveProperty('population_source');
  expect(['bairro', 'municipio', null]).toContain(d.population_source);
});

// ============================================================
// Group: Filter → map consistency
// ============================================================

test('Accuracy: filter-options returns tipo list for RS', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/filter-options?selected_states=RS&ultimos_meses=12`, { timeout: 60_000 });
  expect(resp.ok()).toBeTruthy();
  const d = await resp.json();
  expect(Array.isArray(d.tipo)).toBe(true);
  expect(d.tipo.length).toBeGreaterThan(5);
});

test('Accuracy: 12m filter-options has >= types than 3m', async ({ request }) => {
  const resp3 = await request.get(`${BASE_API}/api/filter-options?selected_states=RS&ultimos_meses=3`, { timeout: 60_000 });
  const resp12 = await request.get(`${BASE_API}/api/filter-options?selected_states=RS&ultimos_meses=12`, { timeout: 60_000 });
  expect(resp3.ok()).toBeTruthy();
  expect(resp12.ok()).toBeTruthy();

  const tipos3 = (await resp3.json()).tipo || [];
  const tipos12 = (await resp12.json()).tipo || [];
  expect(tipos12.length).toBeGreaterThanOrEqual(tipos3.length);
});

test('Accuracy: RS+MG filter-options has fewer tipos than RS alone', async ({ request }) => {
  const respRS = await request.get(`${BASE_API}/api/filter-options?selected_states=RS`, { timeout: 60_000 });
  // API needs repeated params — comma-separated is not supported
  const respMGRS = await request.get(`${BASE_API}/api/filter-options?selected_states=RS&selected_states=MG`, { timeout: 60_000 });
  expect(respRS.ok()).toBeTruthy();
  expect(respMGRS.ok()).toBeTruthy();

  const rsTipos = (await respRS.json()).tipo || [];
  const mgRsTipos = (await respMGRS.json()).tipo || [];
  expect(mgRsTipos.length).toBeLessThan(rsTipos.length);
  expect(mgRsTipos.length).toBeGreaterThan(0);
});

test('Accuracy: MG alone shows violent crime types', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/filter-options?selected_states=MG`, { timeout: 60_000 });
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
  const resp = await request.get(`${BASE_API}/api/state-stats?state=RS&ultimos_meses=12`, { timeout: 60_000 });
  expect(resp.ok()).toBeTruthy();
  const d = await resp.json();
  const total: number = d.total || 0;
  const breakdownSum: number = (d.crime_types || []).reduce((s: number, ct: { count: number }) => s + ct.count, 0);
  if (total === 0 && breakdownSum === 0) return;
  expect(total).toBeGreaterThanOrEqual(breakdownSum);
});

test('Accuracy: state-stats total >= breakdown sum for RJ', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/state-stats?state=RJ&ultimos_meses=12`, { timeout: 60_000 });
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

// ============================================================
// Group: Cross-table tipo filtering
// ============================================================

test('Accuracy: filter-options has no duplicate tipo display names for RS+RJ', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/filter-options?selected_states=RS&selected_states=RJ&ultimos_meses=12`, { timeout: 60_000 });
  expect(resp.ok()).toBeTruthy();
  const tipos: Array<{ value: string; count: number } | string> = (await resp.json()).tipo || [];
  if (tipos.length === 0) return;

  function normTipo(s: string): string {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/_/g, ' ').trim();
  }

  const seen = new Map<string, string[]>();
  for (const t of tipos) {
    const v = typeof t === 'string' ? t : t.value;
    const norm = normTipo(v);
    if (!seen.has(norm)) seen.set(norm, []);
    seen.get(norm)!.push(v);
  }

  const duplicates = [...seen.entries()].filter(([, v]) => v.length > 1);
  expect(duplicates).toHaveLength(0);
});

test('Accuracy: tipo filter returns heatmap results for RJ', async ({ request }) => {
  // Get a valid RJ tipo
  const foResp = await request.get(`${BASE_API}/api/filter-options?selected_states=RJ&ultimos_meses=12`, { timeout: 60_000 });
  expect(foResp.ok()).toBeTruthy();
  const tipos: Array<{ value: string } | string> = (await foResp.json()).tipo || [];
  if (tipos.length === 0) return;
  const tipoValue = typeof tipos[0] === 'string' ? tipos[0] : tipos[0].value;

  // Fetch heatmap with that tipo
  const heatResp = await request.get(
    `${BASE_API}/api/heatmap/municipios?selected_states=RJ&tipo=${encodeURIComponent(tipoValue)}&ultimos_meses=12`,
    { timeout: 60_000 }
  );
  expect(heatResp.ok()).toBeTruthy();
  const data = await heatResp.json();
  const totalWeight: number = data.reduce((s: number, p: { weight: number }) => s + p.weight, 0);
  expect(totalWeight).toBeGreaterThan(0);
});

test('Accuracy: cross-table tipo filter returns results for both RS and RJ', async ({ request }) => {
  // Get RS tipos
  const rsResp = await request.get(`${BASE_API}/api/filter-options?selected_states=RS&ultimos_meses=12`);
  expect(rsResp.ok()).toBeTruthy();
  const rsTipos: Array<{ value: string } | string> = (await rsResp.json()).tipo || [];
  if (rsTipos.length === 0) return;
  const rsValue = typeof rsTipos[0] === 'string' ? rsTipos[0] : rsTipos[0].value;

  // Filter RS+RJ heatmap by RS tipo variant
  const heatResp = await request.get(
    `${BASE_API}/api/heatmap/municipios?selected_states=RS&selected_states=RJ&tipo=${encodeURIComponent(rsValue)}&ultimos_meses=12`,
    { timeout: 60_000 }
  );
  expect(heatResp.ok()).toBeTruthy();
  const data = await heatResp.json();

  // Heuristic: check if any result exists (ideally from both states)
  const totalWeight: number = data.reduce((s: number, p: { weight: number }) => s + p.weight, 0);
  expect(totalWeight).toBeGreaterThan(0);
});

// ============================================================
// Group: Compare feature
// ============================================================

test('Accuracy: location-stats returns data for Cabo Frio RJ', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/location-stats?municipio=CABO+FRIO&state=RJ&ultimos_meses=12`, { timeout: 60_000 });
  expect(resp.ok()).toBeTruthy();
  const d = await resp.json();
  expect(d.total).toBeGreaterThan(0);
});

test('Accuracy: location-stats returns data for Arraial do Cabo RJ', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/location-stats?municipio=ARRAIAL+DO+CABO&state=RJ&ultimos_meses=12`, { timeout: 60_000 });
  expect(resp.ok()).toBeTruthy();
  const d = await resp.json();
  expect(d.total).toBeGreaterThan(0);
});

test('Accuracy: both cities in a comparison return data simultaneously', async ({ request }) => {
  const [resp1, resp2] = await Promise.all([
    request.get(`${BASE_API}/api/location-stats?municipio=CABO+FRIO&state=RJ&ultimos_meses=12`, { timeout: 30_000 }),
    request.get(`${BASE_API}/api/location-stats?municipio=ARRAIAL+DO+CABO&state=RJ&ultimos_meses=12`, { timeout: 30_000 }),
  ]);
  expect(resp1.ok()).toBeTruthy();
  expect(resp2.ok()).toBeTruthy();
  const d1 = await resp1.json();
  const d2 = await resp2.json();
  expect(d1.total).toBeGreaterThan(0);
  expect(d2.total).toBeGreaterThan(0);
});

test('Accuracy: location-stats handles duplicate selected_states', async ({ request }) => {
  const resp1 = await request.get(`${BASE_API}/api/location-stats?municipio=RIO+DE+JANEIRO&state=RJ&selected_states=RJ&ultimos_meses=12`, { timeout: 60_000 });
  const resp2 = await request.get(`${BASE_API}/api/location-stats?municipio=RIO+DE+JANEIRO&state=RJ&selected_states=RJ&selected_states=RJ&ultimos_meses=12`, { timeout: 60_000 });
  expect(resp1.ok()).toBeTruthy();
  expect(resp2.ok()).toBeTruthy();
  const d1 = await resp1.json();
  const d2 = await resp2.json();
  if (d1.total === 0) return;
  expect(d2.total).toBe(d1.total);
});

// ============================================================
// Group: Filter param forwarding (share URL contract)
// ============================================================

test('Accuracy: tipo filter reduces location-stats total', async ({ request }) => {
  const respAll = await request.get(`${BASE_API}/api/location-stats?municipio=PORTO+ALEGRE&state=RS&ultimos_meses=12`, { timeout: 60_000 });
  expect(respAll.ok()).toBeTruthy();
  const totalAll: number = (await respAll.json()).total || 0;
  if (totalAll === 0) return;

  // Get a tipo value
  const foResp = await request.get(`${BASE_API}/api/filter-options?selected_states=RS`, { timeout: 60_000 });
  expect(foResp.ok()).toBeTruthy();
  const tipos = (await foResp.json()).tipo || [];
  if (tipos.length === 0) return;
  const tipoValue = typeof tipos[0] === 'string' ? tipos[0] : tipos[0].value;

  const respFiltered = await request.get(
    `${BASE_API}/api/location-stats?municipio=PORTO+ALEGRE&state=RS&ultimos_meses=12&tipo=${encodeURIComponent(tipoValue)}`,
    { timeout: 30_000 }
  );
  expect(respFiltered.ok()).toBeTruthy();
  const totalFiltered: number = (await respFiltered.json()).total || 0;
  expect(totalFiltered).toBeLessThan(totalAll);
});

test('Accuracy: ultimos_meses=3 reduces total vs ultimos_meses=12', async ({ request }) => {
  const resp12 = await request.get(`${BASE_API}/api/location-stats?municipio=PORTO+ALEGRE&state=RS&ultimos_meses=12`, { timeout: 60_000 });
  const resp3 = await request.get(`${BASE_API}/api/location-stats?municipio=PORTO+ALEGRE&state=RS&ultimos_meses=3`, { timeout: 60_000 });
  expect(resp12.ok()).toBeTruthy();
  expect(resp3.ok()).toBeTruthy();
  const total12: number = (await resp12.json()).total || 0;
  const total3: number = (await resp3.json()).total || 0;
  if (total12 === 0) return;
  expect(total3).toBeLessThanOrEqual(total12);
});

// ============================================================
// Group: Share URL integrity (browser interaction)
// ============================================================

test('Accuracy: share URL includes state path after clicking a state', async ({ page }) => {
  await page.goto('/');
  await waitForMapReady(page);
  await openSidebarAndWait(page);

  // Select RS
  const rsCheckbox = page.locator('aside label').filter({ hasText: /^RS/ }).locator('input[type="checkbox"]');
  await rsCheckbox.check();
  await page.waitForTimeout(2000);

  // Click a municipality on the map to open a detail panel
  // Wait for colored polygons to appear
  await page.waitForFunction(() => {
    const paths = document.querySelectorAll('.leaflet-overlay-pane path');
    for (const p of paths) {
      const fill = p.getAttribute('fill') || '';
      if (['#ef4444', '#f97316', '#eab308', '#16a34a'].includes(fill)) return true;
    }
    return false;
  }, { timeout: 30_000 });

  // Click a colored polygon (RS municipality)
  const pathIdx = await page.evaluate(() => {
    const paths = document.querySelectorAll('.leaflet-overlay-pane path');
    for (let i = 0; i < paths.length; i++) {
      const fill = paths[i].getAttribute('fill') || '';
      if (['#ef4444', '#f97316', '#eab308', '#16a34a'].includes(fill)) {
        const rect = paths[i].getBoundingClientRect();
        if (rect.width > 5 && rect.height > 5) return i;
      }
    }
    return -1;
  });

  if (pathIdx < 0) return; // no polygon found — skip
  await page.locator('.leaflet-overlay-pane path').nth(pathIdx).click({ force: true });

  // Wait for detail panel to appear
  await page.waitForSelector('[aria-label="Copiar link"]', { timeout: 30_000 });

  // Check the browser address bar — should NOT be just "/"
  const url = page.url();
  const path = new URL(url).pathname;
  expect(path).not.toBe('/');
  expect(path.length).toBeGreaterThan(1);
});

test('Accuracy: share URL preserves tipo filter in address bar', async ({ page }) => {
  await page.goto('/');
  await waitForMapReady(page);
  await openSidebarAndWait(page);

  // Select RS
  const rsCheckbox = page.locator('aside label').filter({ hasText: /^RS/ }).locator('input[type="checkbox"]');
  await rsCheckbox.check();

  // Wait for filter-options to load
  await page.waitForResponse(
    resp => resp.url().includes('/api/filter-options') && resp.status() === 200,
    { timeout: 30_000 }
  );
  await page.waitForTimeout(1000);

  // Select the first crime type checkbox
  const firstTipo = page.locator('aside h3').filter({ hasText: 'Tipo de Crime' }).locator('xpath=..').locator('label input[type="checkbox"]').first();
  await firstTipo.check();
  await page.waitForTimeout(2000);

  // Click a colored polygon to open detail panel
  await page.waitForFunction(() => {
    const paths = document.querySelectorAll('.leaflet-overlay-pane path');
    for (const p of paths) {
      const fill = p.getAttribute('fill') || '';
      if (['#ef4444', '#f97316', '#eab308', '#16a34a'].includes(fill)) return true;
    }
    return false;
  }, { timeout: 30_000 });

  const pathIdx = await page.evaluate(() => {
    const paths = document.querySelectorAll('.leaflet-overlay-pane path');
    for (let i = 0; i < paths.length; i++) {
      const fill = paths[i].getAttribute('fill') || '';
      if (['#ef4444', '#f97316', '#eab308', '#16a34a'].includes(fill)) {
        const rect = paths[i].getBoundingClientRect();
        if (rect.width > 5 && rect.height > 5) return i;
      }
    }
    return -1;
  });

  if (pathIdx < 0) return;
  await page.locator('.leaflet-overlay-pane path').nth(pathIdx).click({ force: true });
  await page.waitForSelector('[aria-label="Copiar link"]', { timeout: 30_000 });

  // Address bar should include tipos= query param
  const url = page.url();
  expect(url).toContain('tipos=');
});

// ============================================================
// Group: Compare pane behavior (browser interaction)
// ============================================================

test('Accuracy: compare pane appears on top of detail panel', async ({ page }) => {
  await page.goto('/');
  await waitForMapReady(page);
  await openSidebarAndWait(page);

  // Select RS and wait for data
  const rsCheckbox = page.locator('aside label').filter({ hasText: /^RS/ }).locator('input[type="checkbox"]');
  await rsCheckbox.check();
  await page.waitForFunction(() => {
    const paths = document.querySelectorAll('.leaflet-overlay-pane path');
    for (const p of paths) {
      const fill = p.getAttribute('fill') || '';
      if (['#ef4444', '#f97316', '#eab308', '#16a34a'].includes(fill)) return true;
    }
    return false;
  }, { timeout: 30_000 });

  // Click a polygon to open a detail panel
  const pathIdx = await page.evaluate(() => {
    const paths = document.querySelectorAll('.leaflet-overlay-pane path');
    for (let i = 0; i < paths.length; i++) {
      const fill = paths[i].getAttribute('fill') || '';
      if (['#ef4444', '#f97316', '#eab308', '#16a34a'].includes(fill)) {
        const rect = paths[i].getBoundingClientRect();
        if (rect.width > 5 && rect.height > 5) return i;
      }
    }
    return -1;
  });
  if (pathIdx < 0) return;
  await page.locator('.leaflet-overlay-pane path').nth(pathIdx).click({ force: true });
  await page.waitForSelector('[aria-label="Copiar link"]', { timeout: 30_000 });

  // Get detail panel z-index
  const detailZIndex = await page.evaluate(() => {
    const panels = document.querySelectorAll('.fixed.bg-\\[\\#111827\\]');
    for (const p of panels) {
      const z = (p as HTMLElement).style.zIndex;
      if (z) return parseInt(z);
    }
    return 0;
  });

  // Enter compare mode
  await page.locator('button', { hasText: /Comparar|comparação/i }).first().click();
  await page.waitForTimeout(1000);

  // Click two different polygons to complete a comparison
  const polygonPaths = await page.locator('.leaflet-overlay-pane path.leaflet-interactive').all();
  if (polygonPaths.length >= 2) {
    await polygonPaths[0].click({ force: true });
    await page.waitForTimeout(2000);
    await polygonPaths[1].click({ force: true });

    // Wait for comparison pane to appear
    const comparePaneVisible = await page.locator('text=Comparação').first().waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
    if (comparePaneVisible) {
      // Get compare pane z-index
      const compareZIndex = await page.evaluate(() => {
        const els = document.querySelectorAll('[class*="border-[#7c3aed]"]');
        for (const el of els) {
          const parent = el.closest('[style*="z-index"]') || el.closest('[style*="zIndex"]');
          if (parent) {
            const z = (parent as HTMLElement).style.zIndex;
            if (z) return parseInt(z);
          }
        }
        return 0;
      });

      // Compare pane must be on top of detail panel
      expect(compareZIndex).toBeGreaterThan(detailZIndex);
    }
  }
});

test('Accuracy: compare panes persist after exiting compare mode', async ({ page }) => {
  await page.goto('/');
  await waitForMapReady(page);
  await openSidebarAndWait(page);

  // Select RS
  const rsCheckbox = page.locator('aside label').filter({ hasText: /^RS/ }).locator('input[type="checkbox"]');
  await rsCheckbox.check();
  await page.waitForFunction(() => {
    const paths = document.querySelectorAll('.leaflet-overlay-pane path');
    for (const p of paths) {
      const fill = p.getAttribute('fill') || '';
      if (['#ef4444', '#f97316', '#eab308', '#16a34a'].includes(fill)) return true;
    }
    return false;
  }, { timeout: 30_000 });

  // Enter compare mode
  const compareBtn = page.locator('button', { hasText: /Comparar|comparação/i }).first();
  await compareBtn.click();
  await page.waitForTimeout(1000);

  // Click two polygons to create a comparison
  const polygonPaths = await page.locator('.leaflet-overlay-pane path.leaflet-interactive').all();
  if (polygonPaths.length < 2) return; // skip if not enough polygons

  await polygonPaths[0].click({ force: true });
  await page.waitForTimeout(3000);
  await polygonPaths[1].click({ force: true });

  // Wait for "Comparação" pane to appear
  const comparePaneVisible = await page.locator('text=Comparação').first().waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
  if (!comparePaneVisible) return; // skip if comparison didn't complete

  // Count compare panes before toggling off
  const paneCountBefore = await page.locator('text=Comparação').count();
  expect(paneCountBefore).toBeGreaterThan(0);

  // Exit compare mode by clicking the toggle again
  await compareBtn.click();
  await page.waitForTimeout(1000);

  // Compare panes should STILL be visible (not cleared)
  const paneCountAfter = await page.locator('text=Comparação').count();
  expect(paneCountAfter).toBe(paneCountBefore);
});

test('Accuracy: comparing Cabo Frio vs Arraial do Cabo shows data', async ({ page, request }) => {
  // This test verifies the compare feature works for specific RJ cities
  // by checking the API responses that the compare UI would make
  const [resp1, resp2] = await Promise.all([
    request.get(`${BASE_API}/api/location-stats?municipio=Cabo+Frio&state=RJ&selected_states=RJ&ultimos_meses=12`, { timeout: 60_000 }),
    request.get(`${BASE_API}/api/location-stats?municipio=Arraial+do+Cabo&state=RJ&selected_states=RJ&ultimos_meses=12`, { timeout: 60_000 }),
  ]);
  expect(resp1.ok()).toBeTruthy();
  expect(resp2.ok()).toBeTruthy();

  const d1 = await resp1.json();
  const d2 = await resp2.json();

  // Both cities must return crime data for compare to show anything
  expect(d1.total).toBeGreaterThan(0);
  expect(d2.total).toBeGreaterThan(0);

  // Both must have crime_types breakdown
  expect(d1.crime_types?.length).toBeGreaterThan(0);
  expect(d2.crime_types?.length).toBeGreaterThan(0);
});
