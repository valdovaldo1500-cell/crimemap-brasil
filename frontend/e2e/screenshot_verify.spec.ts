import { test } from '@playwright/test';

test('capture toolbar and bottom-right from production', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // Go directly to production
  await page.goto('https://crimebrasil.com.br', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(4000);

  // Full screenshot
  await page.screenshot({ path: '/tmp/full_page.png' });

  // Toolbar top area
  await page.screenshot({
    path: '/tmp/toolbar_area.png',
    clip: { x: 0, y: 0, width: 1280, height: 130 }
  });

  // Bottom-right area
  await page.screenshot({
    path: '/tmp/bottom_right.png',
    clip: { x: 800, y: 780, width: 480, height: 120 }
  });

  // Check positions of Regiões and Pontos buttons
  const viewToggle = await page.evaluate(() => {
    const allText = Array.from(document.querySelectorAll('button, span, div'));
    const regioes = allText.find(el => el.textContent?.trim() === 'Regiões' && (el as HTMLElement).offsetWidth > 0);
    const pontos = allText.find(el => el.textContent?.trim() === 'Pontos' && (el as HTMLElement).offsetWidth > 0);
    if (regioes && pontos) {
      const rRect = regioes.getBoundingClientRect();
      const pRect = pontos.getBoundingClientRect();
      return {
        regioes: { x: Math.round(rRect.x), y: Math.round(rRect.y) },
        pontos: { x: Math.round(pRect.x), y: Math.round(pRect.y) },
        regioesBeforePontos: rRect.x < pRect.x
      };
    }
    return { error: 'Could not find both elements' };
  });
  console.log('VIEW TOGGLE POSITIONS:', JSON.stringify(viewToggle));

  // Check for "Designed by" text
  const designedBy = await page.evaluate(() => {
    const allElements = Array.from(document.querySelectorAll('*'));
    return allElements
      .filter(el => {
        const text = el.textContent?.trim() || '';
        const hasNoChildren = el.children.length === 0;
        const isVisible = (el as HTMLElement).offsetWidth > 0;
        return (text.toLowerCase().includes('designed') || text.toLowerCase().includes('i.l.s')) && hasNoChildren && isVisible;
      })
      .map(el => ({
        text: el.textContent?.trim(),
        tag: el.tagName,
        color: window.getComputedStyle(el as HTMLElement).color
      }));
  });
  console.log('DESIGNED BY ELEMENTS:', JSON.stringify(designedBy));

  // Check all links in bottom area
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a')).map(a => ({
      text: a.textContent?.trim(),
      href: a.href,
      color: window.getComputedStyle(a).color,
      rect: { x: Math.round(a.getBoundingClientRect().x), y: Math.round(a.getBoundingClientRect().y) }
    })).filter(a => a.text && a.rect.y > 700);
  });
  console.log('BOTTOM LINKS:', JSON.stringify(links));
});
