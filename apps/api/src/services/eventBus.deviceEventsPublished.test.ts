import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// #9121: a `device.*` type declared in the EventType catalog with no publisher
// is a dead promise to webhook / automation / event-stream subscribers.
const SRC = resolve(__dirname, '..');
const BUS = resolve(__dirname, 'eventBus.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      walk(p, out);
    } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && p !== BUS) {
      out.push(p);
    }
  }
  return out;
}

// Declared + documented but not yet published — tracked separately from #9121.
// Do NOT add to this list; publish the event or drop the type.
const KNOWN_UNPUBLISHED = new Set(['device.enrolled']);

describe('device.* event catalog', () => {
  const busSrc = readFileSync(BUS, 'utf8');
  const union = busSrc.slice(busSrc.indexOf('export type EventType'), busSrc.indexOf('export const EVENT_TYPES'));
  const declared = [...new Set([...union.matchAll(/'(device\.[a-z_]+)'/g)].map((m) => m[1]!))];
  const constByType = new Map(
    [...busSrc.matchAll(/(DEVICE_[A-Z_]+): '([a-z._]+)'/g)].map((m) => [m[2]!, m[1]!] as const),
  );
  const sources = walk(SRC).map((p) => readFileSync(p, 'utf8'));

  it('declares device event types', () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it.each(declared.filter((t) => !KNOWN_UNPUBLISHED.has(t)))('%s has a publisher', (type) => {
    const lit = type.replace('.', '\\.');
    const constName = constByType.get(type);
    const published = sources.some(
      (s) =>
        new RegExp(`publish(?:Event)?\\(\\s*['"]${lit}['"]`).test(s) ||
        new RegExp(`eventType:\\s*['"]${lit}['"]`).test(s) ||
        (constName ? new RegExp(`EVENT_TYPES\\.${constName}\\b`).test(s) : false),
    );
    expect(published, `${type} is declared in EventType but never published`).toBe(true);
  });
});
