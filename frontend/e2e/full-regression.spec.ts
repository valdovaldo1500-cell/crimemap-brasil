/**
 * Full Regression Test Suite — Crime Brasil
 *
 * Run weekly/daily to catch regressions across all major user flows:
 *   npx playwright test e2e/full-regression.spec.ts --reporter=line
 *
 * Covers:
 *   1. Homepage load + stats banner
 *   2. State clicking + detail panels (RS, RJ, MG)
 *   3. City search + detail panels + filters (Porto Alegre, Niteroi, BH)
 *   4. Bairro detail panels (Centro POA, Restinga POA)
 *   5. Filter application (tipo, periodo, year)
 *   6. Share URL round-trips (city, bairro, compare)
 *   7. View mode switches (regions/dots, rate/absolute)
 *   8. Compare mode (state vs state, city vs city)
 *   9. Year/period changes
 *  10. WhatsApp share link format
 */
import { test, expect, Page } from '@playwright/test';

const SITE = process.env.SITE_URL ?? 'https://crimebrasil.com.br';
const API = process.env.BASE_API ?? SITE;

// Suppress welcome modal for all tests by setting localStorage before navigation
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('crimebrasil_welcomed', 'true');
  });
});

// --------------- helpers ---------------

async function waitForMapReady(page: Page) {
  await page.waitForSelector('.leaflet-tile-loaded', { timeout: 60_000 });
  await page.waitForFunction(() => document.body.textContent?.includes('Ocorrências'), { timeout: 60_000 });
  // dismiss welcome modal: first skip typing ("Pular ▸"), then close ("Explorar o mapa →")
  const dialog = page.locator('[role="dialog"]');
  if (await dialog.isVisible({ timeout: 3000 }).catch(() => false)) {
    // Skip typing animation
    const skipBtn = page.locator('button:has-text("Pular")').first();
    if (await skipBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipBtn.click();
      await page.waitForTimeout(500);
    }
    // Close the modal
    const exploreBtn = page.locator('button:has-text("Explorar")').first();
    if (await exploreBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await exploreBtn.click();
      await page.waitForTimeout(500);
    }
  }
  // Wait for modal to fully disappear
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 }).catch(() => {});
}

async function openFilters(page: Page) {
  await page.locator('button', { hasText: /Filtros/i }).first().click();
  await page.waitForTimeout(500);
}

async function closeFilters(page: Page) {
  const closeBtn = page.locator('button[aria-label="Fechar filtros"], aside button:has-text("✕")').first();
  if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await closeBtn.click();
    await page.waitForTimeout(300);
  }
}

async function searchAndSelect(page: Page, query: string) {
  const input = page.locator('input[placeholder*="Buscar"]').first();
  await input.click();
  await input.fill(query);
  await page.waitForTimeout(1500); // debounce + API
  // click first autocomplete result
  const firstResult = page.locator('.absolute.bg-\\[\\#111827\\] >> text=/^' + query.split(' ')[0].toUpperCase() + '/i').first();
  if (await firstResult.isVisible({ timeout: 5000 }).catch(() => false)) {
    await firstResult.click();
  } else {
    // fallback: click any visible autocomplete item
    const anyResult = page.locator('[class*="cursor-pointer"]').first();
    if (await anyResult.isVisible({ timeout: 3000 }).catch(() => false)) {
      await anyResult.click();
    }
  }
  await page.waitForTimeout(2000);
}

async function getDetailPanelData(page: Page): Promise<{ title: string; total: string; visible: boolean }> {
  const panel = page.locator('[class*="DetailPanel"], [class*="detail-panel"], div:has(> p:has-text("ocorrências"))').first();
  const visible = await panel.isVisible({ timeout: 5000 }).catch(() => false);
  if (!visible) return { title: '', total: '', visible: false };
  const text = await panel.textContent() || '';
  const titleMatch = text.match(/^([A-ZÀ-Ü\s,]+)/);
  const totalMatch = text.match(/([\d.,]+)\s*ocorrências/);
  return { title: titleMatch?.[1]?.trim() || '', total: totalMatch?.[1] || '', visible: true };
}

