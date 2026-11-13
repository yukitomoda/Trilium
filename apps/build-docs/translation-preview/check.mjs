import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = (process.env.PREVIEW_URL ?? 'http://127.0.0.1:9001').replace(/\/$/, '');
const basePath = new URL(origin).pathname.replace(/\/$/, '');
const manifest = await (await fetch(`${origin}/manifest.json`)).json();
assert.ok(['identity', 'translation'].includes(manifest.mode));
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
        if (response.url().startsWith(origin) && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    for (const entry of manifest.pages) {
        const path = entry.path === '/user-guide' ? '/user-guide/' : `${entry.path}.html`;
        await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
        assert.equal(await page.locator('html').getAttribute('lang'), 'ja');
        assert.match(await page.locator('.translation-notice').innerText(), /非公式/);
        assert.equal(await page.locator('.translation-actions a').getAttribute('href'), entry.sourceUrl);
        assert.match(await page.locator('#translation-status').innerText(), /未翻訳|非公式|まだ行っていません/);
        const body = await page.locator('#translation-body').innerText();
        await page.locator('#translation-toggle').click();
        assert.equal(await page.locator('#translation-toggle').getAttribute('aria-pressed'), 'true');
        assert.match(await page.locator('#translation-status').innerText(), /原文を表示中/);
        assert.equal(await page.locator('#translation-body').getAttribute('lang'), 'en');
        const expectedOriginal = await page.locator('#translation-original').evaluate(template => template.innerHTML);
        assert.equal(await page.locator('#translation-body').innerHTML(), expectedOriginal);
        await page.locator('#translation-toggle').click();
        assert.equal(await page.locator('#translation-toggle').getAttribute('aria-pressed'), 'false');
        assert.equal(await page.locator('#translation-body').innerText(), body);
        const images = await page.locator('#translation-body img').evaluateAll(images => images.map(image => ({ src: image.src, ok: image.complete && image.naturalWidth > 0 })));
        assert.ok(images.every(image => image.ok), JSON.stringify(images));
        const links = await page.locator('a[href]').evaluateAll(links => links.map(link => link.href));
        for (const link of new Set(links)) {
            if (new URL(link).origin !== new URL(origin).origin) continue;
            assert.ok(!basePath || new URL(link).pathname.startsWith(`${basePath}/`),
                `Link escaped Pages base path: ${link}`);
            const response = await fetch(link);
            assert.ok(response.ok, `Broken local link: ${link} (${response.status})`);
        }
        console.log(`OK ${entry.title}: banner, source link, toggle, images, local links`);
    }
    await page.goto(`${origin}/user-guide/`, { waitUntil: 'networkidle' });
    await page.locator(`#translation-body a[href="${basePath}/user-guide/quick-start.html"]`).click();
    await page.waitForURL(`${origin}/user-guide/quick-start.html`);
    const searchIndex = await (await fetch(`${origin}/user-guide/search-index.json`)).json();
    const quickTitle = searchIndex.find(entry => entry.id === 'quick-start.html').title;
    assert.equal(await page.locator('#title').innerText(), quickTitle);
    await page.goto(`${origin}/user-guide/`, { waitUntil: 'networkidle' });
    await page.locator('.search-input').fill(quickTitle);
    await page.locator('.search-input').press('ArrowRight');
    await page.locator('.search-result-item').first().waitFor();
    assert.ok((await page.locator('.search-result-item').first().innerText()).includes(quickTitle));
    await page.reload({ waitUntil: 'networkidle' });
    await page.screenshot({ path: '/tmp/docs-ja-preview-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'networkidle' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile horizontal overflow');
    await page.locator('#translation-toggle').click();
    assert.equal(await page.locator('#translation-toggle').getAttribute('aria-pressed'), 'true');
    await page.screenshot({ path: '/tmp/docs-ja-preview-mobile.png', fullPage: true });
    assert.deepEqual(errors, [], 'Browser or asset errors');
    console.log(`OK search and mobile layout; ${manifest.pages.length} pages checked`);
} finally {
    await browser.close();
}
