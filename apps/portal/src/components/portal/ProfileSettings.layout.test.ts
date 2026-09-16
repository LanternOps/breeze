import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ProfileSettings — column sits against the sheet edge', () => {
  it('keeps a reading measure but does not centre itself inside the sheet', () => {
    const src = readFileSync('src/components/portal/ProfileSettings.tsx', 'utf8');
    expect(src).toMatch(/max-w-2xl/);
    expect(src).not.toMatch(/mx-auto max-w-2xl|max-w-2xl mx-auto/);
  });
});