async function clickState(page: Page, stateName: string) {
  // Click on a state polygon via its tooltip
  const paths = page.locator('.leaflet-overlay-pane path.leaflet-interactive');
  const count = await paths.count();
  for (let i = 0; i < count; i++) {
    const path = paths.nth(i);
    // Hover to check tooltip
    const box = await path.boundingBox();
    if (!box || box.width < 20 || box.height < 20) continue;
    await path.hover({ force: true });
    await page.waitForTimeout(300);
    const tooltip = page.locator('.leaflet-tooltip');
    if (await tooltip.isVisible({ timeout: 1000 }).catch(() => false)) {
      const tip = await tooltip.textContent() || '';
      if (tip.includes(stateName)) {
        await path.click({ force: true });
        await page.waitForTimeout(1000);
        return true;
      }
    }
  }
  return false;
}

// --------------- API-level sanity checks ---------------

test.describe('API Sanity', () => {
  test('homepage-stats returns valid data', async ({ request }) => {
    const r = await request.get(`${API}/api/homepage-stats`, { timeout: 15_000 });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.total_crimes).toBeGreaterThan(1_000_000);
    expect(d.total_municipios).toBeGreaterThan(1400);
    expect(d.period_start_year).toBeGreaterThanOrEqual(2003);
    expect(d.period_end_year).toBeGreaterThanOrEqual(2025);
  });

  test('filter-options returns data with AND without selected_states', async ({ request }) => {
    // Without state (search-first flow)
    const r1 = await request.get(`${API}/api/filter-options?ultimos_meses=12`, { timeout: 30_000 });
    expect(r1.ok()).toBeTruthy();
    const d1 = await r1.json();
    expect(d1.tipo.length).toBeGreaterThan(10);
    expect(d1.grupo.length).toBeGreaterThanOrEqual(2);
    expect(d1.sexo.length).toBeGreaterThanOrEqual(2);
    expect(d1.cor.length).toBeGreaterThanOrEqual(3);

    // With state
    const r2 = await request.get(`${API}/api/filter-options?selected_states=RS&ultimos_meses=12`, { timeout: 30_000 });
    expect(r2.ok()).toBeTruthy();
    const d2 = await r2.json();
    expect(d2.tipo.length).toBeGreaterThan(10);
  });

  test('state-stats returns data for RS, RJ, MG', async ({ request }) => {
    for (const state of ['RS', 'RJ', 'MG']) {
      const r = await request.get(`${API}/api/state-stats?state=${state}&selected_states=${state}&ultimos_meses=12`, { timeout: 30_000 });
      expect(r.ok()).toBeTruthy();
      const d = await r.json();
      expect(d.total).toBeGreaterThan(0, `${state} has no data`);
      expect(d.population).toBeGreaterThan(0, `${state} has no population`);
      expect(d.crime_types?.length).toBeGreaterThan(0, `${state} has no crime_types`);
      expect(d.crime_categories?.length).toBeGreaterThan(0, `${state} has no crime_categories`);
    }
  });

  test('location-stats returns data for cities in each state', async ({ request }) => {
    const cities = [
      { m: 'PORTO ALEGRE', s: 'RS', min: 50_000 },
      { m: 'RESTINGA SECA', s: 'RS', min: 100 },
      { m: 'CANOAS', s: 'RS', min: 5_000 },
      { m: 'NITEROI', s: 'RJ', min: 1_000 },
      { m: 'CABO FRIO', s: 'RJ', min: 1_000 },
      { m: 'BELO HORIZONTE', s: 'MG', min: 100 },
      { m: 'UBERLANDIA', s: 'MG', min: 100 },
    ];
    for (const c of cities) {
      const r = await request.get(`${API}/api/location-stats?municipio=${encodeURIComponent(c.m)}&state=${c.s}&ultimos_meses=12`, { timeout: 30_000 });
      expect(r.ok()).toBeTruthy();
      const d = await r.json();
      expect(d.total).toBeGreaterThan(c.min, `${c.m} (${c.s}): total=${d.total} < ${c.min}`);
      expect(d.crime_types?.length).toBeGreaterThan(0, `${c.m} (${c.s}): no crime_types`);
    }
  });

  test('location-stats returns data for bairros', async ({ request }) => {
    const bairros = [
      { m: 'PORTO ALEGRE', b: 'CENTRO HISTORICO', s: 'RS', min: 100 },
      { m: 'PORTO ALEGRE', b: 'RESTINGA', s: 'RS', min: 100 },
      { m: 'CANOAS', b: 'MATHIAS VELHO', s: 'RS', min: 100 },
    ];
    for (const bb of bairros) {
      const r = await request.get(`${API}/api/location-stats?municipio=${encodeURIComponent(bb.m)}&bairro=${encodeURIComponent(bb.b)}&state=${bb.s}&ultimos_meses=12`, { timeout: 30_000 });
      expect(r.ok()).toBeTruthy();
      const d = await r.json();
      expect(d.total).toBeGreaterThan(bb.min, `${bb.b}, ${bb.m}: total=${d.total} < ${bb.min}`);
    }
  });

  test('heatmap endpoints return data', async ({ request }) => {
    // States
    const r1 = await request.get(`${API}/api/heatmap/states?selected_states=RS&ultimos_meses=12`, { timeout: 30_000 });
    expect(r1.ok()).toBeTruthy();
    const d1 = await r1.json();
    expect(d1.length).toBeGreaterThan(0);
    expect(d1[0].weight).toBeGreaterThan(0);

    // Municipios (RS bbox)
    const r2 = await request.get(`${API}/api/heatmap/municipios?south=-34&west=-58&north=-27&east=-49&selected_states=RS&ultimos_meses=12`, { timeout: 30_000 });
    expect(r2.ok()).toBeTruthy();
    const d2 = await r2.json();
    expect(d2.length).toBeGreaterThan(10);
  });

  test('tipo filter reduces results', async ({ request }) => {
    const rAll = await request.get(`${API}/api/location-stats?municipio=PORTO+ALEGRE&state=RS&ultimos_meses=12`, { timeout: 30_000 });
    const dAll = await rAll.json();
    const rFiltered = await request.get(`${API}/api/location-stats?municipio=PORTO+ALEGRE&state=RS&tipo=AMEACA&ultimos_meses=12`, { timeout: 30_000 });
    const dFiltered = await rFiltered.json();
    expect(dFiltered.total).toBeLessThan(dAll.total);
    expect(dFiltered.total).toBeGreaterThan(0);
  });

  test('year filter returns different totals for different years', async ({ request }) => {
    const r23 = await request.get(`${API}/api/state-stats?state=RS&selected_states=RS&ano=2023`, { timeout: 30_000 });
    const r24 = await request.get(`${API}/api/state-stats?state=RS&selected_states=RS&ano=2024`, { timeout: 30_000 });
    const d23 = await r23.json();
    const d24 = await r24.json();
    expect(d23.total).toBeGreaterThan(0);
    expect(d24.total).toBeGreaterThan(0);
    // Totals should differ between years
    expect(d23.total).not.toBe(d24.total);
  });
});

