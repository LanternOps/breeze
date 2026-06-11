import { afterEach, describe, expect, it } from 'vitest';
import { m365ToolDefinitions } from './aiAgentSdkTools';

// The 5 M365 helpdesk tools are only advertised to the model when the Delegant
// integration is configured (DELEGANT_BASE_URL set). On instances with no M365
// wiring they must not appear in the tool manifest at all.
const getAuth = () => ({ user: { id: 'u1' }, orgId: 'o1' }) as any;
const getSession = () => undefined;

describe('M365 tool registration gating', () => {
  const ORIG = process.env.DELEGANT_BASE_URL;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.DELEGANT_BASE_URL;
    else process.env.DELEGANT_BASE_URL = ORIG;
  });

  it('registers no M365 tools when DELEGANT_BASE_URL is unset', () => {
    delete process.env.DELEGANT_BASE_URL;
    expect(m365ToolDefinitions(getAuth, getSession, undefined, undefined)).toEqual([]);
  });

  it('treats a blank/whitespace DELEGANT_BASE_URL as unconfigured', () => {
    process.env.DELEGANT_BASE_URL = '   ';
    expect(m365ToolDefinitions(getAuth, getSession, undefined, undefined)).toEqual([]);
  });

  it('registers all 5 M365 tools (correct names) when DELEGANT_BASE_URL is set', () => {
    process.env.DELEGANT_BASE_URL = 'https://delegant.example';
    const names = m365ToolDefinitions(getAuth, getSession, undefined, undefined).map((t) => t.name);
    expect(names).toEqual([
      'm365_lookup_user',
      'm365_recent_signins',
      'm365_list_group_memberships',
      'm365_disable_user',
      'm365_reset_password',
    ]);
  });
});
