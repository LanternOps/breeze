import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '../services/eventBus';

// #9651: the webhook form offered `alert.created`, which nothing publishes, so
// a webhook subscribed to it saved fine and never fired. Every event the form
// offers must be one the event bus actually publishes (the webhook-delivery
// subscriber listens on `*`, so EVENT_TYPES is the deliverable set).
const REPO = join(__dirname, '../../../..');
const FORM = 'apps/web/src/components/webhooks/WebhookForm.tsx';

function formEventValues(): string[] {
  const source = readFileSync(join(REPO, FORM), 'utf8');
  const start = source.indexOf('export const webhookEventOptions = [');
  const end = source.indexOf('\n];', start);
  expect(start, `webhookEventOptions not found in ${FORM}`).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return [...source.slice(start, end).matchAll(/\{\s*value:\s*'([^']+)'/g)].map((m) => m[1]!);
}

describe('webhook form event options', () => {
  it('parses a non-trivial option list (guards against a vacuous pass)', () => {
    expect(formEventValues().length).toBeGreaterThanOrEqual(10);
  });

  it('offers only event types the event bus publishes', () => {
    const published = new Set<string>(Object.values(EVENT_TYPES));
    const unpublished = formEventValues().filter((value) => !published.has(value));
    expect(unpublished).toEqual([]);
  });
});
