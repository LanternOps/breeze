import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Spec §3: each source's fix link must land on a real web page, and its hash
// on a tab that page actually owns (IntegrationsPage.tsx parses the hash).
vi.mock('../../../db', () => ({ db: {} }));

import { HEALTH_SOURCES } from './index';

const WEB_SRC = path.resolve(__dirname, '../../../../../web/src');

/** Files whose source holds the hash ids a page accepts, quoted (e.g. `id: "huntress"`). */
const HASH_OWNERS: Record<string, string[]> = {
  '/integrations': ['components/integrations/IntegrationsPage.tsx', 'lib/accountingProviders.ts'],
  '/settings/ticketing': ['components/settings/TicketingSettingsTabs.tsx'],
};

function pageExists(routePath: string): boolean {
  const base = path.join(WEB_SRC, 'pages', routePath);
  return existsSync(`${base}.astro`) || existsSync(path.join(base, 'index.astro'));
}

const hrefs = [...new Set(HEALTH_SOURCES.flatMap((s) => s.fixHrefs.map((h) => [s.kind, h] as const)))];

describe('connection health fix links', () => {
  it('the web tree is where the test expects it', () => {
    expect(existsSync(path.join(WEB_SRC, 'pages/integrations/index.astro'))).toBe(true);
  });

  it.each(hrefs)('%s → %s', (_kind, href) => {
    expect(href.startsWith('/') && !href.startsWith('//')).toBe(true);
    const [routePath, hash] = href.split('#') as [string, string | undefined];
    expect(pageExists(routePath), `no page for ${routePath}`).toBe(true);
    if (hash) {
      const owners = HASH_OWNERS[routePath];
      expect(owners, `no hash owner registered for ${routePath}`).toBeDefined();
      const sources = owners!.map((f) => readFileSync(path.join(WEB_SRC, f), 'utf8')).join('\n');
      expect(sources.includes(`"${hash}"`) || sources.includes(`'${hash}'`), `#${hash} is not a tab of ${routePath}`).toBe(true);
    }
  });
});
