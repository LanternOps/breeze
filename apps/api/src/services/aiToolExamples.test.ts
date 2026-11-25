import { describe, expect, it } from 'vitest';
import { toolExamplesMode } from './aiToolExamples';
import { breezeServerTools } from './aiAgentSdkTools';
import type { AuthContext } from '../middleware/auth';

describe('toolExamplesMode', () => {
  it('is off only on the literal "off"; auto otherwise', () => {
    expect(toolExamplesMode({ AI_TOOL_EXAMPLES: 'off' })).toBe('off');
    expect(toolExamplesMode({ AI_TOOL_EXAMPLES: 'auto' })).toBe('auto');
    expect(toolExamplesMode({})).toBe('auto');
    expect(toolExamplesMode({ AI_TOOL_EXAMPLES: 'OFF' })).toBe('auto');
    expect(toolExamplesMode({ AI_TOOL_EXAMPLES: 'on' })).toBe('auto');
  });
});

describe('breezeServerTools toolExamples option (W02: accepted, ignored)', () => {
  const getAuth = () => { throw new Error('never called'); };
  const descriptions = (mode: 'auto' | 'off' | undefined) =>
    breezeServerTools(getAuth as unknown as () => AuthContext, undefined, undefined, undefined, [],
      mode === undefined ? undefined : { toolExamples: mode })
      .map((t) => [t.name, t.description]);

  it("builds byte-identical descriptions for 'auto', 'off' and unset", () => {
    const base = descriptions(undefined);
    expect(base.length).toBeGreaterThan(100);
    expect(descriptions('auto')).toEqual(base);
    expect(descriptions('off')).toEqual(base);
  });
});
