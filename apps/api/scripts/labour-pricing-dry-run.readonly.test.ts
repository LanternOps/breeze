import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, 'labour-pricing-dry-run.ts'), 'utf8');

describe('the dry-run script is read-only', () => {
  it('contains no write verb', () => {
    for (const verb of ['INSERT ', 'UPDATE ', 'DELETE ', 'ALTER ', 'DROP ', 'TRUNCATE ', 'CREATE ', 'db.insert', 'db.update', 'db.delete']) {
      expect(source.toUpperCase()).not.toContain(verb.toUpperCase());
    }
  });

  it('opens its transaction READ ONLY so Postgres refuses a write even if one slipped in', () => {
    expect(source).toContain('SET TRANSACTION READ ONLY');
  });

  it('elects system scope — without it every FORCE-RLS read returns zero rows SILENTLY and the report lies', () => {
    expect(source).toContain('withSystemDbAccessContext');
  });

  it('never writes to a file or posts anywhere — the operator copies stdout', () => {
    expect(source).not.toMatch(/writeFileSync|createWriteStream|fetch\(/);
  });
});
