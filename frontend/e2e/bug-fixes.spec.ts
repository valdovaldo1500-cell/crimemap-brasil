import { test, expect } from '@playwright/test';

const BASE_API = 'http://localhost:8000';

// Helper: wait for map tiles and stats to load
async function waitForMapReady(page: import('@playwright/test').Page) {
  await page.waitForSelector('.leaflet-tile-loaded', { timeout: 30_000 });
  await page.waitForFunction(() => {
    return document.body.textContent?.includes('Ocorrências');
  }, { timeout: 30_000 });
}

// Helper: open sidebar and wait for crime type data to populate
async function openSidebarAndWait(page: import('@playwright/test').Page) {
  await page.locator('button', { hasText: /Filtros/i }).first().click();
  // Wait for sidebar element to appear
  await page.locator('aside').waitFor({ state: 'visible', timeout: 60_000 });
  // Wait for crime type labels to populate (the Estados section loads first, so wait for Tipo de Crime specifically)
  await page.locator('aside h3').filter({ hasText: 'Tipo de Crime' }).locator('xpath=..').locator('label').first().waitFor({ state: 'attached', timeout: 60_000 });
}

// ============================================================
// Fix 1: State click toggles selection (popup persistence preserved at municipality level)
// ============================================================
test('Fix 1: clicking state polygon toggles selection (no popup at state level)', async ({ page }) => {
  await page.goto('/');
  await waitForMapReady(page);

  // Wait for state GeoJSON polygons to render
  await page.waitForSelector('.leaflet-overlay-pane path', { timeout: 15_000 });
  await page.waitForTimeout(5000);

  // Find a clickable state polygon with actual area (must be interactive — only RS, RJ, MG)
  const clickablePathIndex = await page.evaluate(() => {
    const allPaths = document.querySelectorAll('.leaflet-overlay-pane path');
    const interactivePaths = document.querySelectorAll('.leaflet-overlay-pane path.leaflet-interactive');
    // Build a set of interactive path indices within the full path list
    for (const ip of interactivePaths) {
      const d = ip.getAttribute('d') || '';
      if (d.length > 20 && d.includes('L')) {
        const rect = ip.getBoundingClientRect();
        if (rect.width > 10 && rect.height > 10) {
          // Find its index in the full path list
          for (let i = 0; i < allPaths.length; i++) {
            if (allPaths[i] === ip) return i;
          }
        }
      }
    }
    return -1;
  });

  if (clickablePathIndex >= 0) {
    // Click a state polygon — should toggle selection, NOT show popup
    await page.locator('.leaflet-overlay-pane path').nth(clickablePathIndex).click({ force: true });

    // Wait for at least one polygon to become colored (state selected + data loaded)
    const hasColored = await page.waitForFunction(() => {
      const paths = document.querySelectorAll('.leaflet-overlay-pane path');
      const coloredFills = ['#ef4444', '#f97316', '#eab308', '#16a34a'];
      for (const p of paths) {
        const fill = p.getAttribute('fill') || '';
        if (coloredFills.includes(fill)) return true;
      }
      return false;
    }, { timeout: 15_000 }).then(() => true).catch(() => false);
    expect(hasColored).toBe(true);

    // No popup should appear (state clicks toggle, not show popup)
    const popup = page.locator('.leaflet-popup-content');
    await expect(popup).toHaveCount(0);
  }
});

// ============================================================
// Fix 2: Accented names — frontend uses DB name for API lookups
// ============================================================
test('Fix 2: autocomplete returns results for unaccented search', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/autocomplete?q=antonio+prado`);
  expect(resp.ok()).toBeTruthy();
  const data = await resp.json();
  expect(data.length).toBeGreaterThan(0);
  expect(data[0].name).toContain('ANTONIO PRADO');
  expect(data[0].count).toBeGreaterThan(0);
});

test('Fix 2: location-stats works with DB municipio name', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/location-stats?municipio=ANTONIO+PRADO`, { timeout: 30_000 });
  expect(resp.ok()).toBeTruthy();
  const data = await resp.json();
  expect(data.total).toBeGreaterThan(0);
  expect(data.crime_types.length).toBeGreaterThan(0);
});

