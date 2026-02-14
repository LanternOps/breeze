export interface WheelAccumulator {
  pixelRemainder: number;
}

export const DEFAULT_WHEEL_ACCUMULATOR: WheelAccumulator = { pixelRemainder: 0 };

// Normalizes WheelEvent deltas into discrete scroll steps expected by the agent.
// Positive steps = scroll down (matches browser deltaY sign).
export function wheelDeltaToSteps(
  acc: WheelAccumulator,
  deltaY: number,
  deltaMode: number,
): { steps: number; acc: WheelAccumulator } {
  // https://developer.mozilla.org/en-US/docs/Web/API/WheelEvent/deltaMode
  // 0: pixels, 1: lines, 2: pages
  if (deltaMode === 0) {
    const pixelsPerStep = 100;
    const total = acc.pixelRemainder + deltaY;
    const stepsFloat = total / pixelsPerStep;
    const steps = stepsFloat > 0 ? Math.floor(stepsFloat) : Math.ceil(stepsFloat);
    const remainder = total - steps * pixelsPerStep;
    return { steps, acc: { pixelRemainder: remainder } };
  }

  // For line/page scrolling we don't accumulate; these are already semantic units.
  if (deltaMode === 1) {
    const steps = deltaY > 0 ? Math.floor(deltaY) : Math.ceil(deltaY);
    return { steps, acc: DEFAULT_WHEEL_ACCUMULATOR };
  }

  if (deltaMode === 2) {
    const pageSteps = deltaY > 0 ? Math.floor(deltaY) : Math.ceil(deltaY);
    return { steps: pageSteps * 10, acc: DEFAULT_WHEEL_ACCUMULATOR };
  }

  // Unknown mode: best-effort.
  return { steps: deltaY > 0 ? Math.floor(deltaY) : Math.ceil(deltaY), acc };
}

