import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  PRE_STREAM_SLOW_PHASE_MS,
  exitPreStreamTiming,
  timePreStreamPhase,
  withPreStreamTiming,
} from './aiPreStreamTiming';

let now = 0;
let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  now = 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const advance = (ms: number) => { now += ms; };
const warnLines = () => warn.mock.calls.map((call) => String(call[0]));

describe('aiPreStreamTiming (#11004)', () => {
  it('stays silent when every phase is under the threshold', async () => {
    await withPreStreamTiming('chat.message', { sessionId: 's-1' }, async () => {
      timePreStreamPhase('fast', () => advance(PRE_STREAM_SLOW_PHASE_MS - 1));
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs ONE warn line naming the slowest leaf phase when a phase crosses the threshold', async () => {
    const result = await withPreStreamTiming('chat.message', { sessionId: 's-2' }, async () => {
      await timePreStreamPhase('preflight', async () => {
        advance(20);
        timePreStreamPhase('systemPrompt', () => advance(40));
      });
      await timePreStreamPhase('getOrCreate', async () => {
        timePreStreamPhase('mcpServer', () => advance(700));
        await timePreStreamPhase('spawn', async () => { advance(30); });
      });
      return 'value';
    });

    expect(result).toBe('value');
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warnLines()[0]!;
    expect(line).not.toContain('\n');
    expect(line).toContain('[AI] slow pre-stream setup');
    expect(line).toContain('surface=chat.message');
    expect(line).toContain('sessionId=s-2');
    expect(line).toContain('slowest=getOrCreate.mcpServer:700ms');
    expect(line).toContain('total=790ms');
    // Nested phases are named by their parent; containers report their own wall time.
    expect(line).toContain('preflight=60ms');
    expect(line).toContain('preflight.systemPrompt=40ms');
    expect(line).toContain('getOrCreate=730ms');
    expect(line).toContain('getOrCreate.spawn=30ms');
  });

  it('reports wall time that no phase covers as `untimed`, and warns on it', async () => {
    await withPreStreamTiming('chat.message', { sessionId: 's-3' }, async () => {
      timePreStreamPhase('preflight', () => advance(10));
      advance(900); // uninstrumented work between phases
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warnLines()[0]).toContain('slowest=untimed:900ms');
  });

  it('records a phase that throws and still rethrows', async () => {
    await expect(withPreStreamTiming('chat.message', { sessionId: 's-4' }, async () => {
      await timePreStreamPhase('getOrCreate', async () => { advance(600); throw new Error('boom'); });
    })).rejects.toThrow('boom');
    expect(warnLines()[0]).toContain('getOrCreate=600ms');
  });

  it('folds a nested withPreStreamTiming into the outer timer instead of logging twice', async () => {
    await withPreStreamTiming('chat.message', { sessionId: 's-5' }, async () => {
      await timePreStreamPhase('dispatch', () => withPreStreamTiming('session.getOrCreate', { sessionId: 's-5' }, async () => {
        timePreStreamPhase('mcpServer', () => advance(800));
      }));
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warnLines()[0]).toContain('surface=chat.message');
    expect(warnLines()[0]).toContain('dispatch.mcpServer=800ms');
  });

  it('is a no-op outside a timed request, after the timer finished, and under exitPreStreamTiming', async () => {
    expect(timePreStreamPhase('orphan', () => 7)).toBe(7);

    let late: (() => void) | undefined;
    await withPreStreamTiming('chat.message', { sessionId: 's-6' }, async () => {
      late = () => timePreStreamPhase('afterFinish', () => advance(5_000));
      exitPreStreamTiming(() => timePreStreamPhase('detached', () => advance(5_000)));
    });
    late!();
    // The detached 5 s phase is not attributed to any phase, so it lands in
    // `untimed`; the post-finish phase is dropped entirely.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warnLines()[0]).not.toContain('detached');
    expect(warnLines()[0]).not.toContain('afterFinish');
  });
});
