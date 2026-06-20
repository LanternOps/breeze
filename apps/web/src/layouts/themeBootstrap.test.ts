import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function readLayout(name: string): string {
  return readFileSync(join(process.cwd(), 'src/layouts', name), 'utf8');
}

describe('auth layout theme bootstrap', () => {
  it.each(['AuthShellBranded.astro', 'AuthLayout.astro'])(
    '%s applies persisted appearance before first paint',
    (layoutName) => {
      const source = readLayout(layoutName);

      expect(source).toContain('<script is:inline src="/theme-bootstrap.js"></script>');
      expect(source.indexOf('src="/theme-bootstrap.js"')).toBeLessThan(source.indexOf('<ClientRouter />'));
    }
  );
});
