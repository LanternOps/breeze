import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(process.cwd(), 'src/components');

describe('hard-coded compliance report surfaces', () => {
  it('does not export the unmounted software compliance report', () => {
    const barrel = readFileSync(resolve(sourceRoot, 'software/index.ts'), 'utf8');
    expect(barrel).not.toContain('SoftwareComplianceReport');
  });

  it('does not export the unmounted audit compliance report', () => {
    const barrel = readFileSync(resolve(sourceRoot, 'audit/index.ts'), 'utf8');
    expect(barrel).not.toContain('ComplianceReport');
  });

  it('does not retain the literal report components', () => {
    expect(() => readFileSync(resolve(sourceRoot, 'software/SoftwareComplianceReport.tsx'), 'utf8')).toThrow();
    expect(() => readFileSync(resolve(sourceRoot, 'audit/ComplianceReport.tsx'), 'utf8')).toThrow();
  });
});
