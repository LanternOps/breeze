import { describe, expect, it } from 'vitest';
import { memoryBlockSubjectText } from './wispMemory';

const RAW = 'device:11111111-1111-4111-8111-111111111111:reboot:0123456789abcdef';

describe('memoryBlockSubjectText (#11612)', () => {
  it('shows the instruction text for a standing instruction, never its key', () => {
    expect(
      memoryBlockSubjectText({ blockType: 'standing_instruction', subjectKey: RAW, content: { text: "Don't reboot PC-01" } }),
    ).toBe("Don't reboot PC-01");
  });

  it('returns null when a standing instruction carries no readable text (caller supplies the label)', () => {
    expect(memoryBlockSubjectText({ blockType: 'standing_instruction', subjectKey: RAW, content: {} })).toBeNull();
    expect(memoryBlockSubjectText({ blockType: 'standing_instruction', subjectKey: RAW, content: { text: '  ' } })).toBeNull();
    expect(memoryBlockSubjectText({ blockType: 'standing_instruction', subjectKey: 'instruction:0123456789abcdef', content: { text: 5 } })).toBeNull();
  });

  it('keeps the authored subject key for other block types', () => {
    expect(memoryBlockSubjectText({ blockType: 'preference', subjectKey: 'reply-style', content: { text: 'x' } })).toBe('reply-style');
  });
});
