// Renders build/icon.svg and build/tray.svg to the PNG files used by the app
// and by electron-builder. Run with `node scripts/make-icons.mjs` (uses Playwright's Chromium).
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const targets = [
  ['build/icon.svg', 'build/icon.png', 1024, null],
  ['build/icon.svg', 'resources/icon.png', 256, null],
  ['build/tray.svg', 'resources/trayTemplate.png', 16, null],
  ['build/tray.svg', 'resources/trayTemplate@2x.png', 32, null],
  ['build/tray.svg', 'resources/tray-light.png', 32, '#f4f4f5'],
  ['build/icon.svg', 'resources/tray.png', 32, null],
];

// CHROMIUM_PATH lets the script reuse a system Chromium instead of Playwright's download.
const executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
for (const [source, output, size, tint] of targets) {
  let svg = await readFile(source, 'utf8');
  if (tint !== null) svg = svg.replaceAll('#000', tint);
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await writeFile(output, await page.screenshot({ omitBackground: true }));
  await page.close();
}
await browser.close();
