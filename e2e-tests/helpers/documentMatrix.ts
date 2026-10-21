import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type APIRequestContext, type Page, type Request } from '@playwright/test';

/**
 * Helpers for the One Document Renderer screenshot matrix (#9414 W4, spec §8.2).
 *
 * The matrix drives REAL documents (the public quote page is server-rendered, so its API call
 * cannot be intercepted) and varies theme / page size / locale by writing the document's
 * frozen presentation columns straight into the wt-stack database, exactly the columns the
 * render path reads. That needs the stack descriptor's Postgres container; `psqlAvailable()`
 * lets the spec skip cleanly anywhere that is not a wt-stack.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

function descriptor(): { pgContainer?: string } | null {
  const p = process.env.E2E_STACK_FILE ?? path.resolve(here, '..', '..', '.breeze-stack.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

export function psqlAvailable(): boolean {
  return Boolean(descriptor()?.pgContainer);
}

/** Run one SQL statement as the stack's database owner (bypasses RLS: fixture setup only). */
export function psql(sql: string): string {
  const container = descriptor()?.pgContainer;
  if (!container) throw new Error('no pgContainer in the stack descriptor');
  return execFileSync('docker', ['exec', container, 'psql', '-U', 'breeze', '-d', 'breeze', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
}

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

export type MatrixTheme = 'classic' | 'condensed';
export type MatrixPageSize = 'a4' | 'letter';

export function presentInvoice(id: string, theme: MatrixTheme, pageSize: MatrixPageSize, locale: string): void {
  expectOneRow(psql(`UPDATE invoices SET document_theme=${q(theme)}, document_page_size=${q(pageSize)}, document_locale=${q(locale)} WHERE id=${q(id)}`), 'invoice');
}

/** `psql -c UPDATE` exits 0 on "UPDATE 0": a variant switch that matched nothing must not pass silently. */
function expectOneRow(out: string, what: string): void {
  if (!/UPDATE 1$/.test(out)) throw new Error(`${what} presentation update matched no row (psql said "${out}")`);
}

export function presentQuote(id: string, theme: MatrixTheme, pageSize: MatrixPageSize, locale: string): void {
  const snapshot = JSON.stringify({ theme, pageSize });
  expectOneRow(psql(`UPDATE quotes SET presentation_snapshot=${q(snapshot)}::jsonb, document_locale=${q(locale)} WHERE id=${q(id)}`), 'quote');
}

export function portalOrgId(): string {
  const id = psql(`SELECT org_id FROM portal_users WHERE email='portal@breeze.local'`);
  if (!id) throw new Error('no seeded portal user (portal@breeze.local) — run the e2e seed');
  return id;
}

/** The access token the app itself is using, lifted off one of its own API requests (see multi-currency.spec.ts). */
export async function readAccessToken(page: Page): Promise<string> {
  let token: string | null = null;
  const onRequest = (req: Request) => {
    if (token) return;
    const header = req.headers()['authorization'];
    if (header?.startsWith('Bearer ') && req.url().includes('/api/v1/')) token = header.slice(7);
  };
  page.on('request', onRequest);
  try {
    await page.goto('/');
    await expect.poll(() => token, { message: 'an authenticated /api/v1 request from the app', timeout: 30_000 }).toBeTruthy();
  } finally {
    page.off('request', onRequest);
  }
  return token!;
}

export async function apiJson<T>(request: APIRequestContext, token: string, method: 'get' | 'post' | 'patch', url: string, data?: unknown): Promise<T> {
  const res = await request[method](url, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method.toUpperCase()} ${url} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

/** A 1200×800 landscape gradient with a hard marker stripe, drawn in the browser (no image library). */
export async function makeCoverPng(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1200; c.height = 800;
    const ctx = c.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 1200, 800);
    g.addColorStop(0, '#1d4ed8'); g.addColorStop(1, '#0f766e');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 1200, 800);
    ctx.fillStyle = '#f59e0b'; ctx.fillRect(500, 0, 200, 800);
    return c.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(b64, 'base64');
}

/** Fraction of pixels differing by more than a small per-channel threshold, computed in the browser. */
export async function diffRatio(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(async ([x, y]) => {
    const load = (b64: string) => new Promise<HTMLImageElement>((res, rej) => {
      const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = `data:image/png;base64,${b64}`;
    });
    const [ia, ib] = await Promise.all([load(x), load(y)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return 1;
    const px = (img: HTMLImageElement) => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, img.width, img.height).data;
    };
    const da = px(ia), db = px(ib);
    let diff = 0;
    for (let i = 0; i < da.length; i += 4) {
      if (Math.abs(da[i] - db[i]) > 24 || Math.abs(da[i + 1] - db[i + 1]) > 24 || Math.abs(da[i + 2] - db[i + 2]) > 24) diff++;
    }
    return diff / (da.length / 4);
  }, [a.toString('base64'), b.toString('base64')] as const);
}
