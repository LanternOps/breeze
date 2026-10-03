import { describe, it, expect, vi } from 'vitest';

const { captureMessageMock } = vi.hoisted(() => ({ captureMessageMock: vi.fn() }));
vi.mock('./sentry', () => ({ captureMessage: captureMessageMock }));

import {
  SDK_TOOL_USE_ID_META_KEY,
  claimToolUseId,
  noteStreamedToolUse,
  postToolUseForCall,
  resetToolUseCorrelationMarkers,
  sdkToolUseIdFromExtra,
  takeDroppedToolUse,
} from './aiToolUseCorrelation';

function state() {
  return {
    toolUseIdQueue: [] as string[],
    toolUseNames: new Map<string, string>(),
    resultedToolUseIds: new Set<string>(),
    resultedWithoutIdByName: new Map<string, number>(),
  };
}

describe('sdkToolUseIdFromExtra', () => {
  it('reads the CLI meta key', () => {
    expect(SDK_TOOL_USE_ID_META_KEY).toBe('claudecode/toolUseId');
    expect(sdkToolUseIdFromExtra({ _meta: { 'claudecode/toolUseId': 'toolu_1' } })).toBe('toolu_1');
  });

  it.each([
    ['undefined extra', undefined],
    ['null extra', null],
    ['no _meta', {}],
    ['non-object _meta', { _meta: 'x' }],
    ['missing key', { _meta: { other: 'toolu_1' } }],
    ['empty string', { _meta: { 'claudecode/toolUseId': '' } }],
    ['non-string', { _meta: { 'claudecode/toolUseId': 42 } }],
  ])('returns undefined for %s', (_label, extra) => {
    expect(sdkToolUseIdFromExtra(extra)).toBeUndefined();
  });
});

describe('pairing with the SDK id', () => {
  it('stream event first, then result: removes the pending call', () => {
    const s = state();
    expect(noteStreamedToolUse(s, 'a', 'tool_a')).toBe(true);
    expect(claimToolUseId(s, 'tool_a', 'a')).toBe('a');
    expect(s.toolUseIdQueue).toEqual([]);
    expect(s.toolUseNames.size).toBe(0);
    expect(takeDroppedToolUse(s, 'a')).toBeUndefined();
  });

  it('result first, then stream event: the call never becomes pending', () => {
    const s = state();
    expect(claimToolUseId(s, 'tool_a', 'a')).toBe('a');
    expect(noteStreamedToolUse(s, 'a', 'tool_a')).toBe(false);
    expect(s.toolUseIdQueue).toEqual([]);
    expect(s.resultedToolUseIds.size).toBe(0);
    expect(takeDroppedToolUse(s, 'a')).toBeUndefined();
  });

  it('out-of-order results keep their own ids, other pending calls untouched', () => {
    const s = state();
    noteStreamedToolUse(s, 'a', 'tool_a');
    noteStreamedToolUse(s, 'b', 'tool_b');
    expect(claimToolUseId(s, 'tool_b', 'b')).toBe('b');
    expect(s.toolUseIdQueue).toEqual(['a']);
  });
});

describe('pairing without an SDK id (fallback)', () => {
  it('takes the oldest pending call with the same tool name', () => {
    const s = state();
    noteStreamedToolUse(s, 'a1', 'tool_a');
    noteStreamedToolUse(s, 'b1', 'tool_b');
    noteStreamedToolUse(s, 'a2', 'tool_a');
    expect(claimToolUseId(s, 'tool_b')).toBe('b1');
    expect(claimToolUseId(s, 'tool_a')).toBe('a1');
    expect(s.toolUseIdQueue).toEqual(['a2']);
  });

  it('result before any stream event: no id, and the later stream event is not queued', () => {
    const s = state();
    expect(claimToolUseId(s, 'tool_a')).toBeUndefined();
    expect(noteStreamedToolUse(s, 'a', 'tool_a')).toBe(false);
    expect(s.toolUseIdQueue).toEqual([]);
    expect(s.resultedWithoutIdByName.size).toBe(0);
    // A second same-name call is a fresh pending call again.
    expect(noteStreamedToolUse(s, 'a2', 'tool_a')).toBe(true);
  });

  it('reports a missing SDK id once per session (warn + Sentry), never when the id is present', () => {
    captureMessageMock.mockClear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const s1 = state();
      claimToolUseId(s1, 'tool_a', 'with_id');
      expect(captureMessageMock).not.toHaveBeenCalled();

      claimToolUseId(s1, 'tool_a');
      claimToolUseId(s1, 'tool_b');
      expect(captureMessageMock).toHaveBeenCalledTimes(1);
      expect(captureMessageMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ eventCode: 'ai_tool_use_id_missing' }),
      );
      expect(warn).toHaveBeenCalledTimes(1);

      claimToolUseId(state(), 'tool_a');
      expect(captureMessageMock).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps head-of-queue pairing for sessions that track no names', () => {
    const s = { toolUseIdQueue: ['x', 'y'] };
    expect(claimToolUseId(s, 'anything')).toBe('x');
    expect(s.toolUseIdQueue).toEqual(['y']);
  });
});

describe('takeDroppedToolUse', () => {
  it('returns and removes a call that is still pending', () => {
    const s = state();
    noteStreamedToolUse(s, 'a', 'tool_a');
    expect(takeDroppedToolUse(s, 'a')).toEqual({ toolName: 'tool_a' });
    expect(s.toolUseIdQueue).toEqual([]);
    expect(takeDroppedToolUse(s, 'a')).toBeUndefined();
  });

  it('falls back to unknown_tool without a name map', () => {
    expect(takeDroppedToolUse({ toolUseIdQueue: ['a'] }, 'a')).toEqual({ toolName: 'unknown_tool' });
  });
});

describe('resetToolUseCorrelationMarkers', () => {
  it('clears result-first markers but not pending calls', () => {
    const s = state();
    noteStreamedToolUse(s, 'pending', 'tool_p');
    claimToolUseId(s, 'tool_a', 'orphan');
    claimToolUseId(s, 'tool_b');
    resetToolUseCorrelationMarkers(s);
    expect(s.resultedToolUseIds.size).toBe(0);
    expect(s.resultedWithoutIdByName.size).toBe(0);
    expect(s.toolUseIdQueue).toEqual(['pending']);
  });
});

describe('postToolUseForCall', () => {
  it('returns undefined without a callback', () => {
    expect(postToolUseForCall(undefined, {})).toBeUndefined();
  });

  it('appends the SDK id from extra as the eighth argument', async () => {
    const post = vi.fn(async () => undefined);
    const bound = postToolUseForCall(post, { _meta: { 'claudecode/toolUseId': 'toolu_9' } })!;
    await bound('t', { a: 1 }, 'out', false, 3, undefined, 'approved_executing');
    expect(post).toHaveBeenCalledWith('t', { a: 1 }, 'out', false, 3, undefined, 'approved_executing', 'toolu_9');
  });
});
