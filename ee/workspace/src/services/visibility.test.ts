import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { visibleSourcePredicateSql } from './visibility';

describe('visibleSourcePredicateSql alias guard (#3474)', () => {
  it('accepts the default and a plain identifier alias', () => {
    expect(() => visibleSourcePredicateSql(sql, [])).not.toThrow();
    expect(() => visibleSourcePredicateSql(sql, [], 'src_1')).not.toThrow();
  });

  it.each(['s; DROP TABLE x', "s.status = 'x' OR 1=1 --", '', 'a b', 's"'])(
    'rejects the non-identifier alias %j (it is interpolated via sql.raw)',
    (alias) => {
      expect(() => visibleSourcePredicateSql(sql, [], alias)).toThrow(/alias/i);
    },
  );
});

describe('visibility rule has one definition (#3474)', () => {
  it('no service re-inlines the ungrouped-source literal outside visibility.ts', () => {
    const dir = __dirname;
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'visibility.ts')
      .filter((f) => /visibility_group_ids\s*=\s*'\[\]'/.test(readFileSync(join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
