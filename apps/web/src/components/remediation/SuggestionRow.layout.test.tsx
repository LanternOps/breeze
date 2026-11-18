import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect } from 'vitest';

import SuggestionRow from './SuggestionRow';
import type { RemediationSuggestion } from './suggestionRowModel';

const suggestion: RemediationSuggestion = {
  id: 's-1',
  sourceType: 'alert',
  sourceId: 'alert-1',
  deviceId: null,
  targetType: 'manual_steps',
  scriptId: null,
  scriptTemplateId: null,
  playbookId: null,
  title: 'Identify the process spawning excess instances',
  rationale: 'The alert does not name a process.',
  expectedAction: 'Find the runaway parent.',
  riskTier: 'low',
  status: 'suggested',
  confidence: 0.9,
  parameters: { steps: ['Open Task Manager'] },
  targetDeviceIds: [],
  elevationRequestId: null,
  scriptExecutionId: null,
  origin: 'ai_research',
  evidence: { aiWritten: true },
};

const noop = () => {};

// The row renders inside the alert drawer (max-w-2xl) and the anomaly episode
// card, both narrower than the viewport. A viewport breakpoint (lg:flex-row)
// put four+ non-shrinking buttons beside the text and squeezed the title to
// one word per line. Actions always stack under the content instead.
describe('SuggestionRow layout', () => {
  it('stacks the action toolbar under the suggestion text', () => {
    render(
      <SuggestionRow
        suggestion={suggestion}
        approvalStatus={undefined}
        editDraft={null}
        setEditDraft={noop}
        busy={{ updatingId: null, executingId: null, requestingApprovalId: null, votingId: null, markingDoneId: null }}
        reviewed={null}
        reviewedChoice=""
        onReviewedChoice={noop}
        savingReviewed={null}
        setSavingReviewed={noop}
        savingReviewedBusy={false}
        canManagePartnerWide
        onUpdate={noop}
        onBeginEdit={noop}
        onCancelEdit={noop}
        onSaveEdit={noop}
        onExecute={noop}
        onVote={noop}
        onMarkDone={noop}
        onRequestApproval={noop}
        onSaveReviewed={noop}
        onDraftScript={noop}
      />,
    );
    const actions = screen.getByTestId('suggestion-actions-s-1');
    const actionClasses = actions.className.split(' ');
    expect(actionClasses).not.toContain('shrink-0');
    expect(actionClasses).toContain('flex-wrap');
    const body = actions.parentElement as HTMLElement;
    expect(body.className.split(' ')).toContain('flex-col');
    expect(body.className).not.toMatch(/lg:flex-row/);
    // Content precedes actions in DOM order (title above the toolbar).
    expect(body.firstElementChild).not.toBe(actions);
    expect(body.lastElementChild).toBe(actions);
  });
});
