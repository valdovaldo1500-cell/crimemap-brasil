import { test } from '@playwright/test';
test('disabled states close-up', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('https://crimebrasil.com.br/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: '/tmp/ss-disabled-states.png' });
});
