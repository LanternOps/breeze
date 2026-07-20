import { describe, it, expect } from 'vitest';
import { requiresLiveSession } from './aiTools';

describe('requiresLiveSession', () => {
  it('is true for session-aware M365 mutation tools', () => {
    expect(requiresLiveSession('m365_disable_user')).toBe(true);
    expect(requiresLiveSession('m365_reset_password')).toBe(true);
  });
  it('is true for Google tools (never registered headless)', () => {
    expect(requiresLiveSession('google_suspend_user')).toBe(true);
    expect(requiresLiveSession('google_reset_password')).toBe(true);
  });
  it('is false for the registered Tier-1 M365 read tools', () => {
    expect(requiresLiveSession('m365_query_users')).toBe(false);
  });
  it('is false for stateless core tools', () => {
    expect(requiresLiveSession('execute_command')).toBe(false);
  });
  it('is false for an unknown name (not a recognized tool at all)', () => {
    expect(requiresLiveSession('not_a_real_tool')).toBe(false);
  });
});
