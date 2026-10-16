import { describe, expect, it } from 'vitest';
import { capabilitySnapshot } from './capabilities';
import { bitdefenderAdapter } from './bitdefender/adapter';

describe('capabilitySnapshot', () => {
  it('is the adapter capability keys plus the key-specific degradation notes from the last test', () => {
    expect(capabilitySnapshot(bitdefenderAdapter, ['quarantine: API not enabled on key'])).toEqual([
      'tenants:partner',
      'detections:poll_and_push',
      'installer:none',
      'action:isolate',
      'action:unisolate',
      'action:scan',
      'note:quarantine: API not enabled on key',
    ]);
  });

  it('no notes -> keys only', () => {
    expect(capabilitySnapshot(bitdefenderAdapter, [])).toEqual([
      'tenants:partner', 'detections:poll_and_push', 'installer:none',
      'action:isolate', 'action:unisolate', 'action:scan',
    ]);
  });
});
