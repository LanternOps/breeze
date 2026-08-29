import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = [
  'services/aiGuardrails.ts',
  'services/aiAgents/executionLedger.ts',
  'services/actionIntents/policyDecide.ts',
  'services/aiAgents/actRevalidation.ts',
];

describe('verdict profile has no safety bypass (spec §7)', () => {
  it.each(FORBIDDEN)('%s never branches on the run profile', (rel) => {
    const src = readFileSync(join(__dirname, '../..', rel), 'utf8');
    expect(src).not.toMatch(/['"]verdict['"]/);
    expect(src).not.toMatch(/\.profile\b/);
  });
  it('outcome tools never import the db or execute a registered tool', () => {
    const src = readFileSync(join(__dirname, 'outcomeTools.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]\.\.\/\.\.\/db/);
    expect(src).not.toMatch(/executeTool\(/);
  });
});
