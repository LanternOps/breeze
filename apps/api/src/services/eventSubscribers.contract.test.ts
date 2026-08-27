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
 *
 * Two independent assertions, deliberately redundant with each other:
 *
 * 1. No `.subscribe(` call at all, under ANY receiver name. The original
 *    guard here (`getEventBus\(\)\.subscribe|eventBus\.subscribe`) only
 *    caught the inline-chained and `const eventBus = ...` spellings — it
 *    MISSED the receiver-variable form `const bus = getEventBus();
 *    bus.subscribe(...)`, which is house style elsewhere in this codebase
 *    (services/notifications.ts). A revert of any of the five modules back
 *    to that form would dual-register while the old regex stayed green.
 * 2. No VALUE import of `getEventBus` at all (`import type { BreezeEvent }`
 *    stays fine — these modules still need the type). This is the
 *    structural half: no bus handle in scope, no subscription possible,
 *    independent of how `.subscribe(` itself might be spelled or renamed.
 */
const PRODUCTION_MODULES = [
  '../workers/webhookDelivery.ts',
  '../jobs/automationWorker.ts',
  './policyAlertBridge.ts',
  './notificationDispatcher.ts',
  './dnsThreatAlerts.ts',
] as const;

/** Any `.subscribe(` call, regardless of receiver variable name. */
const ANY_SUBSCRIBE_CALL = /\.subscribe\s*\(/;

/**
 * A VALUE import of `getEventBus` from the eventBus module — i.e. anything
 * except `import type { ... }`. Matches both `import { getEventBus } from
 * './eventBus'` and `import { getEventBus, EVENT_TYPES } from '../services/eventBus'`.
 */
const GET_EVENT_BUS_VALUE_IMPORT = /import\s+(?!type\s)\{[^}]*\bgetEventBus\b[^}]*\}\s*from\s*['"][^'"]*eventBus['"]/;

function readModule(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

describe('five subscribers migrated off the legacy bus (#4085 Task 3)', () => {
  it.each(PRODUCTION_MODULES)('%s has no .subscribe( call under any receiver name', (path) => {
    const src = readModule(path);
    expect(src).not.toMatch(ANY_SUBSCRIBE_CALL);
  });

  it.each(PRODUCTION_MODULES)('%s does not value-import getEventBus at all', (path) => {
    const src = readModule(path);
    expect(src).not.toMatch(GET_EVENT_BUS_VALUE_IMPORT);
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
