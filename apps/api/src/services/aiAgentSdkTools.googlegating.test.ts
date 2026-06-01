import { afterEach, describe, expect, it } from 'vitest';
import { googleToolDefinitions } from './aiAgentSdkTools';

// The Google Workspace helpdesk tools are only advertised to the model when
// GOOGLE_WORKSPACE_ENABLED is truthy. On instances without the flag they must
// not appear in the tool manifest at all (a per-org connection is still
// required at call time on top of this).
const getAuth = () => ({ user: { id: 'u1' }, orgId: 'o1' }) as any;
const getSession = () => undefined;

describe('Google tool registration gating', () => {
  const ORIG = process.env.GOOGLE_WORKSPACE_ENABLED;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.GOOGLE_WORKSPACE_ENABLED;
    else process.env.GOOGLE_WORKSPACE_ENABLED = ORIG;
  });

  it('registers no Google tools when the flag is unset', () => {
    delete process.env.GOOGLE_WORKSPACE_ENABLED;
    expect(googleToolDefinitions(getAuth, getSession, undefined, undefined)).toEqual([]);
  });

  it('treats a blank flag as disabled', () => {
    process.env.GOOGLE_WORKSPACE_ENABLED = '   ';
    expect(googleToolDefinitions(getAuth, getSession, undefined, undefined)).toEqual([]);
  });

  it('registers all 13 Google tools (correct names) when enabled', () => {
    process.env.GOOGLE_WORKSPACE_ENABLED = 'true';
    const names = googleToolDefinitions(getAuth, getSession, undefined, undefined).map((t) => t.name);
    expect(names).toEqual([
      'google_lookup_user',
      'google_reset_password',
      'google_suspend_user',
      'google_restore_user',
      'google_signout',
      'google_set_forwarding',
      'google_set_vacation',
      'google_update_user',
      'google_share_calendar',
      'google_offboard_user',
      'google_wipe_mobile_device',
      'google_security_drift',
      'google_email_report',
    ]);
  });
});
