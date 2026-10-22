import { writeFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { QuotesPage } from '../pages/QuotesPage';
import { PortalVisibilityPage } from '../pages/PortalVisibilityPage';
import {
  apiJson, diffRatio, makeCoverPng, portalOrgId, presentInvoice, presentQuote, psqlAvailable, readAccessToken,
  type MatrixPageSize, type MatrixTheme,
} from '../helpers/documentMatrix';

/**
 * One Document Renderer — W4 screenshot matrix (#9414, spec §8.2).
 *
 *   kind {invoice, quote}
 *   × surface {web Preview, public link, logged-in portal}   (Preview is the reference; both portal surfaces are compared to it)
 *   × viewport {1280 desktop, 390 mobile}
 *   × theme {classic, condensed} × web density {compact, dense}
 *   × document locale {en, pt-BR}
 *   × page size {a4, letter}                                  (quotes only: the page size shapes the cover)
 *
 * REAL documents, one invoice and one proposal (with an uploaded cover image) created once; each
 * variant rewrites the document's frozen presentation columns (theme / page size / locale) in the
 * stack database and reloads the three surfaces. Every portal page runs under the production
 * `style-src-attr 'none'` directive (apps/portal/src/lib/csp.ts): the dev portal strips its CSP
 * (script hashes exist only in a production build), so, as in the W1/W2 slices, the one directive
 * that bears on the document is injected on the page response.
 *
 * Geometry assertions (quote, cover set): the cover frame's width:height equals the page's
 * (A4 1:1.414, Letter 1:1.294) on all three surfaces, and the title band starts at 62% of its height.
 */

const MAX_DIFF_RATIO = 0.02;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const enText = new Map<string, string>();
const COVER_ASPECT = { a4: 210 / 297, letter: 8.5 / 11 } as const;
const VIEWPORTS = [{ name: 'desktop', width: 1280, height: 3200, pin: 768 }, { name: 'mobile-390', width: 390, height: 3200, pin: 358 }] as const;
const DENSITIES = ['compact', 'dense'] as const;
const THEMES: MatrixTheme[] = ['classic', 'condensed'];
const LOCALES = ['en', 'pt-BR'] as const;

type Surface = 'public' | 'portal';
interface Row { kind: string; theme: string; pageSize: string; locale: string; viewport: string; density: string; surface: Surface; ratio: number; ok: boolean }

async function pin(root: Locator, width: number) {
  await root.evaluate((el, w) => { (el as HTMLElement).style.width = `${w}px`; (el as HTMLElement).style.maxWidth = `${w}px`; }, width);
}

/** Hide host chrome: floating bars outside the document, and the host-owned slots inside it (pay rail,
 *  signature panel), so the pair compares the document itself. */
async function isolate(page: Page) {
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="document-root"]');
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      const pos = getComputedStyle(el).position;
      if ((pos === 'fixed' || pos === 'sticky') && root && !el.contains(root) && !root.contains(el)) el.style.visibility = 'hidden';
    }
    document.querySelectorAll<HTMLElement>('[data-slot]').forEach((el) => { el.style.display = 'none'; });
    // Astro's dev toolbar exists only in a dev server, never in a production portal build.
    document.querySelectorAll<HTMLElement>('astro-dev-toolbar').forEach((el) => { el.style.display = 'none'; });
  });
}

/** Screenshots wait for what paints late: webfonts (the condensed theme's faces fetch on first use)
 *  and the cover/block images (authenticated fetch on the web, plain URL on the portal). */
async function settled(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.querySelectorAll('[data-testid="document-root"] img')).map(async (img) => {
      const i = img as HTMLImageElement;
      if (!i.complete) await new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); });
      if (i.decode) await i.decode().catch(() => undefined);
      // A broken image would screenshot as an alt-text box on every surface and still "match".
      if (!i.complete || i.naturalWidth === 0) throw new Error(`document image failed to load: ${i.currentSrc || i.getAttribute('src')}`);
    }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