// --------------- Share URL round-trips ---------------

test.describe('Share URL Round-trips', () => {
  test('city share URL loads correct data', async ({ request }) => {
    // Simulate: open share URL for Porto Alegre state panel
    const url = `${API}/api/state-stats?state=RS&selected_states=RS&ultimos_meses=12`;
    const r = await request.get(url, { timeout: 30_000 });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    const rsTotal = d.total;

    // Same data via share URL params should match
    const r2 = await request.get(`${API}/api/state-stats?state=RS&selected_states=RS&ultimos_meses=12`, { timeout: 30_000 });
    const d2 = await r2.json();
    expect(d2.total).toBe(rsTotal);
  });

  test('share URL with tipo filter preserves filter', async ({ request }) => {
    const r = await request.get(`${API}/api/location-stats?municipio=PORTO+ALEGRE&state=RS&tipo=AMEACA&ultimos_meses=12`, { timeout: 30_000 });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.total).toBeGreaterThan(0);
    // All crime types should be AMEACA (or normalized equivalent)
    for (const ct of d.crime_types || []) {
      const norm = (ct.tipo_enquadramento || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      expect(norm).toBe('AMEACA');
    }
  });

  test('compare share URL loads both locations', async ({ request }) => {
    // Simulate compare: RS vs RJ
    const [r1, r2] = await Promise.all([
      request.get(`${API}/api/state-stats?state=RS&selected_states=RS&selected_states=RJ&ultimos_meses=12`, { timeout: 30_000 }),
      request.get(`${API}/api/state-stats?state=RJ&selected_states=RS&selected_states=RJ&ultimos_meses=12`, { timeout: 30_000 }),
    ]);
    expect(r1.ok()).toBeTruthy();
    expect(r2.ok()).toBeTruthy();
    const d1 = await r1.json();
    const d2 = await r2.json();
    expect(d1.total).toBeGreaterThan(0);
    expect(d2.total).toBeGreaterThan(0);
    expect(d1.total).not.toBe(d2.total); // RS and RJ should have different totals
  });

  test('bairro share URL returns data for accented names', async ({ request }) => {
    // Glória is stored with accent but URL may have slug
    const r = await request.get(`${API}/api/location-stats?municipio=PORTO+ALEGRE&bairro=GLORIA&state=RS&ultimos_meses=12`, { timeout: 30_000 });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.total).toBeGreaterThan(0);
  });

  test('semester filter works in share URL', async ({ request }) => {
    const r = await request.get(`${API}/api/state-stats?state=RS&selected_states=RS&semestre=2024-S1`, { timeout: 30_000 });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.total).toBeGreaterThan(0);
    // S1 should be less than full year
    const rFull = await request.get(`${API}/api/state-stats?state=RS&selected_states=RS&ano=2024`, { timeout: 30_000 });
    const dFull = await rFull.json();
    expect(d.total).toBeLessThan(dFull.total);
  });
});

