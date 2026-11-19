import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REMEMBERED_ENROLLMENT_ARTIFACTS_KEY as KEY,
  clearRememberedEnrollmentArtifacts,
  currentRememberEpoch,
  forgetEnrollmentArtifact,
  forgetSiteEnrollmentArtifacts,
  readRememberedEnrollmentArtifacts,
  rememberCliToken,
  rememberInstallerLink,
} from './rememberedEnrollmentArtifacts';

const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();

const cli = (overrides: Record<string, unknown> = {}) => ({
  value: 'enroll_abc',
  expiresAt: inOneHour(),
  maxUsage: 5,
  serverUrl: 'https://api.example.test',
  ...overrides,
});

const link = (overrides: Record<string, unknown> = {}) => ({
  value: 'https://api.example.test/s/CODE',
  expiresAt: inOneHour(),
  maxUsage: 3,
  childKeyId: 'child-1',
  platform: 'windows' as const,
  ...overrides,
});

describe('rememberedEnrollmentArtifacts (#10923)', () => {
  beforeEach(() => {
    clearRememberedEnrollmentArtifacts();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips a CLI token and an installer link, keyed by site', () => {
    rememberCliToken('user-1', 'site-a', cli());
    rememberInstallerLink('user-1', 'site-a', link());

    const a = readRememberedEnrollmentArtifacts('user-1', 'site-a');
    expect(a.cli?.value).toBe('enroll_abc');
    expect(a.cli?.childKeyId).toBeNull();
    expect(a.cli?.maxUsage).toBe(5);
    expect(a.cli?.serverUrl).toBe('https://api.example.test');
    expect(typeof a.cli?.createdAt).toBe('string');
    expect(a.link?.value).toBe('https://api.example.test/s/CODE');
    expect(a.link?.childKeyId).toBe('child-1');
    expect(a.link?.platform).toBe('windows');

    expect(readRememberedEnrollmentArtifacts('user-1', 'site-b')).toEqual({});
  });

  it('keeps the child key id of a CLI token when the API sent one (#11116)', () => {
    rememberCliToken('user-1', 'site-a', cli({ childKeyId: 'key-9' }));
    expect(readRememberedEnrollmentArtifacts('user-1', 'site-a').cli?.childKeyId).toBe('key-9');
  });

  it('stores in sessionStorage and never in localStorage', () => {
    localStorage.clear();
    rememberCliToken('user-1', 'site-a', cli());
    expect(sessionStorage.getItem(KEY)).toContain('enroll_abc');
    expect(localStorage.length).toBe(0);
  });

  it('removes an entry from storage once it is past expiresAt, on any read', () => {
    rememberCliToken('user-1', 'site-a', cli());
    rememberInstallerLink('user-1', 'site-b', link());
    expect(sessionStorage.getItem(KEY)).toContain('enroll_abc');

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 3_600_000);

    // Reading site-b also sweeps site-a's dead token.
    expect(readRememberedEnrollmentArtifacts('user-1', 'site-b')).toEqual({});
    expect(sessionStorage.getItem(KEY) ?? '').not.toContain('enroll_abc');
    expect(sessionStorage.getItem(KEY) ?? '').not.toContain('/s/CODE');
  });

  it('refuses to remember what has no usable expiry', () => {
    rememberCliToken('user-1', 'site-a', cli({ expiresAt: 'not-a-date' }));
    rememberInstallerLink('user-1', 'site-a', link({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect(readRememberedEnrollmentArtifacts('user-1', 'site-a')).toEqual({});
  });

  it('forgets one kind, or a whole site', () => {
    rememberCliToken('user-1', 'site-a', cli());
    rememberInstallerLink('user-1', 'site-a', link());
    rememberCliToken('user-1', 'site-b', cli({ value: 'enroll_b' }));

    forgetEnrollmentArtifact('user-1', 'site-a', 'cli');
    expect(readRememberedEnrollmentArtifacts('user-1', 'site-a').cli).toBeUndefined();
    expect(readRememberedEnrollmentArtifacts('user-1', 'site-a').link).toBeDefined();

    forgetSiteEnrollmentArtifacts('user-1', 'site-a');
    expect(readRememberedEnrollmentArtifacts('user-1', 'site-a')).toEqual({});
    expect(readRememberedEnrollmentArtifacts('user-1', 'site-b').cli?.value).toBe('enroll_b');
  });

  it('never hands one user the entries of another, and wipes them', () => {
    rememberCliToken('user-1', 'site-a', cli());

    expect(readRememberedEnrollmentArtifacts('user-2', 'site-a')).toEqual({});
    expect(sessionStorage.getItem(KEY) ?? '').not.toContain('enroll_abc');
  });

  it('clear removes everything', () => {
    rememberCliToken('user-1', 'site-a', cli());
    clearRememberedEnrollmentArtifacts();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it.each([
    ['not JSON', '{nope'],
    ['the wrong shape', JSON.stringify({ userId: 'user-1', sites: { 'site-a': { cli: { value: 7 } } } })],
    ['no sites map', JSON.stringify({ userId: 'user-1' })],
    ['a link with no child key id', JSON.stringify({ userId: 'user-1', sites: { 'site-a': { link: { ...link(), childKeyId: undefined, createdAt: 'x' } } } })],
    ['a link for an unknown platform', JSON.stringify({ userId: 'user-1', sites: { 'site-a': { link: { ...link(), platform: 'linux', createdAt: 'x' } } } })],
    ['a null', 'null'],
  ])('treats a stored blob holding %s as empty', (_label, raw) => {
    sessionStorage.setItem(KEY, raw);
    expect(readRememberedEnrollmentArtifacts('user-1', 'site-a')).toEqual({});
  });

  it('degrades to remembering nothing when storage throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'QuotaExceededError');
    });
    expect(() => rememberCliToken('user-1', 'site-a', cli())).not.toThrow();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(readRememberedEnrollmentArtifacts('user-1', 'site-a')).toEqual({});
  });

  it('drops everything rather than keep an entry it was told to forget when the write fails', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rememberCliToken('user-1', 'site-a', cli());
    rememberCliToken('user-1', 'site-b', cli({ value: 'enroll_b' }));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'QuotaExceededError');
    });

    forgetEnrollmentArtifact('user-1', 'site-a', 'cli');
    setItem.mockRestore();

    expect(readRememberedEnrollmentArtifacts('user-1', 'site-a')).toEqual({});
    expect(sessionStorage.getItem(KEY) ?? '').not.toContain('enroll_abc');
  });

  it('refuses a write begun before a clear (a mint that resolves after sign-out)', () => {
    const tokenEpoch = currentRememberEpoch();
    const linkEpoch = currentRememberEpoch();
    clearRememberedEnrollmentArtifacts();

    rememberCliToken('user-1', 'site-a', { ...cli(), epoch: tokenEpoch }, 'fleet-secret');
    rememberInstallerLink('user-1', 'site-a', { ...link(), epoch: linkEpoch });

    expect(sessionStorage.getItem(KEY)).toBeNull();
    rememberCliToken('user-1', 'site-a', cli());
    expect(readRememberedEnrollmentArtifacts('user-1', 'site-a').cli?.enrollmentSecret).toBeUndefined();
  });

  // AGENT_ENROLLMENT_SECRET is deployment-wide and does not expire, unlike the
  // token, so it stays out of browser storage.
  describe('the deployment-wide enrollment secret', () => {
    it('never reaches browser storage', () => {
      localStorage.clear();
      rememberCliToken('user-1', 'site-a', cli(), 'fleet-secret');
      expect(sessionStorage.getItem(KEY)).toContain('enroll_abc');
      expect(sessionStorage.getItem(KEY)).not.toContain('fleet-secret');
      expect(localStorage.length).toBe(0);
    });

    it('comes back from memory in the same document', () => {
      rememberCliToken('user-1', 'site-a', cli(), 'fleet-secret');
      expect(readRememberedEnrollmentArtifacts('user-1', 'site-a').cli?.enrollmentSecret).toBe('fleet-secret');
    });

    it('drops a token that needs it after a reload, because its command could not enroll', async () => {
      rememberCliToken('user-1', 'site-a', cli(), 'fleet-secret');
      expect(sessionStorage.getItem(KEY)).toContain('enroll_abc');

      vi.resetModules();
      const reloaded = await import('./rememberedEnrollmentArtifacts');

      expect(reloaded.readRememberedEnrollmentArtifacts('user-1', 'site-a')).toEqual({});
      expect(sessionStorage.getItem(KEY) ?? '').not.toContain('enroll_abc');
    });

    it('keeps a token that needs no secret across a reload', async () => {
      rememberCliToken('user-1', 'site-a', cli());

      vi.resetModules();
      const reloaded = await import('./rememberedEnrollmentArtifacts');

      expect(reloaded.readRememberedEnrollmentArtifacts('user-1', 'site-a').cli?.value).toBe('enroll_abc');
    });

    it('is dropped by clear', () => {
      rememberCliToken('user-1', 'site-a', cli(), 'fleet-secret');
      clearRememberedEnrollmentArtifacts();
      rememberCliToken('user-1', 'site-a', cli());
      expect(readRememberedEnrollmentArtifacts('user-1', 'site-a').cli?.enrollmentSecret).toBeUndefined();
    });

    it('is not offered to a different user', () => {
      rememberCliToken('user-1', 'site-a', cli(), 'fleet-secret');
      rememberCliToken('user-2', 'site-a', cli());
      expect(readRememberedEnrollmentArtifacts('user-2', 'site-a').cli?.enrollmentSecret).toBeUndefined();
    });
  });
});