async function watchCsp(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} <${(e.target as Element | null)?.tagName ?? '?'}>`));
  });
}
async function cspViolations(page: Page): Promise<string[]> {
  return (await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])).filter((v) => !v.includes('<ASTRO-DEV-TOOLBAR'));
}
async function enforceStyleAttrNone(page: Page, glob: string) {
  await page.route(glob, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': "style-src-attr 'none'" } });
  });
}

async function coverGeometry(page: Page): Promise<{ aspect: number; bandTopRatio: number } | null> {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>('[data-testid="document-cover-frame"]');
    const band = document.querySelector<HTMLElement>('[data-testid="document-cover-band"]');
    if (!frame || !band) return null;
    const f = frame.getBoundingClientRect(); const b = band.getBoundingClientRect();
    return { aspect: f.width / f.height, bandTopRatio: (b.top - f.top) / f.height };
  });
}

test.describe('document renderer — screenshot matrix (W4)', () => {
  test.skip(!psqlAvailable(), 'needs a wt-stack descriptor with a Postgres container (varies document presentation in the database)');

  test('invoice + proposal: Preview ↔ public ↔ logged-in portal across the matrix', async ({ authedPage, cleanPage, browser }, testInfo) => {
    test.setTimeout(1_800_000);
    const baseURL = testInfo.project.use.baseURL as string;
    const origin = new URL(baseURL).origin;
    // The first-run onboarding tour is host chrome that would dim the Preview: mark it already seen.
    await authedPage.addInitScript(() => { try { localStorage.setItem('breeze-onboarding-complete', 'true'); } catch { /* storage blocked */ } });
    const token = await readAccessToken(authedPage);
    const orgId = portalOrgId();

    // ---- fixtures: one issued invoice, one sent proposal with a cover image --------------------------
    const created = await apiJson<{ data: { id: string } }>(authedPage.request, token, 'post', '/api/v1/invoices', { orgId });
    const invoiceId = created.data.id;
    await apiJson(authedPage.request, token, 'post', `/api/v1/invoices/${invoiceId}/lines`, { name: 'Remote support', quantity: 1.5, unitPrice: 100, taxable: false });
    await apiJson(authedPage.request, token, 'post', `/api/v1/invoices/${invoiceId}/lines`, { name: 'Monthly monitoring', quantity: 1, unitPrice: 100, taxable: false });
    await apiJson(authedPage.request, token, 'post', `/api/v1/invoices/${invoiceId}/issue`, {});
    const link = await apiJson<{ data: { url: string } }>(authedPage.request, token, 'get', `/api/v1/invoices/${invoiceId}/public-link`);
    const invoiceToken = decodeURIComponent(new URL(link.data.url).pathname.split('/').filter(Boolean).pop()!);

    const quotes = new QuotesPage(authedPage);
    await quotes.goto();
    const quoteId = await quotes.create(orgId, `Matrix proposal ${Date.now()}`);
    await quotes.addManualPricingLine('Onboarding', '400.00');
    const upload = await authedPage.request.post(`/api/v1/quotes/${quoteId}/images`, {
      headers: { authorization: `Bearer ${token}` },
      multipart: { file: { name: 'cover.png', mimeType: 'image/png', buffer: await makeCoverPng(authedPage) } },
    });
    expect(upload.ok(), `cover upload → ${upload.status()}`).toBeTruthy();
    const { imageId } = ((await upload.json()) as { data: { imageId: string } }).data;
    await apiJson(authedPage.request, token, 'patch', `/api/v1/quotes/${quoteId}`, {
      coverPage: { enabled: true, showPreparedBy: true, title: 'Network refresh proposal', coverImageId: imageId, preparedForName: 'Acme Dental' },
    });
    await quotes.sendButton().click();
    await quotes.sendConfirm().waitFor();
    await authedPage.getByTestId('quote-send-to').fill('e2e-recipient@example.com');
    await Promise.all([
      authedPage.waitForResponse((r) => r.request().method() === 'POST' && /\/quotes\/[^/]+\/schedule-send$/.test(new URL(r.url()).pathname), { timeout: 20_000 }),
      quotes.sendConfirm().click(),
    ]);
    const [sent] = await Promise.all([
      authedPage.waitForResponse((r) => r.request().method() === 'POST' && /\/quotes\/[^/]+\/send$/.test(new URL(r.url()).pathname), { timeout: 30_000 }),
      quotes.sendNow().click(),
    ]);
    expect(sent.ok()).toBeTruthy();
    const quoteToken = decodeURIComponent(((await sent.json()) as { data: { acceptUrl: string } }).data.acceptUrl.split('/').filter(Boolean).pop()!);

    // ---- portal customer session (own context: its own refresh family) --------------------------------
    const portalCtx = await browser.newContext({ baseURL });
    const portalPage = await portalCtx.newPage();
    await new PortalVisibilityPage(portalPage).login('portal@breeze.local', 'PortalTest123!');
    for (const p of [cleanPage, portalPage]) await watchCsp(p);

    const rows: Row[] = [];
    const geometry: Array<Record<string, unknown>> = [];
    const cspSeen: string[] = [];
    try {
      const kinds = [
        { kind: 'invoice', id: invoiceId, previewUrl: `/billing/invoices/${invoiceId}#preview`, publicUrl: `${origin}/portal/invoice/${invoiceToken}`, portalUrl: `${origin}/portal/invoices/${invoiceId}`, pageSizes: ['letter'] as MatrixPageSize[] },
        { kind: 'quote', id: quoteId, previewUrl: `/billing/quotes/${quoteId}#preview`, publicUrl: `${origin}/portal/quote/${quoteToken}`, portalUrl: `${origin}/portal/quotes/${quoteId}`, pageSizes: ['a4', 'letter'] as MatrixPageSize[] },
      ];
      await enforceStyleAttrNone(cleanPage, '**/portal/invoice/**');
      await enforceStyleAttrNone(cleanPage, '**/portal/quote/**');
      await enforceStyleAttrNone(portalPage, '**/portal/invoices/**');
      await enforceStyleAttrNone(portalPage, '**/portal/quotes/**');

      for (const k of kinds) {
        for (const theme of THEMES) {
          for (const pageSize of k.pageSizes) {
            for (const locale of LOCALES) {
              const label = `${k.kind} ${theme} ${pageSize} ${locale}`;
              await test.step(label, async () => {
                if (k.kind === 'invoice') presentInvoice(k.id, theme, pageSize, locale); else presentQuote(k.id, theme, pageSize, locale);
                await authedPage.setViewportSize({ width: 1280, height: 3200 });
                await cleanPage.setViewportSize({ width: 1280, height: 3200 });
                await portalPage.setViewportSize({ width: 1280, height: 3200 });
                await authedPage.goto(k.previewUrl);
                await authedPage.reload();
                await cleanPage.goto(k.publicUrl);
                await portalPage.goto(k.portalUrl);
                const roots = { preview: authedPage.getByTestId('document-root'), public: cleanPage.getByTestId('document-root'), portal: portalPage.getByTestId('document-root') };
                for (const r of Object.values(roots)) await expect(r).toBeVisible({ timeout: 30_000 });
                for (const p of [authedPage, cleanPage, portalPage]) await isolate(p);
                await expect(roots.public).toHaveAttribute('data-doc-theme', theme);
                await expect(roots.preview).toHaveAttribute('data-doc-theme', theme);
                await expect(roots.portal).toHaveAttribute('data-doc-theme', theme);
                // Locale: all three surfaces must read the same words, and pt-BR must differ from en
                // (otherwise a database write that did not take would pass every pixel comparison).
                const text = { preview: await roots.preview.innerText(), public: await roots.public.innerText(), portal: await roots.portal.innerText() };
                expect.soft(norm(text.public), `${label}: public text equals Preview`).toBe(norm(text.preview));
                expect.soft(norm(text.portal), `${label}: portal text equals Preview`).toBe(norm(text.preview));
                const key = `${k.kind}|${theme}|${pageSize}`;
                if (locale === 'en') enText.set(key, norm(text.preview));
                else expect.soft(norm(text.preview), `${label}: pt-BR text differs from en`).not.toBe(enText.get(key));

                for (const vp of VIEWPORTS) {
                  for (const p of [authedPage, cleanPage, portalPage]) await p.setViewportSize({ width: vp.width, height: vp.height });
                  for (const r of Object.values(roots)) await pin(r, vp.pin);
                  for (const density of DENSITIES) {
                    await authedPage.evaluate((d) => document.documentElement.setAttribute('data-density', d), density);
                    // The web onboarding tour pops a fixed card + dimmer in after load and again on a
                    // viewport change; it is host chrome, so sweep it out right before every capture.
                    for (const p of [authedPage, cleanPage, portalPage]) { await isolate(p); await settled(p); }
                    const shot = {
                      preview: await roots.preview.screenshot(),
                      public: await roots.public.screenshot(),
                      portal: await roots.portal.screenshot(),
                    };
                    for (const surface of ['public', 'portal'] as const) {
                      const ratio = await diffRatio(authedPage, shot.preview, shot[surface]);
                      const ok = ratio <= MAX_DIFF_RATIO;
                      rows.push({ kind: k.kind, theme, pageSize, locale, viewport: vp.name, density, surface, ratio, ok });
                      expect.soft(ratio, `${label} ${vp.name} ${density} Preview↔${surface}`).toBeLessThanOrEqual(MAX_DIFF_RATIO);
                    }
                    const failing = rows.slice(-2).some((r) => !r.ok);
                    if (failing) {
                      const stem = `FAIL-${k.kind}-${theme}-${pageSize}-${locale}-${vp.name}-${density}`;
                      for (const s of ['preview', 'public', 'portal'] as const) writeFileSync(testInfo.outputPath(`${stem}-${s}.png`), shot[s]);
                    }
                    if (density === 'compact') {
                      const stem = `${k.kind}-${theme}-${pageSize}-${locale}-${vp.name}`;
                      await testInfo.attach(`${stem}-preview.png`, { body: shot.preview, contentType: 'image/png' });
                      await testInfo.attach(`${stem}-public.png`, { body: shot.public, contentType: 'image/png' });
                    }
                  }
                  if (k.kind === 'quote') {
                    for (const [name, p] of [['preview', authedPage], ['public', cleanPage], ['portal', portalPage]] as const) {
                      const g = await coverGeometry(p);
                      geometry.push({ theme, pageSize, locale, viewport: vp.name, surface: name, ...g });
                      expect.soft(g, `${label} ${vp.name} ${name}: cover frame present`).not.toBeNull();
                      if (g) {
                        expect.soft(g.aspect, `${label} ${vp.name} ${name}: cover aspect`).toBeCloseTo(COVER_ASPECT[pageSize], 2);
                        expect.soft(g.bandTopRatio, `${label} ${vp.name} ${name}: band top`).toBeCloseTo(0.62, 2);
                      }
                    }
                  }
                }
                cspSeen.push(...(await cspViolations(cleanPage)).map((v) => `${label} public: ${v}`), ...(await cspViolations(portalPage)).map((v) => `${label} portal: ${v}`));
              });
            }
          }
        }
      }
    } finally {
      // Written even when a hard failure aborts the loop, so a partial run is still readable.
      const bad = rows.filter((r) => !r.ok);
      const summary = {
        variantsRun: rows.length / 2,
        comparisons: rows.length,
        failed: bad.length,
        worstRatio: rows.length ? Math.max(...rows.map((r) => r.ratio)) : null,
        tolerance: MAX_DIFF_RATIO,
        cspViolations: cspSeen,
        rows,
        geometry,
      };
      writeFileSync(testInfo.outputPath('matrix-results.json'), JSON.stringify(summary, null, 2));
      await testInfo.attach('matrix-results.json', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
      await portalCtx.close();
    }

    // The matrix must be complete, not merely green: 12 document tuples × 2 viewports × 2 densities × 2 portal surfaces.
    expect(rows).toHaveLength(96);
    expect(rows.filter((r) => !r.ok)).toEqual([]);
    expect(cspSeen).toEqual([]);
  });
});