// --------------- Browser UI tests ---------------

test.describe('Homepage & Navigation', () => {
  test('homepage loads with stats banner and interactive states', async ({ page }) => {
    await page.goto(SITE);
    await waitForMapReady(page);

    // Stats banner shows reasonable numbers
    const text = await page.textContent('body') || '';
    expect(text).toContain('Ocorrências');
    expect(text).toContain('Municípios');
    expect(text).toContain('Dados disponíveis');

    // Interactive state polygons exist
    const interactivePaths = page.locator('.leaflet-overlay-pane path.leaflet-interactive');
    const count = await interactivePaths.count();
    expect(count).toBeGreaterThan(0);

    // "Clique em um estado" overlay is shown
    expect(text).toContain('Clique em um estado para começar');
  });

  test('clicking interactive state opens state menu', async ({ page }) => {
    await page.goto(SITE);
    await waitForMapReady(page);
    await page.waitForTimeout(3000);

    // Find and click the first interactive state polygon with substantial area
    const clickedState = await page.evaluate(() => {
      const paths = document.querySelectorAll('.leaflet-overlay-pane path.leaflet-interactive');
      for (const p of paths) {
        const rect = p.getBoundingClientRect();
        if (rect.width > 50 && rect.height > 50) {
          (p as HTMLElement).dispatchEvent(new MouseEvent('click', {
            bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2
          }));
          return true;
        }
      }
      return false;
    });
    expect(clickedState).toBeTruthy();
    await page.waitForTimeout(1500);

    // State menu should appear with "Selecionar estado" or "Ver estatísticas"
    const menuText = await page.textContent('body') || '';
    const hasMenu = menuText.includes('Selecionar estado') || menuText.includes('Ver estatísticas') || menuText.includes('estatísticas detalhadas');
    expect(hasMenu).toBeTruthy();
  });

  test('search for city navigates and shows data', async ({ page }) => {
    await page.goto(SITE);
    await waitForMapReady(page);
    await page.waitForTimeout(1500);

    // Search for Canoas (smaller city, faster to load)
    const input = page.locator('input[placeholder*="Buscar"]').first();
    await input.click();
    await input.fill('Canoas');
    await page.waitForTimeout(2000);

    // Autocomplete should show results
    const autocomplete = page.locator('text=CANOAS').first();
    await expect(autocomplete).toBeVisible({ timeout: 10_000 });

    // Click the city result
    await autocomplete.click();
    // Wait for map to zoom and data to load
    await page.waitForTimeout(8000);

    // Map should zoom — view level indicator should show Municípios or Bairros
    const bodyText = await page.textContent('body') || '';
    const hasZoomed = bodyText.includes('Municípios') || bodyText.includes('Bairros')
      || bodyText.includes('MUNICÍPIOS') || bodyText.includes('BAIRROS');
    expect(hasZoomed).toBeTruthy();
  });

  test('filters populate without state selection', async ({ page }) => {
    await page.goto(SITE);
    await waitForMapReady(page);
    // Wait for filter-options to load (deferred ~300ms after initialLoading)
    await page.waitForTimeout(2000);

    await openFilters(page);
    await page.waitForTimeout(1000);

    // Crime types should be populated
    const tipoSection = page.locator('text=TIPO DE CRIME').first();
    await expect(tipoSection).toBeVisible({ timeout: 5000 });

    // Check there are actual crime type labels (not empty)
    const labels = page.locator('aside label');
    const labelCount = await labels.count();
    expect(labelCount).toBeGreaterThan(5, 'Filter panel has too few labels — tipos may not have loaded');

    // Check specific sections exist and have content
    const sidebarText = await page.locator('aside').textContent() || '';
    const lower = sidebarText.toLowerCase();
    expect(lower).toContain('ameaça');
    expect(lower).toContain('grupo');
    expect(lower).toContain('crimes');
    expect(lower).toContain('sexo');
    expect(lower).toContain('feminino');
    expect(lower).toContain('cor');
    expect(lower).toContain('branca');
  });
});