// ============================================================
// Fix 3: Default to choropleth ("Regioes") view on load
// ============================================================
test('Fix 3: default view is choropleth (Regioes button active)', async ({ page }) => {
  await page.goto('/');
  await waitForMapReady(page);

  const regioesBtn = page.locator('button', { hasText: /Regi/i });
  await expect(regioesBtn).toBeVisible();

  const bgColor = await regioesBtn.evaluate(el => {
    return window.getComputedStyle(el).backgroundColor;
  });
  expect(bgColor).toBe('rgb(59, 130, 246)');
});

// ============================================================
// Fix 4: Grupo filter only shows CRIMES and CONTRAVENCOES
// ============================================================
test('Fix 4: API grupo-values returns only CRIMES and CONTRAVENCOES', async ({ request }) => {
  const resp = await request.get(`${BASE_API}/api/grupo-values`);
  expect(resp.ok()).toBeTruthy();
  const data = await resp.json();
  const values = data.map((d: { value: string }) => d.value);

  expect(values).toHaveLength(2);
  expect(values).toContain('CRIMES');
  expect(values).toContain('CONTRAVENCOES');
  expect(values).not.toContain('Masculino');
  expect(values).not.toContain('Feminino');
});

test('Fix 4: sidebar Grupo filter shows exactly 2 options', async ({ page }) => {
  await page.goto('/');
  await waitForMapReady(page);
  await openSidebarAndWait(page);

  // Count labels in the Grupo section using evaluate for reliable DOM traversal
  const grupoLabelCount = await page.evaluate(() => {
    const headings = document.querySelectorAll('aside h3');
    for (const h3 of headings) {
      if (h3.textContent?.trim() === 'Grupo') {
        const section = h3.parentElement;
        if (section) {
          return section.querySelectorAll('label').length;
        }
      }
    }
    return -1;
  });

  expect(grupoLabelCount).toBe(2);
});

// ============================================================
// Fix 5: Filter updates crime type counts
// ============================================================
test('Fix 5: selecting grupo filter updates crime type counts', async ({ page }) => {
  await page.goto('/');
  await waitForMapReady(page);
  await openSidebarAndWait(page);
  // Also ensure Grupo section labels are loaded before interacting
  await page.locator('aside h3:has-text("Grupo")').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('aside h3:has-text("Grupo") ~ div label').first().waitFor({ state: 'attached', timeout: 30_000 });

  // Get the initial first crime type count via evaluate
  const initialCount = await page.evaluate(() => {
    const headings = document.querySelectorAll('aside h3');
    for (const h3 of headings) {
      if (h3.textContent?.includes('Tipo de Crime')) {
        const section = h3.parentElement;
        if (section) {
          const span = section.querySelector('span.font-mono');
          return span?.textContent || null;
        }
      }
    }
    return null;
  });
  expect(initialCount).toBeTruthy();

  // Click the CONTRAVENCOES checkbox in the Grupo section
  await page.evaluate(() => {
    const headings = document.querySelectorAll('aside h3');
    for (const h3 of headings) {
      if (h3.textContent?.trim() === 'Grupo') {
        const section = h3.parentElement;
        if (section) {
          const labels = section.querySelectorAll('label');
          // Click the last label (CONTRAVENCOES is typically second)
          if (labels.length > 0) {
            (labels[labels.length - 1] as HTMLElement).click();
          }
        }
      }
    }
  });

  // Wait for crime type counts to update (API re-fetch triggered by grupo change)
  const prevCount = initialCount!;
  await page.waitForFunction(
    (prev) => {
      const headings = document.querySelectorAll('aside h3');
      for (const h3 of headings) {
        if (h3.textContent?.includes('Tipo de Crime')) {
          const section = h3.parentElement;
          if (section) {
            const span = section.querySelector('span.font-mono');
            if (span && span.textContent !== prev) return true;
          }
        }
      }
      return false;
    },
    prevCount,
    { timeout: 30_000 }
  );

  const updatedCount = await page.evaluate(() => {
    const headings = document.querySelectorAll('aside h3');
    for (const h3 of headings) {
      if (h3.textContent?.includes('Tipo de Crime')) {
        const section = h3.parentElement;
        if (section) {
          const span = section.querySelector('span.font-mono');
          return span?.textContent || null;
        }
      }
    }
    return null;
  });
  expect(updatedCount).not.toBe(initialCount);
});

