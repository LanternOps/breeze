import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// #9121: a `device.*` type declared in the EventType catalog with no publisher
// is a dead promise to webhook / automation / event-stream subscribers.
const SRC = resolve(__dirname, '..');
const BUS = resolve(__dirname, 'eventBus.ts');

// Declared + documented but not yet published — tracked separately from #9121.
// Do NOT add to this list; publish the event or drop the type. The self-check
// below fails once an entry is published or undeclared, forcing its removal.
const KNOWN_UNPUBLISHED = new Set(['device.enrolled']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__' || name === '__mocks__') continue;
      walk(p, out);
    } else if (/\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name) && p !== BUS) {
      out.push(p);
    }
  }
  return out;
}

// Comments (a commented-out or prose `publishEvent('x')`) must not count.
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('device.* event catalog', () => {
  const busSrc = readFileSync(BUS, 'utf8');
  const union = busSrc.slice(busSrc.indexOf('export type EventType'), busSrc.indexOf('export const EVENT_TYPES'));
  const declared = [...new Set([...union.matchAll(/'(device\.[a-z0-9_]+)'/g)].map((m) => m[1]!))];
  const constByType = new Map(
    [...busSrc.matchAll(/(DEVICE_[A-Z0-9_]+): '([a-z0-9._]+)'/g)].map((m) => [m[2]!, m[1]!] as const),
  );
  const sources = walk(SRC).map((p) => stripComments(readFileSync(p, 'utf8')));

  // Only an argument to a publish call counts — not `eventType:` metadata,
  // subscriber comparisons, or log lines.
  const isPublished = (type: string): boolean => {
    const lit = type.replace('.', '\\.');
    const constName = constByType.get(type);
    const arg = constName ? `(?:['"]${lit}['"]|EVENT_TYPES\\.${constName}\\b)` : `['"]${lit}['"]`;
    const re = new RegExp(`\\b(?:publishEvent|publish)\\(\\s*${arg}`);
    return sources.some((s) => re.test(s));
  };

  it('declares device event types', () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it.each(declared.filter((t) => !KNOWN_UNPUBLISHED.has(t)))('%s has a publisher', (type) => {
    expect(isPublished(type), `${type} is declared in EventType but never published`).toBe(true);
  });

  it('KNOWN_UNPUBLISHED only lists types that are declared and still unpublished', () => {
    for (const type of KNOWN_UNPUBLISHED) {
      expect(declared, `${type} is no longer declared — remove it from KNOWN_UNPUBLISHED`).toContain(type);
      expect(isPublished(type), `${type} is now published — remove it from KNOWN_UNPUBLISHED`).toBe(false);
    }
  });
});