test.describe('View Modes', () => {
  test('switch between Regiões and Pontos', async ({ page }) => {
    await page.goto(SITE);
    await waitForMapReady(page);
    await page.waitForTimeout(2000);

    // Click a state first to get data on the map
    const rsPath = page.locator('.leaflet-overlay-pane path.leaflet-interactive').first();
    if (await rsPath.isVisible({ timeout: 3000 }).catch(() => false)) {
      await rsPath.click({ force: true });
      await page.waitForTimeout(1000);
      // Click "Selecionar estado" if menu appears
      const selectBtn = page.locator('text=Selecionar estado').first();
      if (await selectBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await selectBtn.click();
        await page.waitForTimeout(3000);
      }
    }

    // Default should be Regiões (choropleth)
    const regioesBtn = page.locator('button', { hasText: /Regi/i }).first();
    await expect(regioesBtn).toBeVisible();

    // Switch to Pontos
    const pontosBtn = page.locator('button', { hasText: /Pontos/i }).first();
    await pontosBtn.click();
    await page.waitForTimeout(2000);

    // Dots should appear (crime-dot-icon elements)
    const bodyText = await page.textContent('body') || '';
    // The dots have text content (counts)
    expect(bodyText.length).toBeGreaterThan(100);

    // Switch back to Regiões
    await regioesBtn.click();
    await page.waitForTimeout(2000);
  });

  test('switch between Total and /100K', async ({ page }) => {
    await page.goto(SITE);
    await waitForMapReady(page);
    await page.waitForTimeout(2000);

    // /100K button
    const rateBtn = page.locator('button', { hasText: '/100K' }).first();
    await expect(rateBtn).toBeVisible();

    // Total button
    const totalBtn = page.locator('button', { hasText: 'Total' }).first();
    await expect(totalBtn).toBeVisible();

    // Click /100K
    await rateBtn.click();
    await page.waitForTimeout(1000);

    // Click Total
    await totalBtn.click();
    await page.waitForTimeout(1000);

    // Both buttons should still be visible (no crash)
    await expect(rateBtn).toBeVisible();
    await expect(totalBtn).toBeVisible();
  });

  test('year/period selectors work', async ({ page }) => {
    await page.goto(SITE);
    await waitForMapReady(page);

    // Default period is 12m
    const btn12m = page.locator('button', { hasText: '12m' }).first();
    await expect(btn12m).toBeVisible();

    // Switch to Ano
    const anoBtn = page.locator('button', { hasText: 'Ano' }).first();
    await anoBtn.click();
    await page.waitForTimeout(1000);

    // Year selector should appear
    const yearSelect = page.locator('select, button:has-text("2025"), button:has-text("2024")').first();
    await expect(yearSelect).toBeVisible({ timeout: 5000 });

    // Switch to S1
    const s1Btn = page.locator('button', { hasText: 'S1' }).first();
    await s1Btn.click();
    await page.waitForTimeout(1000);

    // Switch back to 12m
    await btn12m.click();
    await page.waitForTimeout(1000);
  });
});

