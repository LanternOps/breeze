import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promptIdentityBlockSchema } from '@breeze/shared/promptCatalog';
import { createTableKeyedDb, type TableRows } from '../__tests__/helpers/tableKeyedDb';
import { png } from '../__tests__/helpers/syntheticLogos';

const h = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  ctx: 'request' as string,
  partnerAxisReads: 0,
  systemContexts: 0,
  outsideContexts: 0,
  cache: new Map<string, { orgId: string; settings: unknown }>(),
  cacheWrites: [] as Array<{ feature: string; deviceId: string; orgId: string | null; ttl: number }>,
  loadLogo: vi.fn(),
  readCachedLogo: vi.fn(),
  peekLogo: vi.fn(),
}));

vi.mock('../db', async () => {
  const { createTableKeyedDb: create } = await import('../__tests__/helpers/tableKeyedDb');
  const keyed = create(() => h.rows as Record<string, TableRows>, () => h.ctx);
  return {
    db: keyed.db,
    runOutsideDbContext: async (fn: () => unknown) => {
      h.outsideContexts += 1;
      return fn();
    },
    withSystemDbAccessContext: async (fn: () => unknown) => {
      h.systemContexts += 1;
      const prev = h.ctx;
      h.ctx = 'system';
      try {
        return await fn();
      } finally {
        h.ctx = prev;
      }
    },
  };
});
vi.mock('../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: async (fn: () => unknown) => {
    h.partnerAxisReads += 1;
    return fn();
  },
}));
vi.mock('./devicePolicyCache', () => ({
  readDevicePolicyCache: async (feature: string, deviceId: string, orgId: string | null, parse?: (v: unknown) => unknown) => {
    const hit = h.cache.get(`${feature}:${deviceId}`);
    if (!hit || hit.orgId !== orgId) return null;
    return parse ? parse(hit.settings) : hit.settings;
  },
  writeDevicePolicyCache: async (feature: string, deviceId: string, orgId: string | null, settings: unknown, ttl: number) => {
    h.cacheWrites.push({ feature, deviceId, orgId, ttl });
    if (orgId) h.cache.set(`${feature}:${deviceId}`, { orgId, settings });
  },
}));
vi.mock('./promptIdentityLogo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./promptIdentityLogo')>()),
  loadPromptIdentityLogo: (...args: unknown[]) => h.loadLogo(...args),
  readCachedPromptLogo: (...args: unknown[]) => h.readCachedLogo(...args),
  peekPromptIdentityLogo: (...args: unknown[]) => h.peekLogo(...args),
}));

import {
  PROMPT_IDENTITY_CACHE_TTL_SECONDS,
  buildHeartbeatPromptIdentity,
  loadDevicePromptLogo,
  promptIdentityScopeId,
  resolveDevicePromptIdentity,
  resolvePromptIdentity,
  toPromptIdentityBlock,
} from './promptIdentity';

const PARTNER = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG = 'bbbbbbbb-0000-4000-8000-000000000002';
const DEVICE = 'cccccccc-0000-4000-8000-000000000003';

const PARTNER_LOGO = 'https://logos.example.com/partner.png';
const ORG_LOGO = 'https://logos.example.com/org.png';

function setRows(over: { org?: unknown[]; partner?: unknown[]; portal?: unknown[] } = {}) {
  h.rows = {
    organizations: over.org ?? [{ partnerId: PARTNER }],
    partners: over.partner ?? [{ name: '  Example IT Services  ', settings: { branding: { logoUrl: PARTNER_LOGO, primaryColor: '#1F5FAD' } } }],
    portal_branding: over.portal ?? [],
  };
}

const LOGO_BYTES = png(32, 32);
const LOGO = {
  mime: 'image/png' as const,
  width: 32,
  height: 32,
  sha256: createHash('sha256').update(LOGO_BYTES).digest('hex'),
  bytes: LOGO_BYTES.length,
  data: LOGO_BYTES,
};

beforeEach(() => {
  setRows();
  h.ctx = 'request';
  h.partnerAxisReads = 0;
  h.systemContexts = 0;
  h.outsideContexts = 0;
  h.cache.clear();
  h.cacheWrites = [];
  h.loadLogo.mockReset();
  h.loadLogo.mockResolvedValue(LOGO);
  h.readCachedLogo.mockReset();
  h.readCachedLogo.mockResolvedValue(undefined);
  h.peekLogo.mockReset();
  h.peekLogo.mockResolvedValue({ state: 'ready', logo: LOGO });
});

