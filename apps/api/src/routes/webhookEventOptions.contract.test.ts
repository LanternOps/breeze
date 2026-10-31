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
  const block = source.slice(start, end);
  const values = [...block.matchAll(/\{\s*value:\s*'([^']+)'/g)].map((m) => m[1]!);
  // Every option carries a labelKey; if an option is written in a shape the
  // value regex misses, the counts diverge and this fails instead of skipping it.
  const optionCount = (block.match(/\blabelKey:/g) ?? []).length;
  expect(values.length, 'an option in webhookEventOptions was not parsed').toBe(optionCount);
  return values;
}

describe('webhook form event options', () => {
  it('parses a non-trivial option list (guards against a vacuous pass)', () => {
    expect(formEventValues().length).toBeGreaterThanOrEqual(10);
  });

  it('offers acknowledged and suppressed alerts', () => {
    expect(formEventValues()).toEqual(expect.arrayContaining(['alert.acknowledged', 'alert.suppressed']));
  });

  it('keeps the API and form never-delivered lists identical and never offers them', () => {
    const form = readFileSync(join(REPO, FORM), 'utf8');
    const api = readFileSync(join(REPO, 'apps/api/src/routes/webhooks.ts'), 'utf8');
    const formBlock = form.match(/export const NEVER_DELIVERED_EVENTS[^=]*=\s*\[([^\]]*)\]/)?.[1];
    const apiBlock = api.match(/export const NEVER_PUBLISHED_EVENT_TYPES[^=]*=\s*new Set\(\[([^\]]*)\]/)?.[1];
    expect(formBlock).toBeDefined();
    expect(apiBlock).toBeDefined();
    const values = (block: string | undefined) => [...(block ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
    expect(values(formBlock)).toEqual(['alert.escalated']);
    expect(values(formBlock)).toEqual(values(apiBlock));
    expect(formEventValues().filter(value => values(apiBlock).includes(value))).toEqual([]);
  });

  // #10024: ticket.merged is published (and documented) but was not selectable.
  it('offers ticket.merged, which the event bus publishes', () => {
    expect(Object.values(EVENT_TYPES)).toContain('ticket.merged');
    expect(formEventValues()).toContain('ticket.merged');
  });

  it('offers only event types the event bus publishes', () => {
    const published = new Set<string>(Object.values(EVENT_TYPES));
    const unpublished = formEventValues().filter((value) => !published.has(value));
    expect(unpublished).toEqual([]);
  });
});
