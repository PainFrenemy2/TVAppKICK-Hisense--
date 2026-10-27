// Генерация плиток для установки через hisense://debug (как у Netflix/YouTube на главном экране VIDAA):
// node tools/make-icons.js
const { chromium } = require('playwright');
const path = require('path');

const root = path.join(__dirname, '..');
const fontUrl = 'data:font/woff2;base64,' + require('fs').readFileSync(path.join(root, 'fonts/inter-latin-700-normal.woff2')).toString('base64');
const mark = '<svg viewBox="0 0 24 24" style="height:100%;display:block"><g fill="#53fc18"><rect x="3" y="3" width="3.3" height="3.3"/><rect x="3" y="6" width="3.3" height="3.3"/><rect x="3" y="9" width="3.3" height="3.3"/><rect x="3" y="12" width="3.3" height="3.3"/><rect x="3" y="15" width="3.3" height="3.3"/><rect x="3" y="18" width="3.3" height="3.3"/><rect x="6" y="3" width="3.3" height="3.3"/><rect x="6" y="6" width="3.3" height="3.3"/><rect x="6" y="9" width="3.3" height="3.3"/><rect x="6" y="12" width="3.3" height="3.3"/><rect x="6" y="15" width="3.3" height="3.3"/><rect x="6" y="18" width="3.3" height="3.3"/><rect x="9" y="9" width="3.3" height="3.3"/><rect x="9" y="12" width="3.3" height="3.3"/><rect x="12" y="6" width="3.3" height="3.3"/><rect x="12" y="9" width="3.3" height="3.3"/><rect x="12" y="12" width="3.3" height="3.3"/><rect x="12" y="15" width="3.3" height="3.3"/><rect x="15" y="3" width="3.3" height="3.3"/><rect x="15" y="6" width="3.3" height="3.3"/><rect x="15" y="15" width="3.3" height="3.3"/><rect x="15" y="18" width="3.3" height="3.3"/><rect x="18" y="3" width="3.3" height="3.3"/><rect x="18" y="6" width="3.3" height="3.3"/><rect x="18" y="15" width="3.3" height="3.3"/><rect x="18" y="18" width="3.3" height="3.3"/></g></svg>';

// Плитка: чёрный фон Kick, зелёный знак + слово «kick»
const tile = (w, h) => `<html><head><style>
  @font-face{font-family:I;font-weight:700;src:url(${fontUrl})}
  body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#0b0e0f;
    display:flex;align-items:center;justify-content:center;font-family:I,Arial,sans-serif;color:#fff}
  .g{height:${h * 0.34}px}
  .t{font-size:${h * 0.27}px;font-weight:700;letter-spacing:${-h * 0.006}px;margin-left:${h * 0.06}px;margin-top:-${h * 0.04}px}
</style></head><body><div class="g">${mark}</div><div class="t" style="color:#53fc18">kick</div></body></html>`;

// Квадратный значок: только знак K
const square = (s) => `<html><body style="margin:0;width:${s}px;height:${s}px;background:#0b0e0f;display:flex;align-items:center;justify-content:center">
  <div style="height:${s * 0.56}px">${mark}</div></body></html>`;

(async () => {
  const browser = await chromium.launch();
  const shot = async (html, w, h, file) => {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(root, 'icons', file) });
    await page.close();
    console.log('icons/' + file, w + 'x' + h);
  };
  // ТВ растягивает картинку под плитку — даём с запасом по разрешению, чтобы не было «лесенки»
  await shot(tile(1280, 720), 1280, 720, 'thumbnail.png');
  await shot(tile(1280, 720), 1280, 720, 'icon-large.png');
  await shot(tile(800, 450), 800, 450, 'icon-small.png');
  await shot(square(512), 512, 512, 'icon-square.png');
  await browser.close();
})();
