import {
  OEM_CATEGORIES,
  OEM_LANES,
  type OemCategory,
  type OemLane,
  type OemUpdateRunPayload,
} from '@breeze/shared';
import { isLabDevice } from './flags';

/**
 * The vendor tool manifest (#11065): one entry per lane, in code, updated by
 * normal releases. Vendor binaries are never bundled, mirrored or hosted by
 * Breeze; this only says which vendor build to expect and where the vendor
 * serves it. The agent still enforces its own compiled publisher and host
 * allowlist, so a wrong entry here cannot make it fetch or run anything else.
 *
 * Every gate is closed. Only a lab wave opens one, and
 * `toolManifest.test.ts` refuses an open gate without a real SHA-256 and an
 * allowlisted URL.
 */

export type GateState = 'open' | 'closed';

export type ToolPrerequisiteManifest = {
  name: string;
  minVersion: string;
  url: string | null;
  sha256: string | null;
};

export type ToolManifest = {
  version: string;
  minSafeVersion: string;
  supportedRange: { min: string; maxExclusive: string };
  /** Null until the lab wave records the vendor's real URL. */
  url: string | null;
  sha256: string | null;
  prerequisites: ToolPrerequisiteManifest[];
};

export type LaneManifest = {
  lane: OemLane;
  laneGate: GateState;
  categoryGates: Record<OemCategory, GateState>;
  /** The code-level kill switch: beats an open gate and the lab override. */
  codeBlocks: OemCategory[];
  tool: ToolManifest | null;
};

/** The agent's embedded allowlist for one lane (`agent/internal/oemupdates/allowlist.json`). */
export type LaneToolAllowlist = { hosts: string[] };

const ALL_CLOSED: Record<OemCategory, GateState> = Object.freeze({
  bios: 'closed',
  firmware: 'closed',
  driver: 'closed',
  application: 'closed',
});

/** The lanes whose agent code has shipped. W16 adds Lenovo. */
export const SHIPPED_OEM_LANES: readonly OemLane[] = Object.freeze(['dell', 'surface', 'hp']);

/**
 * Lanes with no vendor tool. Surface updates come through Windows Update, so the
 * agent installs no software and there is nothing to pin. Its entry can open a
 * gate with `tool: null`, and may never name a tool.
 */
const TOOL_FREE_OEM_LANES: readonly OemLane[] = Object.freeze(['surface']);

const MANIFEST: Readonly<Record<OemLane, LaneManifest>> = Object.freeze({
  dell: {
    lane: 'dell',
    laneGate: 'closed',
    categoryGates: ALL_CLOSED,
    codeBlocks: [],
    // Floor and pin from vendor research; W10 re-checks them and records url and sha256.
    tool: {
      version: '5.7.2',
      minSafeVersion: '5.7.1',
      supportedRange: { min: '5.7.1', maxExclusive: '6.0.0' },
      url: null,
      sha256: null,
      prerequisites: [{ name: 'dotnet-desktop-runtime', minVersion: '10.0.8', url: null, sha256: null }],
    },
  },
  surface: { lane: 'surface', laneGate: 'closed', categoryGates: ALL_CLOSED, codeBlocks: [], tool: null },
  hp: {
    lane: 'hp',
    laneGate: 'closed',
    categoryGates: ALL_CLOSED,
    codeBlocks: [],
    // HP Image Assistant. Floor from CVE-2025-13492, pin from HP's page at research
    // time. W14 re-checks them, decides the licence (H1), and records url and sha256.
    tool: {
      version: '5.3.7',
      minSafeVersion: '5.3.3',
      supportedRange: { min: '5.3.3', maxExclusive: '6.0.0' },
      url: null,
      sha256: null,
      prerequisites: [],
    },
  },
  lenovo: { lane: 'lenovo', laneGate: 'closed', categoryGates: ALL_CLOSED, codeBlocks: [], tool: null },
});

export function getLaneManifest(lane: OemLane): LaneManifest {
  return MANIFEST[lane];
}

