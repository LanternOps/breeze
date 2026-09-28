import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = dirname(fileURLToPath(import.meta.url));
const trDir = join(localesDir, 'tr-TR');

const SUFFIX_PATTERN = /\{\{provider\}\}['’]/;

function collectOffenders(prefix: string, value: unknown, offenders: string[]): void {
  if (typeof value === 'string') {
    if (SUFFIX_PATTERN.test(value)) {
      offenders.push(`${prefix} → ${JSON.stringify(value)}`);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectOffenders(prefix ? `${prefix}.${key}` : key, child, offenders);
    }
  }
}

describe('tr-TR provider suffix', () => {
  it('never glues a Turkish case suffix directly onto {{provider}}', () => {
    const files = readdirSync(trDir).filter((f) => f.endsWith('.json'));
    const offenders: string[] = [];
    for (const file of files) {
      const contents = JSON.parse(readFileSync(join(trDir, file), 'utf8'));
      collectOffenders(file, contents, offenders);
    }
    expect(offenders).toEqual([]);
  });
});
