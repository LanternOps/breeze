import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./googleHelpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./googleHelpers')>();
  return {
    ...actual,
    loadSession: vi.fn(),
    loadGoogleConnection: vi.fn(),
    decryptConnectionKey: vi.fn(() => 'KEYJSON'),
  };
});
vi.mock('./googleClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./googleClient')>();
  return {
    ...actual,
    getDirectoryClient: vi.fn(),
    getGmailClient: vi.fn(),
    getCalendarClient: vi.fn(),
    getLicensingClient: vi.fn(),
  };
});
vi.mock('./email', () => ({ getEmailService: vi.fn() }));

import * as helpers from './googleHelpers';
import * as client from './googleClient';
import {
  googleAccountWipeMobileDeviceHandler,
  googleToolTiers,
  googleToolSearchHints,
} from './aiToolsGoogle';
import { TOOL_TIERS, SESSION_TOOL_DESCRIPTIONS } from './aiAgentSdkTools';
import { TOOL_PERMISSIONS, TIER3_FOUR_EYES_TOOLS } from './aiGuardrails';
import { GOOGLE_HEADLESS_ACTIONS } from './googleToolsHeadless';
import { ORG_WIDE_GOVERNANCE_TOOL_ACTIONS } from './actionIntents/orgWideGovernanceTools';
import { listProbedTools, getEffectProbe, __resetEffectProbesForTest } from './aiOperator/effectProbes';
import { registerGoogleEffectProbes } from './aiOperator/effectProbes/google';

const auth = {} as any;
const SESSION = 'sess-1';
const TOOL = 'google_account_wipe_mobile_device';

beforeEach(() => {
  vi.clearAllMocks();
  (helpers.loadSession as any).mockResolvedValue({ orgId: 'org-A' });
  (helpers.loadGoogleConnection as any).mockResolvedValue({
    orgId: 'org-A',
    status: 'active',
    adminEmail: 'admin@x.com',
    customerDomain: 'x.com',
  });
  (helpers.decryptConnectionKey as any).mockReturnValue('KEYJSON');
});

function arm(devices: Array<Record<string, unknown>>, primaryEmail = 'u@x.com') {
  const action = vi.fn().mockResolvedValue({});
  (client.getDirectoryClient as any).mockReturnValue({
    users: { get: vi.fn().mockResolvedValue({ data: { primaryEmail } }) },
    mobiledevices: { list: vi.fn().mockResolvedValue({ data: { mobiledevices: devices } }), action },
  });
  return action;
}

describe('google_account_wipe_mobile_device', () => {
  it('issues admin_account_wipe and NEVER admin_remote_wipe', async () => {
    const action = arm([{ resourceId: 'dev-1', email: ['u@x.com'] }]);
    const out = await googleAccountWipeMobileDeviceHandler({ userEmail: 'u@x.com', reason: 'offboarding' }, auth, SESSION);
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'dev-1', requestBody: { action: 'admin_account_wipe' } }),
    );
    expect(action).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: { action: 'admin_remote_wipe' } }),
    );
    expect(out).toContain('dev-1');
  });

  it('requires a reason', async () => {
    const action = arm([{ resourceId: 'dev-1', email: ['u@x.com'] }]);
    const out = await googleAccountWipeMobileDeviceHandler({ userEmail: 'u@x.com' }, auth, SESSION);
    expect(out).toContain('missing_reason');
    expect(action).not.toHaveBeenCalled();
  });

  it('only wipes devices whose account EXACTLY matches the resolved user', async () => {
    const action = arm(
      [
        { resourceId: 'ann-phone', email: ['ann@x.com'] },
        { resourceId: 'annette-phone', email: ['annette@x.com'] },
        { resourceId: 'no-email' },
      ],
      'ann@x.com',
    );
    await googleAccountWipeMobileDeviceHandler({ userEmail: 'Ann@x.com', reason: 'offboarding' }, auth, SESSION);
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'ann-phone', requestBody: { action: 'admin_account_wipe' } }),
    );
  });

  it('rejects a wildcard userEmail before wiping anything', async () => {
    const action = arm([]);
    const out = await googleAccountWipeMobileDeviceHandler({ userEmail: 'a*', reason: 'r' }, auth, SESSION);
    expect(out).toContain('invalid_user_email');
    expect(action).not.toHaveBeenCalled();
  });

  it('is a successful no-op when no devices are enrolled', async () => {
    const action = arm([]);
    const out = await googleAccountWipeMobileDeviceHandler({ userEmail: 'u@x.com', reason: 'r' }, auth, SESSION);
    expect(out).toContain('nothing to wipe');
    expect(action).not.toHaveBeenCalled();
  });

  it('is tier 3 everywhere the sibling is, with the sibling permission', () => {
    expect(googleToolTiers[TOOL]).toBe(3);
    expect(TOOL_TIERS[TOOL]).toBe(3);
    expect(TIER3_FOUR_EYES_TOOLS.has(TOOL)).toBe(true);
    expect(TOOL_PERMISSIONS[TOOL]).toEqual(TOOL_PERMISSIONS['google_wipe_mobile_device']);
    expect(TOOL_PERMISSIONS[TOOL]).toEqual({ resource: 'organizations', action: 'write' });
  });

  it('is headless-dispatchable', () => {
    expect(Object.keys(GOOGLE_HEADLESS_ACTIONS)).toContain(TOOL);
  });

  it('has an effect probe under its own name, the same one the sibling uses', () => {
    __resetEffectProbesForTest();
    registerGoogleEffectProbes();
    expect(listProbedTools()).toContain(TOOL);
    const probe = getEffectProbe(TOOL);
    expect(probe).toBeDefined();
    expect(probe).toBe(getEffectProbe('google_wipe_mobile_device'));
    __resetEffectProbesForTest();
  });

  it('describes the selective wipe, not a factory reset', () => {
    for (const d of [SESSION_TOOL_DESCRIPTIONS[TOOL], googleToolSearchHints[TOOL]]) {
      expect(d).toBeTruthy();
      expect(d).not.toMatch(/stolen|factory reset/i);
    }
    expect(SESSION_TOOL_DESCRIPTIONS[TOOL]).toContain('NOT erased');
  });

  it('is in the org-wide governance (site-restricted fail-closed) list', () => {
    expect(ORG_WIDE_GOVERNANCE_TOOL_ACTIONS.has(TOOL)).toBe(true);
  });
});
