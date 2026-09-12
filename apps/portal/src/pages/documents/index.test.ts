import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./index.astro', import.meta.url), 'utf8');
const componentSource = readFileSync(
  new URL('../../components/portal/DocumentLibrary.tsx', import.meta.url), 'utf8');

describe('documents page', () => {
  it('bounces a page the MSP switched off', () => {
    expect(pageSource).toContain('redirectToPortalHomeAfterDisabled(Astro)');
  });
  it('redirects on 401 before rendering', () => {
    expect(pageSource).toContain('redirectToLoginAfter401(Astro)');
  });
  it('never prints a raw transport error at the customer', () => {
    expect(pageSource).not.toMatch(/\{response\.error\}/);
    expect(pageSource).toContain('data-testid="portal-documents-error"');
    expect(pageSource).toContain("We couldn't load your documents just now. Your IT team can help.");
  });
  it('downloads through the API path, never a presigned url', () => {
    expect(componentSource).toContain('portalApi.documentContentUrl');
    expect(componentSource).not.toMatch(/https?:\/\//);
  });
  it('gives every list, row and download a testid', () => {
    expect(componentSource).toContain('data-testid="portal-documents-groups"');
    expect(componentSource).toContain('data-testid="portal-documents-empty"');
    expect(componentSource).toMatch(/data-testid=\{`portal-document-row-\$\{/);
    expect(componentSource).toMatch(/data-testid=\{`portal-document-download-\$\{/);
  });
});
