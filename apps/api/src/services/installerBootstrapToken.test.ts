import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  generateBootstrapToken,
  bootstrapTokenExpiresAt,
  BOOTSTRAP_TOKEN_PATTERN,
} from './installerBootstrapToken';

describe('generateBootstrapToken', () => {
  it('returns a 10-char token of [A-Z0-9]', () => {
    const t = generateBootstrapToken();
    expect(t).toMatch(BOOTSTRAP_TOKEN_PATTERN);
  });

  it('returns 10 chars exactly', () => {
    expect(generateBootstrapToken()).toHaveLength(10);
  });

  it('is statistically unique across 1000 calls', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) tokens.add(generateBootstrapToken());
    // 36^10 ≈ 3.7T values (~52 bits); collisions in 1000 samples are essentially impossible.
    // Allow a single collision before flagging — defensive against an unlucky CI run.
    expect(tokens.size).toBeGreaterThanOrEqual(999);
  });

  it('emits only uppercase letters and digits', () => {
    for (let i = 0; i < 100; i++) {
      expect(generateBootstrapToken()).toMatch(/^[A-Z0-9]+$/);
    }
  });
});

describe('BOOTSTRAP_TOKEN_PATTERN', () => {
  it('matches the canonical 10-char form', () => {
    expect(BOOTSTRAP_TOKEN_PATTERN.test('A7K2XQRP4N')).toBe(true);
    expect(BOOTSTRAP_TOKEN_PATTERN.test('1234567890')).toBe(true);
  });

  it('rejects shorter, longer, or lowercase variants', () => {
    expect(BOOTSTRAP_TOKEN_PATTERN.test('a7k2xqrp4n')).toBe(false);
    expect(BOOTSTRAP_TOKEN_PATTERN.test('A7K2XQRP4')).toBe(false);   // 9 chars
    expect(BOOTSTRAP_TOKEN_PATTERN.test('A7K2XQRP4NA')).toBe(false); // 11 chars
    expect(BOOTSTRAP_TOKEN_PATTERN.test('A7-2XQRP4N')).toBe(false);
  });
});

describe('bootstrapTokenExpiresAt', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const minutesOut = (d: Date) => Math.round((d.getTime() - Date.now()) / 60_000);

  it('defaults to 24 hours when the env var is unset', () => {
    expect(minutesOut(bootstrapTokenExpiresAt())).toBe(1440);
  });

  // #2776 regression. docker-compose threads this var in as
  // `${INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES:-}`, which `docker compose
  // config` renders as `VAR: ""` when the operator hasn't set it — the
  // container sees it SET to an empty string, not absent. The old
  // `Number(process.env.X ?? 24 * 60)` read gave 0 there (`??` doesn't fire
  // on '', Number('') === 0), so EVERY bootstrap token was minted already
  // expired and agent enrollment stopped working on upgrade.
  it('falls back to 24 hours when the env var is the EMPTY STRING, not 0 (#2776)', () => {
    vi.stubEnv('INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES', '');
    const expiresAt = bootstrapTokenExpiresAt();
    expect(minutesOut(expiresAt)).toBe(1440);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('falls back to 24 hours for a non-numeric value', () => {
    vi.stubEnv('INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES', 'forever');
    expect(minutesOut(bootstrapTokenExpiresAt())).toBe(1440);
  });

  it('honours an explicit override', () => {
    vi.stubEnv('INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES', '60');
    expect(minutesOut(bootstrapTokenExpiresAt())).toBe(60);
  });
});
