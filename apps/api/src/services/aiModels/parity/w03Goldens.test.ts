import { beforeAll, describe, expect, it, vi } from 'vitest';

// Same hoisted mocks as W02's parity.test.ts: they route the legacy oracle's DB reads to the fixture.
vi.mock('../../../db', async () => (await import('./legacyFixtureMocks')).legacyDbMockModule());
vi.mock('../../llmProviderCatalog', async () => (await import('./legacyFixtureMocks')).legacyCatalogMockModule());
vi.mock('../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: vi.fn() }));
vi.mock('../../sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { writeFileSync } from 'node:fs';
import { bindLegacyFixture } from './bindLegacyFixture';
import { PARITY_FIXTURES } from './fixtures';
import { parityQueries } from './harness';
import { legacySurfaceUse, withFixtureEnv } from './legacyOracle';
import { W03_GOLDENS_PATH, loadW03Goldens, queryKey, type W03Goldens } from './w03Parity';

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = 'parity-unit-test-key-material';
  process.env.APP_ENCRYPTION_KEY_ID = 'parity-test';
  process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
});

describe('W03 legacy goldens (frozen before the cutover deletes the legacy code)', () => {
  it('every W02 fixture × query matches the committed golden', async () => {
    const live: W03Goldens = {};
    for (const fixture of PARITY_FIXTURES) {
      bindLegacyFixture(fixture);
      live[fixture.name] = {};
      await withFixtureEnv(fixture.env, async () => {
        for (const query of parityQueries(fixture)) {
          live[fixture.name]![queryKey(query)] = await legacySurfaceUse(fixture, query);
        }
      });
    }
    if (process.env.UPDATE_W03_GOLDENS === '1') writeFileSync(W03_GOLDENS_PATH, `${JSON.stringify(live, null, 2)}\n`);
    expect(live).toEqual(loadW03Goldens());
  });
});
