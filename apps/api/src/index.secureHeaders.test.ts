import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Source-level assertion on the secure-headers MOUNT. The behavioural tests in
 * middleware/security.test.ts and routes/tunnelHttp.test.ts mount
 * `apiSecureHeaders()` on their own `new Hono()`, so they stay green if index.ts
 * goes back to an inline `secureHeaders({ xFrameOptions: 'DENY' })` — which
 * would put X-Frame-Options: DENY back on the Network Proxy iframe.
 */
const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

describe('secure-headers mount (index.ts)', () => {
  it('mounts apiSecureHeaders globally', () => {
    expect(indexSource).toMatch(/app\.use\(\s*'\*'\s*,\s*apiSecureHeaders\(\)\s*\)/);
  });

  it('does not also mount hono secureHeaders directly', () => {
    expect(indexSource).not.toMatch(/\bsecureHeaders\s*\(/);
  });
});
