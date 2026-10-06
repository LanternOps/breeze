import { describe, expect, it } from 'vitest';
import { PUBLIC_DEVICE_FIELDS } from '../routes/devices/helpers';
import { compactToolResultForChat, MAX_TOOL_RESULT_CHARS } from './aiToolOutput';

// #7968: get_device_details emits `device` in PUBLIC_DEVICE_FIELDS order, so the
// 15-key compaction tier dropped osVersion/agentVersion/status/lastSeenAt.
describe('get_device_details compaction (#7968)', () => {
  const device: Record<string, unknown> = {};
  for (const k of PUBLIC_DEVICE_FIELDS) device[k] = `v-${k}`;
  device.siteName = 'HQ';

  // Enough bulk to push past the first two tiers into the 15-key tier.
  const payload = JSON.stringify({
    device,
    networkInterfaces: Array.from({ length: 16 }, (_, i) => ({ name: `eth${i}`, mac: 'x'.repeat(120) })),
    disks: Array.from({ length: 16 }, (_, i) => ({ mount: `/d${i}`, note: 'y'.repeat(120) })),
    memoryModules: Array.from({ length: 16 }, (_, i) => ({ slot: i, part: 'z'.repeat(120) })),
  });

  it('keeps core identity fields at every tier', () => {
    expect(payload.length).toBeGreaterThan(MAX_TOOL_RESULT_CHARS);
    const out = JSON.parse(compactToolResultForChat('get_device_details', payload));
    // Guard against the vacuous case: the structured (non-sentinel) tier was used.
    expect(out.device).toBeDefined();
    for (const k of ['hostname', 'osType', 'osVersion', 'status', 'lastSeenAt', 'agentVersion']) {
      expect(out.device[k], k).toBe(`v-${k}`);
    }
  });
});
