import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi } from 'vitest';

// The drawer renders a remediation panel that fetches on mount; stub it so
// this suite stays focused on the AI verdict rendering (mirrors
// AlertDetails.actorName.test.tsx's setup).
vi.mock('../remediation/RemediationSuggestionsPanel', () => ({
  default: () => null,
}));

import AlertDetails from './AlertDetails';
import type { Alert } from './AlertList';

const baseAlert: Alert = {
  id: 'a-1',
  title: 'CPU high',
  message: 'CPU over 90%',
  severity: 'critical',
  status: 'active',
  deviceId: 'd-1',
  deviceName: 'web-01',
  triggeredAt: '2026-08-24T16:00:00Z',
};

function renderDrawer(alert: Alert) {
  return render(<AlertDetails alert={alert} isOpen onClose={() => {}} />);
}

describe('AlertDetails — AI verdict (P2-1 Task 15, review fix round 1)', () => {
  it('renders nothing verdict-related when the alert has no aiVerdict', () => {
    renderDrawer(baseAlert);
    expect(screen.queryByTestId('alert-verdict-badge')).toBeNull();
  });

  it('renders the full badge and rationale paragraph when aiVerdict is present', () => {
    renderDrawer({
      ...baseAlert,
      aiVerdict: {
        id: 'verdict-1',
        classification: 'actionable',
        confidence: 0.72,
        rationale: 'Disk usage climbing steadily with no self-heal.',
        patternKind: null,
        feedback: null,
        feedbackBy: null,
        suggestedIntentId: null,
        createdAt: '2026-08-28T00:00:00Z',
      },
    });

    expect(screen.getByTestId('alert-verdict-badge')).toBeTruthy();
    expect(screen.getByText('Disk usage climbing steadily with no self-heal.')).toBeTruthy();
    expect(screen.queryByText(/AI suggested an action/)).toBeNull();
  });

  it('shows the Approvals link only when suggestedIntentId is set', () => {
    renderDrawer({
      ...baseAlert,
      aiVerdict: {
        id: 'verdict-1',
        classification: 'needs_human',
        confidence: 0.55,
        rationale: 'Ambiguous failure signature.',
        patternKind: null,
        feedback: null,
        feedbackBy: null,
        suggestedIntentId: 'intent-1',
        createdAt: '2026-08-28T00:00:00Z',
      },
    });

    const link = screen.getByText(/AI suggested an action/).closest('a');
    expect(link?.getAttribute('href')).toBe('/approvals');
  });
});
