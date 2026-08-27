import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVENT_SUBSCRIBER_IDS } from './eventSubscriberIds';

/**
 * Source-scan style contract test (pattern: eventBus.types.test.ts).
 *
 * A subscriber that is BOTH legacy-`subscribe()`d on the global event bus AND
 * registered on the durable registry fires TWICE for every event — once via
 * eventBus.ts's legacy handler map, once via the registry-aware path added in
 * Task 2. This is the guard against that: none of the five production modules
 * migrated in Task 3 may call `.subscribe(` on the global bus any more.
 */
const PRODUCTION_MODULES = [
  '../workers/webhookDelivery.ts',
  '../jobs/automationWorker.ts',
  './policyAlertBridge.ts',
  './notificationDispatcher.ts',
  './dnsThreatAlerts.ts',
] as const;

const SUBSCRIBE_ON_GLOBAL_BUS = /getEventBus\(\)\.subscribe|eventBus\.subscribe/;

function readModule(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

describe('five subscribers migrated off the legacy bus (#4085 Task 3)', () => {
  it.each(PRODUCTION_MODULES)('%s no longer calls .subscribe( on the global event bus', (path) => {
    const src = readModule(path);
    expect(src).not.toMatch(SUBSCRIBE_ON_GLOBAL_BUS);
  });
});

describe('eventSubscribers.ts registers every id in EVENT_SUBSCRIBER_IDS exactly once', () => {
  const src = readModule('./eventSubscribers.ts');

  it('the source was actually parsed (guards the regex itself)', () => {
    // Without this, a reformat that breaks the regex leaves matches empty and
    // "every id registered exactly once" passes vacuously.
    expect(EVENT_SUBSCRIBER_IDS.length).toBeGreaterThan(0);
    expect(src).toContain('registerEventSubscriber');
  });

  it('every id appears in a registerEventSubscriber({ id: ... }) block exactly once', () => {
    for (const id of EVENT_SUBSCRIBER_IDS) {
      const idLiteral = `id: '${id}'`;
      const occurrences = src.split(idLiteral).length - 1;
      expect(occurrences, `expected exactly one "${idLiteral}" in eventSubscribers.ts`).toBe(1);
    }
  });

  it('registers no id outside EVENT_SUBSCRIBER_IDS', () => {
    const matches = Array.from(src.matchAll(/id:\s*'([a-z0-9-]+)'/g), (m) => m[1]);
    expect(matches.length).toBeGreaterThan(0);
    for (const id of matches) {
      expect(EVENT_SUBSCRIBER_IDS as readonly string[]).toContain(id);
    }
  });
});
