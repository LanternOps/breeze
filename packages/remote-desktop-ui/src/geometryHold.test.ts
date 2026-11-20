import { describe, expect, it } from 'vitest';
import { GEOMETRY_HOLD_MAX_MS, GeometryHold } from './geometryHold';

const resolutionChange = { type: 'monitor_switched', index: 0, width: 2560, height: 1440, reason: 'resolution_change' };

describe('GeometryHold (#11754)', () => {
  it('holds nothing before any announcement', () => {
    const hold = new GeometryHold();
    expect(hold.shouldHold(1920, 1080, 0)).toBe(false);
  });

  it('holds pointer input after a resolution change until a frame at the new size is decoded', () => {
    const hold = new GeometryHold();
    hold.onControlMessage(resolutionChange, 1000);
    // Still showing the old stream: a click here would map into the old size.
    expect(hold.shouldHold(1920, 1080, 1010)).toBe(true);
    // The decoder reached the announced size: release, and stay released.
    expect(hold.shouldHold(2560, 1440, 1050)).toBe(false);
    expect(hold.shouldHold(1920, 1080, 1060)).toBe(false);
  });

  it('gives up holding after the bound, so a mismatch can never freeze input', () => {
    const hold = new GeometryHold();
    hold.onControlMessage(resolutionChange, 1000);
    expect(hold.shouldHold(1920, 1080, 1000 + GEOMETRY_HOLD_MAX_MS - 1)).toBe(true);
    expect(hold.shouldHold(1920, 1080, 1000 + GEOMETRY_HOLD_MAX_MS)).toBe(false);
    expect(hold.shouldHold(1920, 1080, 1000 + GEOMETRY_HOLD_MAX_MS + 5000)).toBe(false);
  });

  it('does not hold for a plain monitor switch, and a monitor switch ends a pending hold', () => {
    const hold = new GeometryHold();
    hold.onControlMessage({ type: 'monitor_switched', index: 1, width: 1280, height: 1024 }, 0);
    expect(hold.shouldHold(1920, 1080, 10)).toBe(false);

    hold.onControlMessage(resolutionChange, 100);
    hold.onControlMessage({ type: 'monitor_switched', index: 1, width: 1280, height: 1024 }, 110);
    expect(hold.shouldHold(1920, 1080, 120)).toBe(false);
  });

  it('ignores a resolution change without a usable size', () => {
    const hold = new GeometryHold();
    hold.onControlMessage({ type: 'monitor_switched', reason: 'resolution_change', width: 0, height: 1440 }, 0);
    hold.onControlMessage({ type: 'monitor_switched', reason: 'resolution_change', width: '2560', height: 1440 }, 0);
    expect(hold.shouldHold(1920, 1080, 10)).toBe(false);
  });

  it('ignores other control messages', () => {
    const hold = new GeometryHold();
    hold.onControlMessage(resolutionChange, 0);
    hold.onControlMessage({ type: 'input_epoch', epoch: 5 }, 10);
    expect(hold.shouldHold(1920, 1080, 20)).toBe(true);
  });
});