// ============================================================
// Fix 6: Accent-insensitive crime type search in sidebar
// ============================================================
test('Fix 6: accent-insensitive crime type search', async ({ page }) => {
  await page.goto('/');
  await waitForMapReady(page);
  await openSidebarAndWait(page);

  // Count total visible crime type labels
  const totalCount = await page.evaluate(() => {
    const headings = document.querySelectorAll('aside h3');
    for (const h3 of headings) {
      if (h3.textContent?.includes('Tipo de Crime')) {
        const section = h3.parentElement;
        if (section) {
          return section.querySelectorAll('label').length;
        }
      }
    }
    return 0;
  });
  expect(totalCount).toBeGreaterThan(5);

  // Type "acao" in the crime type search (should match accented "AÇÃO" types)
  const searchInput = page.locator('aside input[placeholder*="Buscar tipo"]');
  await expect(searchInput).toBeVisible();
  await searchInput.fill('acao');
  await page.waitForTimeout(500);

  // Count filtered results
  const filteredCount = await page.evaluate(() => {
    const headings = document.querySelectorAll('aside h3');
    for (const h3 of headings) {
      if (h3.textContent?.includes('Tipo de Crime')) {
        const section = h3.parentElement;
        if (section) {
          return section.querySelectorAll('label').length;
        }
      }
    }
    return 0;
  });
  expect(filteredCount).toBeGreaterThan(0);
  expect(filteredCount).toBeLessThan(totalCount);
});

// ============================================================
// Fix 7: Misgeocoded bairro snap
// ============================================================
test('Fix 7: no PANTANO bairros in Porto Alegre area', async ({ request }) => {
  const resp = await request.get(
    `${BASE_API}/api/heatmap/bairros?south=-30.2&north=-29.9&west=-51.3&east=-51.0`,
    { timeout: 60_000 }
  );
  expect(resp.ok()).toBeTruthy();
  const data = await resp.json();
  expect(data.length).toBeGreaterThan(0);

  const pantanoEntries = data.filter(
    (d: { bairro: string }) => d.bairro && d.bairro.toUpperCase().includes('PANTANO')
  );
  expect(pantanoEntries).toHaveLength(0);
});

test('Fix 7: Pantano Grande bairros exist in correct location', async ({ request }) => {
  const resp = await request.get(
    `${BASE_API}/api/heatmap/bairros?south=-30.4&north=-30.0&west=-52.5&east=-52.1`,
    { timeout: 30_000 }
  );
  expect(resp.ok()).toBeTruthy();
  const data = await resp.json();

  const pantanoMunEntries = data.filter(
    (d: { municipio: string }) => d.municipio === 'PANTANO GRANDE'
  );
  expect(pantanoMunEntries.length).toBeGreaterThan(0);

  for (const entry of pantanoMunEntries) {
    expect(entry.latitude).toBeGreaterThan(-31.0);
    expect(entry.latitude).toBeLessThan(-29.5);
    expect(entry.longitude).toBeGreaterThan(-53.0);
    expect(entry.longitude).toBeLessThan(-51.5);
  }
});

// ============================================================
// Fix 8: MG warning bidirectionality — shows when MG is first
// ============================================================
test('Fix 8: MG warning appears when MG selected first, then adding another state', async ({ page }) => {
  await page.goto('/');
  await waitForMapReady(page);
  await openSidebarAndWait(page);

  // Find MG checkbox and select it (no warning for first state)
  const mgCheckbox = page.locator('aside label').filter({ hasText: 'MG' }).locator('input[type="checkbox"]');
  await mgCheckbox.check();
  await page.waitForTimeout(500);

  // Now try to add RS — the MG partial warning should appear
  // Use click() instead of check() — the warning modal intercepts and prevents the checkbox from being checked
  const rsCheckbox = page.locator('aside label').filter({ hasText: /^RS/ }).locator('input[type="checkbox"]');
  await rsCheckbox.click();
  await page.waitForTimeout(500);

  // Assert: MG warning dialog is visible
  const warningDialog = page.locator('text=Dados parciais');
  await expect(warningDialog).toBeVisible({ timeout: 5_000 });

  // Take screenshot for visual verification
  await page.screenshot({ path: './screenshots/08-mg-warning-bidirectional.png' });

  // Confirm the warning
  await page.locator('button', { hasText: 'Confirmar' }).click();
  await page.waitForTimeout(300);

  // Both checkboxes should now be checked
  await expect(mgCheckbox).toBeChecked();
  await expect(rsCheckbox).toBeChecked();
});

