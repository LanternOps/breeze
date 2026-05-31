import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Contract: every `verifyDeviceAccess` implementation in the AI-tools layer
 * MUST enforce the site axis (not just org). The tool layer is a parallel path
 * to the device-scoped tables; an org-only device gate lets a site-restricted
 * user act on devices in forbidden sites (privilege escalation — incl. the
 * mutating script/remote/filesystem tools). This guards against re-introducing
 * an org-only copy when these files get duplicated (the root cause of the bug
 * class). The site axis is enforced by referencing `canAccessSite` in the body.
 */
const SERVICES_DIR = __dirname;

function verifyDeviceAccessBodies(source: string): string[] {
  const bodies: string[] = [];
  let idx = source.indexOf('function verifyDeviceAccess');
  while (idx !== -1) {
    // A copy is at most ~30 lines; 1000 chars comfortably spans its body.
    bodies.push(source.slice(idx, idx + 1000));
    idx = source.indexOf('function verifyDeviceAccess', idx + 1);
  }
  return bodies;
}

describe('contract: AI-tools verifyDeviceAccess enforces the site axis', () => {
  const files = readdirSync(SERVICES_DIR).filter(
    (f) => /^aiTools.*\.ts$/.test(f) && !f.includes('.test.'),
  );

  it('finds aiTools source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const source = readFileSync(join(SERVICES_DIR, file), 'utf8');
    const bodies = verifyDeviceAccessBodies(source);
    if (bodies.length === 0) continue;
    it(`${file}: every verifyDeviceAccess body references canAccessSite`, () => {
      for (const body of bodies) {
        expect(body).toContain('canAccessSite');
      }
    });
  }
});
