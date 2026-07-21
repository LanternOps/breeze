import { describe, it, expect } from 'vitest';
import { buildHelperSystemPrompt } from './helperAiAgent';

const BASE = {
  hostname: 'host-1',
  deviceId: 'device-1',
  orgId: 'org-1',
  permissionLevel: 'basic' as const,
  osType: 'linux',
  osVersion: '6.8',
  agentVersion: '1.0.0',
};

describe('buildHelperSystemPrompt — device capabilities vs client tools', () => {
  it('advertises the device-capability section for a normal (no client-tools) session', () => {
    const prompt = buildHelperSystemPrompt({ ...BASE, hasClientTools: false });
    expect(prompt).toContain('## Your Capabilities');
    // basic permission includes get_device_details → its capability line.
    expect(prompt).toContain('detailed hardware, software, and network information');
    expect(prompt).not.toContain('## Client Tools');
  });

  it('suppresses the device-capability section when the session declared client tools', () => {
    const prompt = buildHelperSystemPrompt({ ...BASE, hasClientTools: true });
    // The device toolset is unavailable to a client-tools session, so its
    // capability advertisement must be gone — no "what can you do?" mismatch.
    expect(prompt).not.toContain('## Your Capabilities');
    expect(prompt).not.toContain('detailed hardware, software, and network information');
    // The generic client-tools paragraph is still present.
    expect(prompt).toContain('## Client Tools');
    expect(prompt).toContain('client-provided tools');
    // Core rules survive.
    expect(prompt).toContain('## Important Rules');
  });
});