// ============================================================
// Fix 9: Fresh load — all states greyed out, no checkboxes checked
// ============================================================
test('Fix 9: fresh load shows all states greyed out on map', async ({ page }) => {
  await page.goto('/');
  await waitForMapReady(page);

  // Wait for state GeoJSON polygons to render
  await page.waitForSelector('.leaflet-overlay-pane path', { timeout: 15_000 });
  // Wait for the loading spinner to disappear — hint text only shows when !loading && !emptyResult
  await page.waitForSelector('span:has-text("Carregando...")', { state: 'hidden', timeout: 30_000 });

  // Assert: hint text "Clique em um estado para começar" is visible
  const hintText = page.locator('text=Clique em um estado para começar');
  await expect(hintText).toBeVisible({ timeout: 30_000 });

  // Assert: SVG paths have grey fill, NOT colored fills
  // Leaflet uses setAttribute('fill', ...) on SVG paths, not inline CSS style
  const colorCounts = await page.evaluate(() => {
    const paths = document.querySelectorAll('.leaflet-overlay-pane path');
    let grey = 0, colored = 0;
    const coloredFills = ['#ef4444', '#f97316', '#eab308', '#16a34a'];
    paths.forEach(p => {
      const fill = p.getAttribute('fill') || '';
      if (coloredFills.includes(fill)) colored++;
      else if (fill && fill !== 'none') grey++;
    });
    return { grey, colored };
  });
  expect(colorCounts.grey).toBeGreaterThan(0);
  expect(colorCounts.colored).toBe(0);

  // Take screenshot
  await page.screenshot({ path: './screenshots/09-fresh-load-grey.png' });
});

// ============================================================
// Fix 10: Click selected state on map to deselect it
// ============================================================
test('Fix 10: clicking selected state on map deselects it', async ({ page }) => {
  await page.goto('/');
  await waitForMapReady(page);
  await openSidebarAndWait(page);

  // Select RS via sidebar checkbox
  const rsCheckbox = page.locator('aside label').filter({ hasText: /^RS/ }).locator('input[type="checkbox"]');
  await rsCheckbox.check();

  // Wait for map to re-render with colored RS polygon
  // Leaflet uses setAttribute('fill', ...) on SVG paths
  await page.waitForFunction(() => {
    const paths = document.querySelectorAll('.leaflet-overlay-pane path');
    const coloredFills = ['#ef4444', '#f97316', '#eab308', '#16a34a'];
    for (const p of paths) {
      const fill = p.getAttribute('fill') || '';
      if (coloredFills.includes(fill)) return true;
    }
    return false;
  }, { timeout: 15_000 });

  // Assert: RS checkbox is checked
  await expect(rsCheckbox).toBeChecked();

  // Assert: at least one colored polygon exists
  const hasColored = await page.evaluate(() => {
    const paths = document.querySelectorAll('.leaflet-overlay-pane path');
    const coloredFills = ['#ef4444', '#f97316', '#eab308', '#16a34a'];
    for (const p of paths) {
      const fill = p.getAttribute('fill') || '';
      if (coloredFills.includes(fill)) return true;
    }
    return false;
  });
  expect(hasColored).toBe(true);

  await page.screenshot({ path: './screenshots/10a-rs-selected.png' });

  // Click RS polygon on the map to deselect it
  // Find a colored path (the RS polygon)
  const coloredPathIndex = await page.evaluate(() => {
    const paths = document.querySelectorAll('.leaflet-overlay-pane path');
    const coloredFills = ['#ef4444', '#f97316', '#eab308', '#16a34a'];
    for (let i = 0; i < paths.length; i++) {
      const fill = paths[i].getAttribute('fill') || '';
      if (coloredFills.includes(fill)) {
        const rect = paths[i].getBoundingClientRect();
        if (rect.width > 5 && rect.height > 5) return i;
      }
    }
    return -1;
  });

  if (coloredPathIndex >= 0) {
    await page.locator('.leaflet-overlay-pane path').nth(coloredPathIndex).click({ force: true });
    await page.waitForTimeout(3000);

    // Assert: RS checkbox is now unchecked (state was deselected)
    await expect(rsCheckbox).not.toBeChecked();

    await page.screenshot({ path: './screenshots/10b-rs-deselected.png' });
  }
});

