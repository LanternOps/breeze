import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('does not import or mount the retired inline-rule test router', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/alertRuleTest/);
});
