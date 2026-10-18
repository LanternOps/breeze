// Page helpers for the Trust Center gated-document flow (#8770 W02d): the editor's documents/access sections
// and the anonymous portal pages. Selectors are data-testid only.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function pgContainer(): string {
  if (process.env.E2E_PG_CONTAINER) return process.env.E2E_PG_CONTAINER;
  const p = process.env.E2E_STACK_FILE ?? path.resolve(__dirname, '../..', '.breeze-stack.json');
  if (existsSync(p)) {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    if (d.pgContainer) return d.pgContainer;
  }
  return 'breeze-postgres';
}

/** Superuser psql inside the stack's Postgres (bypasses RLS). Values are interpolated by the CALLER: test data only. */
export function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

export const sha256Hex = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex');

/** A 48-char token from the nanoid alphabet, so the API's format check accepts it. */
export function knownToken(seed: string): string {
  return sha256Hex(seed).replace(/[^A-Za-z0-9]/g, '').slice(0, 48).padEnd(48, 'x');
}

/**
 * Tokens are mailed, never shown. The test swaps the stored hash of the request's live token for the hash of a
 * token it knows, which is exactly what the emailed link would have carried.
 */
export function plantToken(requestId: string, purpose: 'verify_email' | 'download', raw: string): void {
  const n = psql(`UPDATE trust_page_access_tokens SET token_hash = '${sha256Hex(raw)}'
    WHERE request_id = '${requestId}' AND purpose = '${purpose}' AND revoked_at IS NULL RETURNING id`);
  if (!n) throw new Error(`no live ${purpose} token for request ${requestId}`);
}

export class TrustAccessPage {
  constructor(private readonly page: Page) {}

  /** Library → Add → "Available on request" → confirm the gated disclosure → Save documents. */
  async linkGated(documentId: string): Promise<void> {
    const p = this.page;
    await p.getByTestId(`trust-doc-add-${documentId}`).click();
    await p.getByTestId('trust-doc-add-visibility').selectOption('gated');
    await p.getByTestId('trust-doc-disclosure-checkbox').check();
    await p.getByTestId('trust-doc-disclosure-confirm').click();
    await expect(p.getByTestId(`trust-doc-visibility-${documentId}`)).toHaveValue('gated');
    await p.getByTestId('trust-docs-save').click();
  }

  async requestAccess(o: { name: string; email: string; company: string; purpose: string }): Promise<void> {
    const p = this.page;
    await p.getByTestId('trust-request-access').click();
    await p.getByTestId('trust-access-name').fill(o.name);
    await p.getByTestId('trust-access-email').fill(o.email);
    await p.getByTestId('trust-access-company').fill(o.company);
    await p.getByTestId('trust-access-purpose').fill(o.purpose);
    await p.getByTestId('trust-access-submit').click();
    await expect(p.getByTestId('trust-access-submitted')).toBeVisible();
  }
}
