import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeEnvStack } from './env';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'wt-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('writeEnvStack', () => {
  it('writes all secrets the API config validator requires to boot', () => {
    const p = writeEnvStack(dir);
    const env = readFileSync(p, 'utf8');
    for (const key of [
      'POSTGRES_PASSWORD', 'ENROLLMENT_KEY_PEPPER', 'MFA_RECOVERY_CODE_PEPPER',
      'TURN_SECRET', 'IS_HOSTED', 'CADDY_SITE_ADDRESS', 'BREEZE_PORTAL_IMAGE_REF',
    ]) {
      expect(env).toContain(`${key}=`);
    }
    expect(env).toContain('CADDY_SITE_ADDRESS=:80');
    expect(env).toContain('IS_HOSTED=false');
  });
});
