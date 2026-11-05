import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OEM_CATEGORIES, OEM_LANES, oemUpdateRunPayloadSchema } from '@breeze/shared';
import {
  categoryOpenIn,
  getLaneManifest,
  isCategoryOpen,
  isLaneOpen,
  openCategoriesForLane,
  payloadToolFor,
  SHIPPED_OEM_LANES,
  validateLaneManifest,
  type LaneManifest,
  type LaneToolAllowlist,
} from './toolManifest';

const ALLOWLIST_PATH = resolve(import.meta.dirname, '../../../../../agent/internal/oemupdates/allowlist.json');
const SHA = 'a'.repeat(64);

const allClosed = () => Object.fromEntries(OEM_CATEGORIES.map((c) => [c, 'closed'])) as LaneManifest['categoryGates'];

function manifest(overrides: Partial<LaneManifest> = {}): LaneManifest {
  return {
    lane: 'dell',
    laneGate: 'open',
    categoryGates: { ...allClosed(), driver: 'open' },
    codeBlocks: [],
    tool: {
      version: '5.7.2',
      minSafeVersion: '5.7.1',
      supportedRange: { min: '5.7.1', maxExclusive: '6.0.0' },
      url: 'https://dl.dell.com/tool.exe',
      sha256: SHA,
      prerequisites: [],
    },
    ...overrides,
  };
}

const allow: LaneToolAllowlist = { hosts: ['dl.dell.com'] };

/** Lane → hosts from the agent's embedded allowlist (W02), tolerating Go or JSON casing. */
function agentAllowlist(): Record<string, LaneToolAllowlist> | null {
  if (!existsSync(ALLOWLIST_PATH)) return null;
  const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as Record<string, Record<string, string[]>>;
  return Object.fromEntries(
    Object.entries(raw).map(([lane, v]) => [lane, { hosts: v.hosts ?? v.Hosts ?? [] }]),
  );
}

afterEach(() => vi.unstubAllEnvs());