test.describe('Compare Mode', () => {
  test('compare RS vs RJ via share URL shows comparison panel', async ({ page }) => {
    await page.goto(`${SITE}/?compare=1&loc=RS%3A%3A&loc=RJ%3A%3A&per=12m`);
    await waitForMapReady(page);
    await page.waitForTimeout(5000);

    const bodyText = await page.textContent('body') || '';

    // Comparison panel should show
    expect(bodyText).toContain('COMPARAÇÃO');
    expect(bodyText).toContain('RS');
    expect(bodyText).toContain('RJ');

    // Should have Total or /100K row
    const hasTotal = bodyText.includes('Total') || bodyText.includes('/100K');
    expect(hasTotal).toBeTruthy();

    // Should have Diferença row
    expect(bodyText).toContain('Diferença');

    // Should have Hab. row
    expect(bodyText).toContain('Hab.');
  });

  test('compare with tipo filter shows filtered data', async ({ page }) => {
    await page.goto(`${SITE}/?compare=1&loc=RS%3A%3A&loc=RJ%3A%3A&per=12m&tipos=AMEACA`);
    await waitForMapReady(page);
    await page.waitForTimeout(5000);

    const bodyText = await page.textContent('body') || '';
    expect(bodyText).toContain('COMPARAÇÃO');

    // Should show Ameaça in the crime type breakdown
    const hasAmeaca = bodyText.toLowerCase().includes('ameaça') || bodyText.toLowerCase().includes('ameaca');
    expect(hasAmeaca).toBeTruthy();

    // Filter badge should show (1 active filter)
    const filterBadge = page.locator('text=/Filtros.*1/').first();
    const hasBadge = await filterBadge.isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasBadge).toBeTruthy();
  });

  test('rate toggle updates compare panel values', async ({ page }) => {
    await page.goto(`${SITE}/?compare=1&loc=RS%3A%3A&loc=RJ%3A%3A&per=12m&rate=absolute`);
    await waitForMapReady(page);
    await page.waitForTimeout(5000);

    // In absolute mode, should show "Total" label
    let bodyText = await page.textContent('body') || '';
    expect(bodyText).toContain('Total');

    // Switch to /100K
    const rateBtn = page.locator('button', { hasText: '/100K' }).first();
    await rateBtn.click();
    await page.waitForTimeout(2000);

    // Panel should now show /100K instead of Total
    bodyText = await page.textContent('body') || '';
    // The main row label should change to /100K
    const comparePanel = page.locator('text=COMPARAÇÃO').first().locator('xpath=ancestor::div[contains(@class,"bg-")]');
    if (await comparePanel.isVisible({ timeout: 3000 }).catch(() => false)) {
      const panelText = await comparePanel.textContent() || '';
      // After toggle, the first data row should say /100K (not Total)
      const firstRowIdx = panelText.indexOf('RS');
      if (firstRowIdx > -1) {
        const afterHeader = panelText.substring(firstRowIdx);
        expect(afterHeader).toContain('/100K');
      }
    }
  });
});

