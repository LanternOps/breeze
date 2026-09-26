import { describe, expect, it } from 'vitest';
import {
  REMEDIATION_PREVIEW_SAMPLE_DEVICES,
  REMEDIATION_PREVIEW_TOP_SOFTWARE,
  summarizeRemediationTargets,
} from './softwarePolicyRemediationPreview';

const dev = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

describe('summarizeRemediationTargets (#3616)', () => {
  it('counts only devices with at least one unauthorized item as uninstall targets', () => {
    const summary = summarizeRemediationTargets([
      {
        deviceId: dev(1),
        hostname: 'alpha',
        violations: [{ type: 'unauthorized', software: { name: 'Zoom', version: '5.1' } }],
      },
      {
        // A `missing`-only row is a violation but the uninstall worker does
        // nothing for it — it must not inflate the blast radius or the target set.
        deviceId: dev(2),
        hostname: 'bravo',
        violations: [{ type: 'missing', rule: { name: 'Chrome' } }],
      },
    ]);

    expect(summary.deviceIds).toEqual([dev(1)]);
    expect(summary.deviceCount).toBe(1);
    expect(summary.uninstallCount).toBe(1);
  });

  it('dedupes a device\'s repeated (name, version) exactly like the worker does', () => {
    const summary = summarizeRemediationTargets([
      {
        deviceId: dev(1),
        hostname: 'alpha',
        violations: [
          { type: 'unauthorized', software: { name: 'Zoom', version: '5.1' } },
          { type: 'unauthorized', software: { name: ' zoom ', version: '5.1' } },
          { type: 'unauthorized', software: { name: 'Zoom', version: '5.2' } },
          { type: 'unauthorized', software: { name: '   ' } },
        ],
      },
    ]);

    expect(summary.uninstallCount).toBe(2);
    expect(summary.sampleDevices[0]!.uninstalls).toEqual([
      { name: 'Zoom', version: '5.1' },
      { name: 'Zoom', version: '5.2' },
    ]);
  });

  it('aggregates software across devices by name, most-affected first', () => {
    const summary = summarizeRemediationTargets([
      { deviceId: dev(1), hostname: 'a', violations: [
        { type: 'unauthorized', software: { name: 'Zoom', version: '1' } },
        { type: 'unauthorized', software: { name: 'Steam' } },
      ] },
      { deviceId: dev(2), hostname: 'b', violations: [
        { type: 'unauthorized', software: { name: 'zoom', version: '2' } },
      ] },
    ]);

    expect(summary.software).toEqual([
      { name: 'Zoom', deviceCount: 2 },
      { name: 'Steam', deviceCount: 1 },
    ]);
    expect(summary.softwareDistinctCount).toBe(2);
  });

  it('bounds the sample and the software list but keeps every target id', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      deviceId: dev(i + 1),
      hostname: `host-${i}`,
      violations: [{ type: 'unauthorized', software: { name: `App ${i}` } }],
    }));
    const summary = summarizeRemediationTargets(rows);

    expect(summary.deviceIds).toHaveLength(40);
    expect(summary.sampleDevices).toHaveLength(REMEDIATION_PREVIEW_SAMPLE_DEVICES);
    expect(summary.software).toHaveLength(REMEDIATION_PREVIEW_TOP_SOFTWARE);
    expect(summary.softwareDistinctCount).toBe(40);
  });

  it('tolerates non-array / malformed violations without throwing', () => {
    const summary = summarizeRemediationTargets([
      { deviceId: dev(1), hostname: 'a', violations: null },
      { deviceId: dev(2), hostname: 'b', violations: [null, 'x', { type: 'unauthorized' }] as unknown[] },
    ]);
    expect(summary.deviceCount).toBe(0);
    expect(summary.deviceIds).toEqual([]);
  });

  it('collapses a device that appears on two rows into one target', () => {
    const summary = summarizeRemediationTargets([
      { deviceId: dev(1), hostname: 'a', violations: [{ type: 'unauthorized', software: { name: 'X' } }] },
      { deviceId: dev(1), hostname: 'a', violations: [{ type: 'unauthorized', software: { name: 'Y' } }] },
    ]);
    expect(summary.deviceIds).toEqual([dev(1)]);
    expect(summary.uninstallCount).toBe(2);
  });
});
