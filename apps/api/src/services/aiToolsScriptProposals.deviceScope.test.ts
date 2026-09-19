/**
 * #6096 finding 12 — `get_script_proposal` resolved by org reach only
 * (`getScriptProposalForPrincipal`), so a device-bound AI run could read any
 * proposal in the org: its goal, its static-scan hits and its target device
 * list. A proposal is device-attributable via `targetDeviceIds`.
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

function auth(allowedDeviceIds?: string[], allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'ai_agent' },
    user: { id: 'u1' },
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedDeviceIds,
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

function mockRead(row: ReturnType<typeof proposal>) {
  // Awaiting the chain with no limit is the device->site scan the site axis
  // added (resolveSiteAllowedDeviceIds): dev-1 in site-1, dev-2 in site-2.
  mockDb.select.mockImplementation(() => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve([row]),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve([{ id: 'dev-1', siteId: 'site-1' }, { id: 'dev-2', siteId: 'site-2' }]).then(resolve),
    };
    return chain;
  });
}

describe('getScriptProposalForPrincipal — exact-device scope', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null for a proposal targeting only a sibling device', async () => {
    mockRead(proposal(['dev-2']));
    expect(await getScriptProposalForPrincipal(auth(['dev-1'], ['site-1']), 'prop-1')).toBeNull();
  });

  it('returns null for a device-LESS analysis run too', async () => {
    mockRead(proposal(['dev-2']));
    expect(await getScriptProposalForPrincipal(auth(['dev-1'], undefined), 'prop-1')).toBeNull();
  });

  it('still resolves a proposal targeting the run\'s OWN device', async () => {
    mockRead(proposal(['dev-1']));
    expect(await getScriptProposalForPrincipal(auth(['dev-1'], ['site-1']), 'prop-1')).not.toBeNull();
  });

  it('is unchanged for an unrestricted caller', async () => {
    mockRead(proposal(['dev-2']));
    expect(await getScriptProposalForPrincipal(auth(undefined, undefined), 'prop-1')).not.toBeNull();
  });
});

describe('get_script_proposal tool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports not_found for a sibling-only proposal', async () => {
    mockRead(proposal(['dev-2']));
    const out = JSON.parse(await handlerFor('get_script_proposal')({ proposalId: 'prop-1' }, auth(['dev-1'], ['site-1'])));
    expect(out.error).toContain('not_found');
    expect(JSON.stringify(out)).not.toContain('SECRET-GOAL');
  });

  it('filters targetDeviceIds down to the allowlist on a mixed proposal', async () => {
    mockRead(proposal(['dev-1', 'dev-2']));
    const out = JSON.parse(await handlerFor('get_script_proposal')({ proposalId: 'prop-1' }, auth(['dev-1'], ['site-1'])));
    expect(out.targetDeviceIds).toEqual(['dev-1']);
  });
});
