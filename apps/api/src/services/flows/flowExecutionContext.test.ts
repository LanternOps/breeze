import { describe, expect, it } from 'vitest';
import { currentFlowExecutionFrame, outsideFlowExecutionContext, withFlowExecutionContext } from './flowExecutionContext';

const RUN_ID = '0b5b3f0e-6a55-4a59-9d8e-3c2b1a000001';

describe('flowExecutionContext (Decision 14)', () => {
  it('outside a frame there is no frame', () => {
    expect(currentFlowExecutionFrame()).toBeUndefined();
  });

  // #11348 — the alert outbox publishes events other work staged; a drain
  // started inside a flow step must not lend that step's frame to them.
  it('outsideFlowExecutionContext hides the frame from sync and awaited work, then restores it', async () => {
    await withFlowExecutionContext({ runId: RUN_ID, chainDepth: 2 }, async () => {
      expect(outsideFlowExecutionContext(() => currentFlowExecutionFrame())).toBeUndefined();
      const seen = await outsideFlowExecutionContext(async () => {
        await new Promise((r) => setTimeout(r, 1));
        return currentFlowExecutionFrame();
      });
      expect(seen).toBeUndefined();
      expect(currentFlowExecutionFrame()).toEqual({ runId: RUN_ID, chainDepth: 2 });
    });
    expect(outsideFlowExecutionContext(() => 'no frame either way')).toBe('no frame either way');
  });

  it('exposes the frame to everything awaited inside it, and only there', async () => {
    const seen: Array<unknown> = [];
    const out = await withFlowExecutionContext({ runId: RUN_ID, chainDepth: 2 }, async () => {
      seen.push(currentFlowExecutionFrame());
      await new Promise((r) => setTimeout(r, 1));
      seen.push(currentFlowExecutionFrame());
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(seen).toEqual([{ runId: RUN_ID, chainDepth: 2 }, { runId: RUN_ID, chainDepth: 2 }]);
    expect(currentFlowExecutionFrame()).toBeUndefined();
  });

  it('a nested frame replaces the outer one for its own extent', async () => {
    const OTHER = '0b5b3f0e-6a55-4a59-9d8e-3c2b1a000002';
    await withFlowExecutionContext({ runId: RUN_ID, chainDepth: 0 }, async () => {
      await withFlowExecutionContext({ runId: OTHER, chainDepth: 1 }, async () => {
        expect(currentFlowExecutionFrame()).toEqual({ runId: OTHER, chainDepth: 1 });
      });
      expect(currentFlowExecutionFrame()).toEqual({ runId: RUN_ID, chainDepth: 0 });
    });
  });

  it('refuses a malformed frame instead of stamping garbage ancestry', async () => {
    await expect(withFlowExecutionContext({ runId: RUN_ID, chainDepth: 4 }, async () => 1)).rejects.toThrow(/chainDepth/);
    await expect(withFlowExecutionContext({ runId: 'nope', chainDepth: 0 }, async () => 1)).rejects.toThrow(/runId/);
  });

  it('the frame is frozen — a callee cannot rewrite its own ancestry', async () => {
    await withFlowExecutionContext({ runId: RUN_ID, chainDepth: 1 }, async () => {
      const frame = currentFlowExecutionFrame() as { chainDepth: number };
      expect(() => { frame.chainDepth = 0; }).toThrow();
    });
  });
});
