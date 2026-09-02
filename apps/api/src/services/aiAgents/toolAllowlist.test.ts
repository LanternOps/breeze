// apps/api/src/services/aiAgents/toolAllowlist.test.ts
import { describe, expect, it } from 'vitest';
import { isToolAllowlisted } from './toolAllowlist';

describe('isToolAllowlisted', () => {
  it('admits every action of a bare tool entry', () => {
    expect(isToolAllowlisted(['manage_services'], 'manage_services', 'restart')).toBe(true);
    expect(isToolAllowlisted(['manage_services'], 'manage_services', 'stop')).toBe(true);
  });

  it('admits the specific tool:action entry and nothing else of that tool', () => {
    expect(isToolAllowlisted(['manage_services:restart'], 'manage_services', 'restart')).toBe(true);
    expect(isToolAllowlisted(['manage_services:restart'], 'manage_services', 'stop')).toBe(false);
  });

  it('refuses a tool that is absent from the allowlist entirely', () => {
    expect(isToolAllowlisted(['get_device_details'], 'manage_services', 'restart')).toBe(false);
    expect(isToolAllowlisted([], 'manage_services', 'restart')).toBe(false);
  });

  // A tool with no action discriminator (the sweep union's
  // `remediate_vulnerability`) can only ever be admitted by a bare entry.
  it('matches on the bare entry only when the action is undefined or null', () => {
    expect(isToolAllowlisted(['remediate_vulnerability'], 'remediate_vulnerability')).toBe(true);
    expect(isToolAllowlisted(['remediate_vulnerability'], 'remediate_vulnerability', null)).toBe(true);
    expect(isToolAllowlisted(['remediate_vulnerability:apply'], 'remediate_vulnerability')).toBe(false);
    expect(isToolAllowlisted(['remediate_vulnerability:apply'], 'remediate_vulnerability', null)).toBe(false);
  });

  // A scoped entry must never be admitted by prefix: `manage_servicesX` and
  // `manage_services:restart` share no admitting relationship with a request
  // for a DIFFERENT tool whose name happens to start the same way.
  it('never matches a different tool by prefix', () => {
    expect(isToolAllowlisted(['manage_services'], 'manage_services_v2', 'restart')).toBe(false);
    expect(isToolAllowlisted(['manage_services:restart'], 'manage', 'services:restart')).toBe(false);
  });
});
