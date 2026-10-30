// TEMPORARY — W1 red-path control for the retry wrapper (#10761). Fails on the
// first attempt in a runner, passes on the retry. Dropped before merge.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('w1 flake control', () => {
  it('fails once per runner, then passes', () => {
    const marker = join(process.env.RUNNER_TEMP ?? '/tmp', 'w1-flake-marker');
    if (!existsSync(marker)) {
      writeFileSync(marker, '1');
      expect.fail('first attempt fails by design (W1 flake control)');
    }
    expect(existsSync(marker)).toBe(true);
  });
});