/** Pure form of the gate rule, so it can be tested against an open manifest. */
export function categoryOpenIn(manifest: LaneManifest, category: OemCategory, labDevice: boolean): boolean {
  if (manifest.codeBlocks.includes(category)) return false;
  if (labDevice) return true;
  return manifest.laneGate === 'open' && manifest.categoryGates[category] === 'open';
}

function labDeviceFor(opts?: { deviceId?: string }): boolean {
  return opts?.deviceId !== undefined && isLabDevice(opts.deviceId);
}

export function isLaneOpen(lane: OemLane, opts?: { deviceId?: string }): boolean {
  return labDeviceFor(opts) || getLaneManifest(lane).laneGate === 'open';
}

export function isCategoryOpen(lane: OemLane, category: OemCategory, opts?: { deviceId?: string }): boolean {
  return categoryOpenIn(getLaneManifest(lane), category, labDeviceFor(opts));
}

export function openCategoriesForLane(lane: OemLane, opts?: { deviceId?: string }): OemCategory[] {
  return OEM_CATEGORIES.filter((category) => isCategoryOpen(lane, category, opts));
}

const SHA256 = /^[0-9a-f]{64}$/;

function urlIssue(label: string, url: string | null, allow: LaneToolAllowlist): string | null {
  if (!url) return `${label}: an open gate requires a url`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${label}: url is not a valid url`;
  }
  if (parsed.protocol !== 'https:') return `${label}: url must be https`;
  if (!allow.hosts.includes(parsed.hostname)) return `${label}: url host ${parsed.hostname} is not on the agent allowlist`;
  return null;
}

/** Empty when the entry is safe. An entry with every gate closed has nothing to prove. */
export function validateLaneManifest(manifest: LaneManifest, allow: LaneToolAllowlist): string[] {
  if (TOOL_FREE_OEM_LANES.includes(manifest.lane)) {
    return manifest.tool ? [`${manifest.lane}: this lane installs no software, so it must not name a tool`] : [];
  }
  const opensAnything = manifest.laneGate === 'open'
    || OEM_CATEGORIES.some((category) => manifest.categoryGates[category] === 'open');
  if (!opensAnything) return [];
  const { lane, tool } = manifest;
  if (!tool) return [`${lane}: an open gate requires a tool`];

  const issues: string[] = [];
  const url = urlIssue(`${lane}: tool`, tool.url, allow);
  if (url) issues.push(url);
  if (!tool.sha256 || !SHA256.test(tool.sha256)) issues.push(`${lane}: tool: an open gate requires a 64-hex sha256`);
  for (const prerequisite of tool.prerequisites) {
    const label = `${lane}: prerequisite ${prerequisite.name}`;
    const prerequisiteUrl = urlIssue(label, prerequisite.url, allow);
    if (prerequisiteUrl) issues.push(prerequisiteUrl);
    if (!prerequisite.sha256 || !SHA256.test(prerequisite.sha256)) issues.push(`${label}: requires a 64-hex sha256`);
  }
  return issues;
}

/**
 * The payload's `tool`, or null until it is fully pinned. Null means the agent
 * uses only a tool that is already installed and in its own range, and reports
 * `tool_unavailable` otherwise.
 */
export function payloadToolFor(manifest: LaneManifest): OemUpdateRunPayload['tool'] {
  const { tool } = manifest;
  if (!tool?.url || !tool.sha256) return null;
  const prerequisites: NonNullable<OemUpdateRunPayload['tool']>['prerequisites'] = [];
  for (const prerequisite of tool.prerequisites) {
    if (!prerequisite.url || !prerequisite.sha256) return null;
    prerequisites.push({
      name: prerequisite.name,
      minVersion: prerequisite.minVersion,
      url: prerequisite.url,
      sha256: prerequisite.sha256,
    });
  }
  return {
    version: tool.version,
    minSafeVersion: tool.minSafeVersion,
    supportedRange: tool.supportedRange,
    url: tool.url,
    sha256: tool.sha256,
    prerequisites,
  };
}

/** Narrows an untrusted string (a queued payload) to a lane. */
export function asOemLane(value: unknown): OemLane | null {
  return typeof value === 'string' && (OEM_LANES as readonly string[]).includes(value) ? (value as OemLane) : null;
}