// ============================================================
// Fix 11: State selection filters map data — MG only
// ============================================================
test('Fix 11: selecting MG restricts tipo options to violent crimes', async ({ page }) => {
  await page.goto('/');
  await waitForMapReady(page);
  await openSidebarAndWait(page);

  // Get initial tipo count (all states / no selection)
  const initialTipoCount = await page.evaluate(() => {
    const headings = document.querySelectorAll('aside h3');
    for (const h3 of headings) {
      if (h3.textContent?.includes('Tipo de Crime')) {
        const section = h3.parentElement;
        if (section) return section.querySelectorAll('label').length;
      }
    }
    return 0;
  });
  expect(initialTipoCount).toBeGreaterThan(5);

  // Select MG and wait for the filter-options API to respond
  const mgCheckbox = page.locator('aside label').filter({ hasText: 'MG' }).locator('input[type="checkbox"]');
  await Promise.all([
    page.waitForResponse(
      resp => resp.url().includes('/api/filter-options') && resp.status() === 200,
      { timeout: 30_000 }
    ),
    mgCheckbox.check(),
  ]);

  // Wait for React to re-render with updated tipo labels
  await page.waitForFunction(
    (prevCount) => {
      const headings = document.querySelectorAll('aside h3');
      for (const h3 of headings) {
        if (h3.textContent?.includes('Tipo de Crime')) {
          const section = h3.parentElement;
          if (section) return section.querySelectorAll('label').length !== prevCount;
        }
      }
      return false;
    },
    initialTipoCount,
    { timeout: 15_000 }
  );

  // Assert: fewer tipo options now (restricted to MG-compatible violent crimes)
  const filteredTipoCount = await page.evaluate(() => {
    const headings = document.querySelectorAll('aside h3');
    for (const h3 of headings) {
      if (h3.textContent?.includes('Tipo de Crime')) {
        const section = h3.parentElement;
        if (section) return section.querySelectorAll('label').length;
      }
    }
    return 0;
  });
  expect(filteredTipoCount).toBeLessThan(initialTipoCount);
  expect(filteredTipoCount).toBeGreaterThan(0);

  await page.screenshot({ path: './screenshots/11-mg-filtered-tipos.png' });
});

// ============================================================
// Fix 12: Demographic filters greyed out for non-RS states
// ============================================================
test('Fix 12: demographic filters disabled when non-RS state selected', async ({ page }) => {
  await page.goto('/');
  await waitForMapReady(page);
  await openSidebarAndWait(page);

  // Assert: Sexo section is NOT greyed out initially
  const sexoSection = page.locator('aside h3').filter({ hasText: 'Sexo da Vítima' }).locator('..');
  await expect(sexoSection).not.toHaveCSS('opacity', '0.5');

  // Select MG (non-RS state)
  const mgCheckbox = page.locator('aside label').filter({ hasText: 'MG' }).locator('input[type="checkbox"]');
  await mgCheckbox.check();
  await page.waitForTimeout(1000);

  // Assert: Sexo section is greyed out (opacity: 0.5)
  await expect(sexoSection).toHaveCSS('opacity', '0.5');

  // Assert: Cor section is greyed out
  const corSection = page.locator('aside h3').filter({ hasText: 'Cor da Vítima' }).locator('..');
  await expect(corSection).toHaveCSS('opacity', '0.5');

  // Assert: Idade section is greyed out
  const idadeSection = page.locator('aside h3').filter({ hasText: 'Idade da Vítima' }).locator('..');
  await expect(idadeSection).toHaveCSS('opacity', '0.5');

  // Assert: "(apenas RS)" text is visible
  await expect(page.locator('text=(apenas RS)').first()).toBeVisible();

  await page.screenshot({ path: './screenshots/12-demographics-greyed.png' });
});