describe('tool manifest contract', () => {
  it('every gate is closed at this wave', () => {
    for (const lane of OEM_LANES) {
      const m = getLaneManifest(lane);
      expect(m.laneGate, lane).toBe('closed');
      for (const category of OEM_CATEGORIES) expect(m.categoryGates[category], `${lane}/${category}`).toBe('closed');
      expect(openCategoriesForLane(lane)).toEqual([]);
    }
  });

  it('every real lane passes the open gate rule against the agent allowlist', () => {
    const lists = agentAllowlist();
    for (const lane of OEM_LANES) {
      const m = getLaneManifest(lane);
      const opensAnything = m.laneGate === 'open' || OEM_CATEGORIES.some((c) => m.categoryGates[c] === 'open');
      if (opensAnything && !lists) throw new Error(`${lane} opens a gate but ${ALLOWLIST_PATH} is missing`);
      expect(validateLaneManifest(m, lists?.[lane] ?? { hosts: [] }), lane).toEqual([]);
    }
  });

  it('dell carries the floor and leaves url and sha256 null until the lab wave', () => {
    const { tool } = getLaneManifest('dell');
    expect(tool).toMatchObject({ version: '5.7.2', minSafeVersion: '5.7.1', url: null, sha256: null });
  });

  it('surface has shipped, with no tool and every gate closed', () => {
    expect(SHIPPED_OEM_LANES).toContain('surface');
    const surface = getLaneManifest('surface');
    expect(surface.tool).toBeNull();
    expect(surface.laneGate).toBe('closed');
    expect(openCategoriesForLane('surface')).toEqual([]);
    expect(payloadToolFor(surface)).toBeNull();
  });

  it('hp has shipped, with the HPIA floor, every gate closed and nothing pinned until the lab wave', () => {
    expect(SHIPPED_OEM_LANES).toContain('hp');
    const hp = getLaneManifest('hp');
    expect(hp.laneGate).toBe('closed');
    expect(openCategoriesForLane('hp')).toEqual([]);
    expect(hp.tool).toMatchObject({
      minSafeVersion: '5.3.3',
      supportedRange: { min: '5.3.3', maxExclusive: '6.0.0' },
      url: null,
      sha256: null,
      prerequisites: [],
    });
    expect(payloadToolFor(hp)).toBeNull();
  });

  it('only lanes with a built agent lane are shipped', () => {
    expect([...SHIPPED_OEM_LANES].sort()).toEqual(['dell', 'hp', 'surface']);
  });

  it('surface can open a gate without a tool, because it installs none', () => {
    const open = manifest({ lane: 'surface', tool: null });
    expect(validateLaneManifest(open, { hosts: [] })).toEqual([]);
  });

  it('surface may never name a tool, gates open or closed', () => {
    const tool = manifest().tool!;
    expect(validateLaneManifest(manifest({ lane: 'surface', tool }), allow).join()).toMatch(/installs no software/);
    const closed = manifest({ lane: 'surface', laneGate: 'closed', categoryGates: allClosed(), tool });
    expect(validateLaneManifest(closed, allow).join()).toMatch(/installs no software/);
  });

  it('being tool-free is not a way round the tool rule for other lanes', () => {
    for (const lane of ['dell', 'hp', 'lenovo'] as const) {
      expect(validateLaneManifest(manifest({ lane, tool: null }), allow).join(), lane).toMatch(/requires a tool/);
    }
  });

  it('a manifest with every gate closed needs no tool', () => {
    expect(validateLaneManifest(manifest({ laneGate: 'closed', categoryGates: allClosed(), tool: null }), allow)).toEqual([]);
  });

  it('an open gate requires a tool', () => {
    expect(validateLaneManifest(manifest({ tool: null }), allow).join()).toMatch(/requires a tool/);
  });

  it('an open gate requires a 64-hex sha256', () => {
    const tool = manifest().tool!;
    for (const sha256 of [null, 'abc', 'Z'.repeat(64), SHA.toUpperCase()]) {
      expect(validateLaneManifest(manifest({ tool: { ...tool, sha256 } }), allow).join()).toMatch(/sha256/);
    }
  });

  it('an open gate requires a url on the agent allowlist', () => {
    const tool = manifest().tool!;
    for (const url of [
      null,
      'not a url',
      'http://dl.dell.com/tool.exe',
      'https://evil.example/tool.exe',
      'https://dl.dell.com.evil.example/tool.exe',
      'https://evildl.dell.com/tool.exe',
    ]) {
      expect(validateLaneManifest(manifest({ tool: { ...tool, url } }), allow).join(), String(url)).toMatch(/url/);
    }
    expect(validateLaneManifest(manifest(), allow)).toEqual([]);
  });

  it('an open gate requires every prerequisite to be pinned and allowlisted', () => {
    const tool = manifest().tool!;
    const prerequisites = [{ name: 'runtime', minVersion: '10.0.8', url: 'https://evil.example/r.exe', sha256: SHA }];
    expect(validateLaneManifest(manifest({ tool: { ...tool, prerequisites } }), allow).join()).toMatch(/runtime/);
  });

  it('an open category gate behind a closed lane gate still has to pass', () => {
    const issues = validateLaneManifest(manifest({ laneGate: 'closed', tool: null }), allow);
    expect(issues.join()).toMatch(/requires a tool/);
  });

  it('a code block beats an open gate', () => {
    expect(categoryOpenIn(manifest(), 'driver', false)).toBe(true);
    expect(categoryOpenIn(manifest({ codeBlocks: ['driver'] }), 'driver', false)).toBe(false);
  });

  it('a closed lane gate closes an open category gate', () => {
    expect(categoryOpenIn(manifest({ laneGate: 'closed' }), 'driver', false)).toBe(false);
  });

  it('a lab device opens closed gates, but never a code block', () => {
    const closed = manifest({ laneGate: 'closed', categoryGates: allClosed() });
    expect(categoryOpenIn(closed, 'bios', false)).toBe(false);
    expect(categoryOpenIn(closed, 'bios', true)).toBe(true);
    expect(categoryOpenIn({ ...closed, codeBlocks: ['bios'] }, 'bios', true)).toBe(false);
  });

  it('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS opens a real gate for a listed device only', () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS', 'lab-1');
    expect(isCategoryOpen('dell', 'driver', { deviceId: 'lab-1' })).toBe(true);
    expect(isLaneOpen('dell', { deviceId: 'lab-1' })).toBe(true);
    expect(openCategoriesForLane('dell', { deviceId: 'lab-1' })).toEqual([...OEM_CATEGORIES]);
    expect(isCategoryOpen('dell', 'driver', { deviceId: 'other' })).toBe(false);
    expect(isLaneOpen('dell', { deviceId: 'other' })).toBe(false);
    expect(isCategoryOpen('dell', 'driver')).toBe(false);
  });
});

describe('payloadToolFor', () => {
  it('is null until the tool is fully pinned, so the agent uses only what is installed', () => {
    expect(payloadToolFor(getLaneManifest('dell'))).toBeNull();
    expect(payloadToolFor(manifest({ tool: null }))).toBeNull();
    const tool = manifest().tool!;
    expect(payloadToolFor(manifest({ tool: { ...tool, url: null } }))).toBeNull();
    expect(payloadToolFor(manifest({
      tool: { ...tool, prerequisites: [{ name: 'runtime', minVersion: '1', url: null, sha256: null }] },
    }))).toBeNull();
  });

  it('a pinned tool satisfies the wire contract', () => {
    const parsed = oemUpdateRunPayloadSchema.safeParse({
      lane: 'dell',
      trigger: 'on_demand',
      occurrenceKey: null,
      categories: ['driver'],
      blockedUpdateIds: [],
      rebootControlled: false,
      notAfter: '2027-01-20T05:00:00.000Z',
      escrowedProtectorIds: [],
      tool: payloadToolFor(manifest()),
    });
    expect(parsed.success).toBe(true);
  });
});
