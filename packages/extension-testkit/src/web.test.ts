// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { parseDeviceDetailTabContextV1 } from '@breeze/extension-web-sdk';
import { assertWebContributionConformance } from './web';

// Each test uses unique element names because the custom-element registry is
// global to the happy-dom window and persists across `it` blocks.
function manifestFor(page: string, slot: string): Record<string, unknown> {
  return {
    web: {
      pages: [{ path: '/x', element: page }],
      slots: [{ slot: 'device-detail-tab', contractVersion: 1, element: slot }],
    },
  };
}

function defineOnce(name: string): void {
  if (!customElements.get(name)) {
    customElements.define(name, class extends HTMLElement {});
  }
}

describe('assertWebContributionConformance', () => {
  it('passes when declared elements are registered and the entry is idempotent', async () => {
    const result = await assertWebContributionConformance({
      manifest: manifestFor('acme-page-a', 'acme-tab-a'),
      loadEntry: () => {
        defineOnce('acme-page-a');
        defineOnce('acme-tab-a');
      },
      contracts: [{ label: 'device-detail-tab', parse: parseDeviceDetailTabContextV1, badInput: {} }],
    });
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it('flags an element the manifest declares but the entry never registers', async () => {
    const result = await assertWebContributionConformance({
      manifest: manifestFor('acme-page-b', 'acme-tab-b'),
      loadEntry: () => {
        defineOnce('acme-page-b'); // acme-tab-b intentionally omitted
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'element_not_registered')).toBe(true);
  });

  it('flags a host-context contract that accepts invalid input', async () => {
    const result = await assertWebContributionConformance({
      manifest: manifestFor('acme-page-c', 'acme-tab-c'),
      loadEntry: () => {
        defineOnce('acme-page-c');
        defineOnce('acme-tab-c');
      },
      contracts: [{ label: 'permissive', parse: (input) => input, badInput: {} }],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'context_not_validated')).toBe(true);
  });

  it('flags a declared element already defined before the entry loaded', async () => {
    // Someone else (a prior test / import / other extension) already defined it.
    customElements.define('acme-page-e', class extends HTMLElement {});
    const result = await assertWebContributionConformance({
      manifest: manifestFor('acme-page-e', 'acme-tab-e'),
      loadEntry: () => {
        defineOnce('acme-tab-e'); // entry registers the tab, but never the pre-existing page
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'element_preexisting')).toBe(true);
  });

  it('allows a pre-existing element when the caller opts in', async () => {
    customElements.define('acme-page-f', class extends HTMLElement {});
    const result = await assertWebContributionConformance({
      manifest: manifestFor('acme-page-f', 'acme-tab-f'),
      loadEntry: () => {
        defineOnce('acme-tab-f');
      },
      allowPreexistingElements: true,
    });
    expect(result.issues.some((issue) => issue.code === 'element_preexisting')).toBe(false);
  });

  it('flags an entry whose element definitions are not idempotent', async () => {
    let loads = 0;
    const result = await assertWebContributionConformance({
      manifest: manifestFor('acme-page-d', 'acme-tab-d'),
      loadEntry: () => {
        loads += 1;
        // Unguarded define: first load registers, second load throws.
        customElements.define('acme-page-d', class extends HTMLElement {});
        defineOnce('acme-tab-d');
      },
    });
    expect(loads).toBe(2);
    expect(result.issues.some((issue) => issue.code === 'entry_not_idempotent')).toBe(true);
  });
});
