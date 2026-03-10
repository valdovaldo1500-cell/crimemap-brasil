import { Page } from '@playwright/test';
import * as path from 'path';

const BLANK_TILE = path.resolve(__dirname, '../fixtures/blank-tile.png');

/**
 * Mock map tile requests with a blank grey tile.
 * Call before navigating to the page. Prevents non-deterministic tile
 * rendering that causes flaky screenshot comparisons.
 */
export async function mockMapTiles(page: Page): Promise<void> {
  // CartoDB basemap tiles
  await page.route('**/*.basemaps.cartocdn.com/**', route =>
    route.fulfill({
      path: BLANK_TILE,
      contentType: 'image/png',
    })
  );

  // OpenStreetMap fallback tiles
  await page.route('**://tile.openstreetmap.org/**', route =>
    route.fulfill({
      path: BLANK_TILE,
      contentType: 'image/png',
    })
  );

  // Any other common tile providers
  await page.route('**://tiles.stadiamaps.com/**', route =>
    route.fulfill({
      path: BLANK_TILE,
      contentType: 'image/png',
    })
  );
}

/**
 * Disable Leaflet animations for deterministic test behavior.
 * Call after the page has loaded and the map is initialized.
 */
export async function disableMapAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Disable zoom/pan animations globally
    const L = (window as any).L;
    if (L?.Map?.prototype?.options) {
      L.Map.prototype.options.zoomAnimation = false;
      L.Map.prototype.options.fadeAnimation = false;
      L.Map.prototype.options.markerZoomAnimation = false;
    }
  });
}

/**
 * Take a screenshot of just the map overlay pane (polygons/markers),
 * excluding tiles. Uses tight pixel diff threshold.
 */
export async function screenshotOverlay(page: Page): Promise<Buffer> {
  const overlay = page.locator('.leaflet-overlay-pane');
  return await overlay.screenshot();
}
