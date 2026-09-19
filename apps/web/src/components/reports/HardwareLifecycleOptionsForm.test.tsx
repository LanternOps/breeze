import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HARDWARE_LIFECYCLE_OPTIONS,
  hardwareLifecycleOptionsFromConfig,
} from './HardwareLifecycleOptionsForm';

// hardwareLifecycleOptionsFromConfig reads a persisted report `config` back
// into option state for the edit page. It must never hand the number inputs
// an out-of-range or non-numeric value (the inputs enforce min=1/max=15, but
// a stored config can predate that clamp or be hand-edited), and must treat
// the two toggles as "on unless explicitly false" — never falling back to a
// default the moment a legacy config used a non-boolean value.
describe('hardwareLifecycleOptionsFromConfig', () => {
  it('clamps a stored 0 up to the minimum of 1', () => {
    expect(hardwareLifecycleOptionsFromConfig({ replaceAgeYears: 0 }).replaceAgeYears).toBe(1);
    expect(hardwareLifecycleOptionsFromConfig({ serverReplaceAgeYears: 0 }).serverReplaceAgeYears).toBe(1);
  });

  it('clamps a stored 16 down to the maximum of 15', () => {
    expect(hardwareLifecycleOptionsFromConfig({ replaceAgeYears: 16 }).replaceAgeYears).toBe(15);
    expect(hardwareLifecycleOptionsFromConfig({ serverReplaceAgeYears: 16 }).serverReplaceAgeYears).toBe(15);
  });

  it('falls back to the default for a non-number value like the string "5" — no coercion, only numbers pass', () => {
    expect(hardwareLifecycleOptionsFromConfig({ replaceAgeYears: '5' }).replaceAgeYears)
      .toBe(DEFAULT_HARDWARE_LIFECYCLE_OPTIONS.replaceAgeYears);
    expect(hardwareLifecycleOptionsFromConfig({ serverReplaceAgeYears: '6' }).serverReplaceAgeYears)
      .toBe(DEFAULT_HARDWARE_LIFECYCLE_OPTIONS.serverReplaceAgeYears);
  });

  it('falls back to the default for NaN (a number, but not finite/usable)', () => {
    expect(hardwareLifecycleOptionsFromConfig({ replaceAgeYears: NaN }).replaceAgeYears)
      .toBe(DEFAULT_HARDWARE_LIFECYCLE_OPTIONS.replaceAgeYears);
  });

  it('falls back to the default when the key is absent entirely', () => {
    expect(hardwareLifecycleOptionsFromConfig({}).replaceAgeYears)
      .toBe(DEFAULT_HARDWARE_LIFECYCLE_OPTIONS.replaceAgeYears);
    expect(hardwareLifecycleOptionsFromConfig({}).serverReplaceAgeYears)
      .toBe(DEFAULT_HARDWARE_LIFECYCLE_OPTIONS.serverReplaceAgeYears);
  });

  it('the include toggles are "on unless === false" — any other value, even a falsy one, stays on', () => {
    expect(hardwareLifecycleOptionsFromConfig({ includeManualAssets: false }).includeManualAssets).toBe(false);
    expect(hardwareLifecycleOptionsFromConfig({ includeManualAssets: true }).includeManualAssets).toBe(true);
    expect(hardwareLifecycleOptionsFromConfig({}).includeManualAssets).toBe(true);
    // A non-boolean legacy value (or literal 0) is not `=== false`, so it
    // reads as "on" rather than silently reverting to a default.
    expect(hardwareLifecycleOptionsFromConfig({ includeManualAssets: 0 }).includeManualAssets).toBe(true);
    expect(hardwareLifecycleOptionsFromConfig({ includeOtherEquipment: false }).includeOtherEquipment).toBe(false);
    expect(hardwareLifecycleOptionsFromConfig({ includeOtherEquipment: 'no' }).includeOtherEquipment).toBe(true);
  });
});
