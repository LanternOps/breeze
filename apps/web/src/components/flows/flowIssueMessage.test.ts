import { describe, expect, it } from 'vitest';
import type { FlowIssue } from '@breeze/shared';
import { dropShadowedIssues } from './flowIssueMessage';

const issue = (over: Partial<FlowIssue>): FlowIssue => ({
  code: 'input_invalid',
  message: 'm',
  pointer: '/steps/1/input/channelId',
  ...over,
}) as FlowIssue;

describe('dropShadowedIssues', () => {
  it.each(['reference_not_owned', 'notify_channel_not_owned'] as const)(
    'drops %s when the same pointer already has input_invalid',
    (code) => {
      const out = dropShadowedIssues([issue({ code: 'input_invalid' }), issue({ code })]);
      expect(out.map((i) => i.code)).toEqual(['input_invalid']);
    },
  );

  it.each(['reference_not_owned', 'notify_channel_not_owned'] as const)(
    'keeps a standalone %s on its own pointer',
    (code) => {
      const out = dropShadowedIssues([
        issue({ code: 'input_invalid', pointer: '/steps/0/input/title' }),
        issue({ code }),
      ]);
      expect(out.map((i) => i.code)).toEqual(['input_invalid', code]);
    },
  );
});