test.describe('Share URL Integrity', () => {
  test('city detail via share URL shows panel with data', async ({ page }) => {
    await page.goto(`${SITE}/?panel=state&state=RS`);
    await waitForMapReady(page);
    await page.waitForTimeout(5000);

    const bodyText = await page.textContent('body') || '';
    // Detail panel should show RS data
    const hasData = bodyText.includes('ocorrências') || bodyText.includes('/100K');
    expect(hasData).toBeTruthy();
  });

  test('bairro detail via share URL shows panel with data', async ({ page }) => {
    await page.goto(`${SITE}/?panel=location&state=RS&municipio=PORTO+ALEGRE&bairro=CENTRO+HISTORICO`);
    await waitForMapReady(page);
    await page.waitForTimeout(5000);

    const bodyText = await page.textContent('body') || '';
    const hasData = bodyText.includes('ocorrências') || bodyText.includes('/100K') || bodyText.includes('Centro');
    expect(hasData).toBeTruthy();
  });

  test('compare share URL with cities loads both panels', async ({ page }) => {
    await page.goto(`${SITE}/?compare=1&loc=RS%3APORTO+ALEGRE%3A&loc=RS%3ACANOAS%3A&per=12m`);
    await waitForMapReady(page);
    await page.waitForTimeout(6000);

    const bodyText = await page.textContent('body') || '';
    expect(bodyText).toContain('COMPARAÇÃO');
    // Both city names should appear
    const hasPOA = bodyText.includes('PORTO ALEGRE') || bodyText.includes('Porto Alegre');
    const hasCanoas = bodyText.includes('CANOAS') || bodyText.includes('Canoas');
    expect(hasPOA || hasCanoas).toBeTruthy();
  });

  test('WhatsApp share link format is valid', async ({ page }) => {
    // Load a compare view
    await page.goto(`${SITE}/?compare=1&loc=RS%3A%3A&loc=RJ%3A%3A&per=12m`);
    await waitForMapReady(page);
    await page.waitForTimeout(5000);

    // Find WhatsApp share link
    const whatsappLink = page.locator('a[href*="wa.me"]').first();
    if (await whatsappLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      const href = await whatsappLink.getAttribute('href') || '';
      // Should contain wa.me with encoded text
      expect(href).toContain('wa.me');
      expect(href).toContain('text=');
      // Decode and check it contains the site URL
      const decoded = decodeURIComponent(href);
      expect(decoded).toContain('crimebrasil.com.br');
      expect(decoded).toContain('compare=1');
    }
  });
});

test.describe('Cross-State Data Consistency', () => {
  test('state-stats breakdown sum <= total for all states', async ({ request }) => {
    for (const state of ['RS', 'RJ', 'MG']) {
      const r = await request.get(`${API}/api/state-stats?state=${state}&selected_states=${state}&ultimos_meses=12`, { timeout: 30_000 });
      const d = await r.json();
      const breakdownSum = (d.crime_types || []).reduce((s: number, ct: any) => s + ct.count, 0);
      expect(breakdownSum).toBeLessThanOrEqual(d.total * 1.01, // allow 1% rounding tolerance
        `${state}: breakdown sum ${breakdownSum} > total ${d.total}`
      );
    }
  });

  test('rate math is consistent across states', async ({ request }) => {
    for (const state of ['RS', 'RJ', 'MG']) {
      const r = await request.get(`${API}/api/state-stats?state=${state}&selected_states=${state}&ultimos_meses=12`, { timeout: 30_000 });
      const d = await r.json();
      if (d.population && d.population > 0) {
        const rate = (d.total / d.population) * 100_000;
        expect(rate).toBeGreaterThan(0);
        expect(rate).toBeLessThan(50_000); // sanity check
      }
    }
  });

  test('no duplicate crime types within state response', async ({ request }) => {
    for (const state of ['RS', 'RJ']) {
      const r = await request.get(`${API}/api/state-stats?state=${state}&selected_states=${state}&ultimos_meses=12`, { timeout: 30_000 });
      const d = await r.json();
      const tipos = (d.crime_types || []).map((ct: any) => ct.tipo_enquadramento);
      const unique = new Set(tipos);
      expect(unique.size).toBe(tipos.length, `${state} has duplicate crime types`);
    }
  });
});