describe('promptIdentityScopeId', () => {
  it('is the first 32 hex of sha256("<partnerId>:<orgId>")', () => {
    const expected = createHash('sha256').update(`${PARTNER}:${ORG}`).digest('hex').slice(0, 32);
    expect(promptIdentityScopeId(PARTNER, ORG)).toBe(expected);
    expect(promptIdentityScopeId(PARTNER, ORG)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('changes when either the partner or the org changes', () => {
    const base = promptIdentityScopeId(PARTNER, ORG);
    expect(promptIdentityScopeId(ORG, PARTNER)).not.toBe(base);
    expect(promptIdentityScopeId(PARTNER, DEVICE)).not.toBe(base);
  });
});

describe('resolvePromptIdentity', () => {
  it('resolves name, colour and logo from the partner (Settings → Partner → Branding)', async () => {
    await expect(resolvePromptIdentity(ORG)).resolves.toEqual({
      partnerId: PARTNER,
      orgId: ORG,
      scopeId: promptIdentityScopeId(PARTNER, ORG),
      partnerName: 'Example IT Services',
      primaryColor: '#1F5FAD',
      logoSource: PARTNER_LOGO,
    });
  });

  it('reads the partner row under partner-axis visibility, once', async () => {
    await resolvePromptIdentity(ORG);
    expect(h.partnerAxisReads).toBe(1);
  });

  it('name is never taken from portal_branding (or the org)', async () => {
    setRows({
      portal: [{ logoUrl: ORG_LOGO, primaryColor: '#AA0000', name: 'Spoofed Corp', companyName: 'Spoofed Corp' }],
    });
    const identity = await resolvePromptIdentity(ORG);
    expect(identity?.partnerName).toBe('Example IT Services');
    expect(JSON.stringify(identity)).not.toContain('Spoofed');
  });

  it('org override wins for logo and colour', async () => {
    setRows({ portal: [{ logoUrl: ORG_LOGO, primaryColor: '#aa0000' }] });
    const identity = await resolvePromptIdentity(ORG);
    expect(identity).toMatchObject({ logoSource: ORG_LOGO, primaryColor: '#aa0000', partnerName: 'Example IT Services' });
  });

  it('an org override left blank falls back to the partner field by field', async () => {
    setRows({ portal: [{ logoUrl: '  ', primaryColor: '#00aa00' }] });
    expect(await resolvePromptIdentity(ORG)).toMatchObject({ logoSource: PARTNER_LOGO, primaryColor: '#00aa00' });
  });

  it('an org colour that is not a hex colour falls back to the partner colour', async () => {
    setRows({ portal: [{ logoUrl: null, primaryColor: 'red; background:url(x)' }] });
    expect((await resolvePromptIdentity(ORG))?.primaryColor).toBe('#1F5FAD');
  });

  it('an org logo that is neither data: nor https:// falls back to the partner logo', async () => {
    setRows({ portal: [{ logoUrl: 'http://logos.example.com/org.png', primaryColor: null }] });
    expect((await resolvePromptIdentity(ORG))?.logoSource).toBe(PARTNER_LOGO);
  });

  it('expands a #rgb colour to #RRGGBB (the wire shape)', async () => {
    setRows({ partner: [{ name: 'Example IT', settings: { branding: { primaryColor: '#1a2' } } }] });
    expect((await resolvePromptIdentity(ORG))?.primaryColor).toBe('#11aa22');
  });

  it('sanitizes the partner name; an unusable name is omitted, not replaced', async () => {
    setRows({ partner: [{ name: '‮Example​ IT', settings: {} }] });
    expect((await resolvePromptIdentity(ORG))?.partnerName).toBe('Example IT');
    setRows({ partner: [{ name: '   ', settings: {} }] });
    const blank = await resolvePromptIdentity(ORG);
    expect(blank).not.toBeNull();
    expect(blank).not.toHaveProperty('partnerName');
  });

  it('omits colour and logo keys when neither the partner nor the org has one', async () => {
    setRows({ partner: [{ name: 'Example IT', settings: null }] });
    const identity = await resolvePromptIdentity(ORG);
    expect(identity).not.toHaveProperty('primaryColor');
    expect(identity).not.toHaveProperty('logoSource');
  });

  it('null when the org is not visible or the partner row is missing', async () => {
    setRows({ org: [] });
    expect(await resolvePromptIdentity(ORG)).toBeNull();
    setRows({ partner: [] });
    expect(await resolvePromptIdentity(ORG)).toBeNull();
  });
});

describe('resolveDevicePromptIdentity', () => {
  const args = { deviceId: DEVICE, orgId: ORG, partnerId: PARTNER };

  it('resolves in a system context entered outside any held context, then loads the logo after it', async () => {
    const identity = await resolveDevicePromptIdentity(args);
    expect(h.outsideContexts).toBe(1);
    expect(h.systemContexts).toBe(1);
    expect(h.loadLogo).toHaveBeenCalledWith(PARTNER_LOGO, { partnerId: PARTNER });
    expect(identity).toEqual({
      state: 'set',
      partnerId: PARTNER,
      scopeId: promptIdentityScopeId(PARTNER, ORG),
      partnerName: 'Example IT Services',
      primaryColor: '#1F5FAD',
      logo: { sha256: LOGO.sha256, mime: 'image/png', bytes: LOGO.bytes },
      logoSourceKey: createHash('sha256').update(PARTNER_LOGO).digest('hex'),
    });
  });

  it('caches the answer per device, bound to the org, for 120 s', async () => {
    await resolveDevicePromptIdentity(args);
    expect(PROMPT_IDENTITY_CACHE_TTL_SECONDS).toBe(120);
    expect(h.cacheWrites).toEqual([{ feature: 'prompt-identity', deviceId: DEVICE, orgId: ORG, ttl: 120 }]);
    h.systemContexts = 0;
    h.loadLogo.mockClear();
    await resolveDevicePromptIdentity(args);
    expect(h.systemContexts).toBe(0);
    expect(h.loadLogo).not.toHaveBeenCalled();
  });

  it('a logo that fails validation omits `logo` and keeps the rest', async () => {
    h.loadLogo.mockResolvedValue(null);
    const identity = await resolveDevicePromptIdentity(args);
    expect(identity).toMatchObject({ state: 'set', partnerName: 'Example IT Services' });
    expect(identity).not.toHaveProperty('logo');
    expect(identity).not.toHaveProperty('logoSourceKey');
  });

  it('an org with no resolvable partner is `cleared`', async () => {
    setRows({ partner: [] });
    expect(await resolveDevicePromptIdentity(args)).toEqual({ state: 'cleared' });
  });

  it('refuses (throws, uncached) when the org resolves to a partner other than the authenticated one', async () => {
    await expect(resolveDevicePromptIdentity({ ...args, partnerId: 'dddddddd-0000-4000-8000-000000000009' })).rejects.toThrow(/partner/);
    expect(h.cacheWrites).toEqual([]);
  });

  it('never serves a cached entry for another partner', async () => {
    await resolveDevicePromptIdentity(args);
    await expect(resolveDevicePromptIdentity({ ...args, partnerId: 'dddddddd-0000-4000-8000-000000000009' })).rejects.toThrow(/partner/);
  });
});

describe('the heartbeat block', () => {
  const args = { deviceId: DEVICE, orgId: ORG, partnerId: PARTNER };

  it('parses with promptIdentityBlockSchema and carries no server-only keys', async () => {
    const block = await buildHeartbeatPromptIdentity(args);
    expect(promptIdentityBlockSchema.safeParse(block).success).toBe(true);
    expect(block).toEqual({
      state: 'set',
      scopeId: promptIdentityScopeId(PARTNER, ORG),
      partnerName: 'Example IT Services',
      primaryColor: '#1F5FAD',
      logo: { sha256: LOGO.sha256, mime: 'image/png', bytes: LOGO.bytes },
    });
  });

  it('cleared parses too', async () => {
    setRows({ partner: [] });
    const block = await buildHeartbeatPromptIdentity(args);
    expect(block).toEqual({ state: 'cleared' });
    expect(promptIdentityBlockSchema.safeParse(block).success).toBe(true);
  });

  it('a resolution failure omits the block (logged, never thrown)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.rows = { ...h.rows, partners: new Error('db down') };
    await expect(buildHeartbeatPromptIdentity(args)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });

  it('a block that would not parse is omitted, never sent', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(toPromptIdentityBlock({ state: 'set', partnerId: PARTNER, scopeId: 'not-hex' })).toBeNull();
  });
});

describe('loadDevicePromptLogo (the logo route)', () => {
  const args = { deviceId: DEVICE, orgId: ORG, partnerId: PARTNER };

  it("serves the device's current logo for its current sha", async () => {
    h.readCachedLogo.mockResolvedValue(LOGO);
    const logo = await loadDevicePromptLogo({ ...args, sha256: LOGO.sha256 });
    expect(logo?.sha256).toBe(LOGO.sha256);
    expect(h.readCachedLogo).toHaveBeenCalledWith(createHash('sha256').update(PARTNER_LOGO).digest('hex'));
  });

  it('null on a stale sha (the logo changed since the agent was told)', async () => {
    h.readCachedLogo.mockResolvedValue(LOGO);
    expect(await loadDevicePromptLogo({ ...args, sha256: 'a'.repeat(64) })).toBeNull();
  });

  it('null when the device has no logo', async () => {
    h.loadLogo.mockResolvedValue(null);
    expect(await loadDevicePromptLogo({ ...args, sha256: LOGO.sha256 })).toBeNull();
  });

  it('bytes evicted from the logo cache: reloads from the source and checks the sha again', async () => {
    const first = await loadDevicePromptLogo({ ...args, sha256: LOGO.sha256 });
    expect(first?.sha256).toBe(LOGO.sha256);
    expect(h.loadLogo).toHaveBeenCalledTimes(2); // device identity, then the re-check
  });

  it("no cross-partner leak: partner B's correct sha never serves anything to partner A's device", async () => {
    const B_BYTES = png(40, 40);
    const B_LOGO = { ...LOGO, data: B_BYTES, bytes: B_BYTES.length, sha256: createHash('sha256').update(B_BYTES).digest('hex') };
    // B's logo is warm in every cache this process has.
    h.readCachedLogo.mockResolvedValue(B_LOGO);
    const served = await loadDevicePromptLogo({ ...args, sha256: B_LOGO.sha256 });
    expect(served).toBeNull();
  });

  it("a cached device identity for another partner is refused, not served", async () => {
    await resolveDevicePromptIdentity(args);
    await expect(
      loadDevicePromptLogo({ ...args, partnerId: 'dddddddd-0000-4000-8000-000000000009', sha256: LOGO.sha256 }),
    ).rejects.toThrow(/partner/);
  });
});

describe('review round 1 (#10314)', () => {
  const args = { deviceId: DEVICE, orgId: ORG, partnerId: PARTNER };

  it('the device cache holds logo metadata only: exactly {sha256, mime, bytes}, no bytes, no source URL', async () => {
    await resolveDevicePromptIdentity(args);
    const entry = h.cache.get(`prompt-identity:${DEVICE}`)?.settings as Record<string, unknown>;
    expect(entry.logo).toEqual({ sha256: LOGO.sha256, mime: 'image/png', bytes: LOGO.bytes });
    expect(Object.keys(entry.logo as object).sort()).toEqual(['bytes', 'mime', 'sha256']);
    expect(entry).not.toHaveProperty('logoSource');
    expect(JSON.stringify(entry)).not.toContain(PARTNER_LOGO);
    expect(JSON.stringify(entry)).not.toContain(Buffer.from(LOGO_BYTES).toString('base64'));
    expect(JSON.stringify(entry)).not.toContain('"data"');
  });

  it("reload path: an evicted logo whose source image changed does not serve the new bytes under the old sha", async () => {
    const NEW_BYTES = png(64, 64);
    const NEW_LOGO = { ...LOGO, data: NEW_BYTES, bytes: NEW_BYTES.length, sha256: createHash('sha256').update(NEW_BYTES).digest('hex') };
    // The device identity still names the old sha (resolved earlier, cached)...
    await resolveDevicePromptIdentity(args);
    // ...the logo bytes left the cache, and the source now serves a new image.
    h.readCachedLogo.mockResolvedValue(undefined);
    h.loadLogo.mockResolvedValue(NEW_LOGO);
    expect(await loadDevicePromptLogo({ ...args, sha256: LOGO.sha256 })).toBeNull();
  });

  describe('heartbeat (warm) mode never waits on the network', () => {
    it('a cold https logo omits the whole block this beat (agent keeps its last identity) and caches nothing', async () => {
      h.peekLogo.mockResolvedValue({ state: 'pending' });
      await expect(buildHeartbeatPromptIdentity(args)).resolves.toBeUndefined();
      expect(h.cacheWrites).toEqual([]);
      expect(h.loadLogo).not.toHaveBeenCalled();
    });

    it('the next beat, once the logo is warm, carries it', async () => {
      h.peekLogo.mockResolvedValueOnce({ state: 'pending' });
      await buildHeartbeatPromptIdentity(args);
      const block = await buildHeartbeatPromptIdentity(args);
      expect(block).toMatchObject({ state: 'set', logo: { sha256: LOGO.sha256 } });
    });

    it('a logo known to be bad sends the block without logo', async () => {
      h.peekLogo.mockResolvedValue({ state: 'none' });
      const block = await buildHeartbeatPromptIdentity(args);
      expect(block).toMatchObject({ state: 'set', partnerName: 'Example IT Services' });
      expect(block).not.toHaveProperty('logo');
    });

    it('peeks with the partner id (for the operator log line)', async () => {
      await buildHeartbeatPromptIdentity(args);
      expect(h.peekLogo).toHaveBeenCalledWith(PARTNER_LOGO, { partnerId: PARTNER });
    });

    it('no logo source: no peek, block without logo', async () => {
      setRows({ partner: [{ name: 'Example IT', settings: {} }] });
      const block = await buildHeartbeatPromptIdentity(args);
      expect(h.peekLogo).not.toHaveBeenCalled();
      expect(block).toEqual({ state: 'set', scopeId: promptIdentityScopeId(PARTNER, ORG), partnerName: 'Example IT' });
    });
  });
});
