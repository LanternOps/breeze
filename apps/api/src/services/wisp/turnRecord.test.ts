/**
 * #10427 (W08): the reply text a Wisp turn keeps for the promise linter is
 * bounded, so a very long reply cannot grow the session's memory without limit.
 */
import { describe, expect, it } from 'vitest';
import { appendWispAssistantText, beginWispTurn, WISP_TURN_ASSISTANT_TEXT_MAX_CHARS } from './turnRecord';

describe('appendWispAssistantText', () => {
  it('starts empty and appends in order', () => {
    const turn = beginWispTurn('hi');
    expect(turn.assistantText).toBe('');
    expect(turn.correctionPublished).toBe(false);
    appendWispAssistantText(turn, 'one');
    appendWispAssistantText(turn, ' two');
    expect(turn.assistantText).toBe('one two');
  });

  it('keeps the first WISP_TURN_ASSISTANT_TEXT_MAX_CHARS characters and drops the rest', () => {
    const turn = beginWispTurn('hi');
    appendWispAssistantText(turn, 'a'.repeat(WISP_TURN_ASSISTANT_TEXT_MAX_CHARS - 2));
    appendWispAssistantText(turn, 'bcdef');
    expect(turn.assistantText).toHaveLength(WISP_TURN_ASSISTANT_TEXT_MAX_CHARS);
    expect(turn.assistantText.endsWith('abc')).toBe(true);
    appendWispAssistantText(turn, 'more');
    expect(turn.assistantText).toHaveLength(WISP_TURN_ASSISTANT_TEXT_MAX_CHARS);
  });
});
