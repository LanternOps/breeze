/**
 * Audit 2026-09-17 §1.1 — `scopedTargetDeviceIds` branched on
 * `auth.allowedDeviceIds` ONLY, so `get_script_proposal` handed a site-restricted
 * technician the full proposal (goal, script intent, static-scan hits, target
 * device ids) for devices in sites they cannot access: the helper returned
 * `null` (= no narrowing) for exactly that caller shape.
 *
 * Both axes now apply, via `scopeDeviceIdsToCaller` (their INTERSECTION).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../config/env', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  aiScriptAuthoringEnabled: () => true,
}));

import { db } from '../db';
import { getScriptProposalForPrincipal } from './scriptProposals';
import { registerScriptProposalTools } from './aiToolsScriptProposals';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerScriptProposalTools(reg);
  return reg.get(name)!.handler;
}

/** A HUMAN technician restricted to sites — never carries `allowedDeviceIds`. */
function human(allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'user' },
    user: { id: 'u1' },
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  } as unknown as AuthContext;
}

function proposal(targetDeviceIds: string[]) {
  return {
    id: 'prop-1', orgId: 'org-1', status: 'pending', riskTier: 'medium',
    goal: 'SECRET-GOAL', expectedEffect: 'e', language: 'powershell', runAs: 'system',
    timeoutSeconds: 60, targetDeviceIds, basicHits: [], strictHits: [], touchClasses: [],
    scannerVersion: 1, decidedBy: null, decidedAt: null, decisionNote: null,
    intentId: null, verifiedAt: null, verificationResult: null, expiresAt: null,
  };
}

/** dev-1 lives in site-1, dev-2 in site-2. */
const ORG_DEVICES = [{ id: 'dev-1', siteId: 'site-1' }, { id: 'dev-2', siteId: 'site-2' }];
let deviceScans = 0;

function mockRead(row: ReturnType<typeof proposal>) {
  deviceScans = 0;
  mockDb.select.mockImplementation((cols?: any) => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve([row]),
      // Awaiting the chain with no limit = the device→site scan.
      then: (resolve: (v: unknown) => unknown) => {
        if (cols !== undefined) deviceScans += 1;
        return Promise.resolve(ORG_DEVICES).then(resolve);
      },
    };
    return chain;
  });
}

describe('getScriptProposalForPrincipal — site axis', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null for a proposal targeting only a device in another site', async () => {
    mockRead(proposal(['dev-2']));
    expect(await getScriptProposalForPrincipal(human(['site-1']), 'prop-1')).toBeNull();
  });

  it('returns null for a proposal targeting NO devices (not attributable)', async () => {
    mockRead(proposal([]));
    expect(await getScriptProposalForPrincipal(human(['site-1']), 'prop-1')).toBeNull();
  });

  it('still resolves a proposal targeting a device in the human\'s OWN site', async () => {
    mockRead(proposal(['dev-1']));
    expect(await getScriptProposalForPrincipal(human(['site-1']), 'prop-1')).not.toBeNull();
  });

  it('is unchanged for an unrestricted human, with NO device scan', async () => {
    mockRead(proposal(['dev-2']));
    expect(await getScriptProposalForPrincipal(human(undefined), 'prop-1')).not.toBeNull();
    expect(deviceScans).toBe(0);
  });
});

describe('get_script_proposal tool — site axis', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports not_found for an out-of-site proposal and leaks nothing', async () => {
    mockRead(proposal(['dev-2']));
    const out = JSON.parse(await handlerFor('get_script_proposal')({ proposalId: 'prop-1' }, human(['site-1'])));
    expect(out.error).toContain('not_found');
    expect(JSON.stringify(out)).not.toContain('SECRET-GOAL');
  });

  it('echoes only the target devices inside the human\'s sites', async () => {
    mockRead(proposal(['dev-1', 'dev-2']));
    const out = JSON.parse(await handlerFor('get_script_proposal')({ proposalId: 'prop-1' }, human(['site-1'])));
    expect(out.targetDeviceIds).toEqual(['dev-1']);
  });
});
