import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi } from 'vitest';

// The drawer renders a remediation panel that fetches on mount; stub it so this
// suite stays focused on the "Acknowledged by" rendering.
vi.mock('../remediation/RemediationSuggestionsPanel', () => ({
  default: () => null,
}));

import AlertDetails from './AlertDetails';
import type { Alert } from './AlertList';

const ACK_USER_ID = '9cea2f85-2da1-445d-88cc-7c404d7504c4';
const RESOLVE_USER_ID = '1f0e3f2c-9a2b-4c7d-9f10-8f6a2b3c4d5e';

const baseAlert: Alert = {
  id: 'a-1',
  title: 'CPU high',
  message: 'CPU over 90%',
  severity: 'critical',
  status: 'acknowledged',
  deviceId: 'd-1',
  deviceName: 'web-01',
  triggeredAt: '2026-08-24T16:00:00Z',
  acknowledgedAt: '2026-08-24T17:00:19Z',
};

function renderDrawer(alert: Alert) {
  return render(<AlertDetails alert={alert} isOpen onClose={() => {}} />);
}

describe('AlertDetails — acknowledged/resolved actor (#3966)', () => {
  it('shows the technician’s name instead of the raw user id', () => {
    const { container } = renderDrawer({
      ...baseAlert,
      acknowledgedBy: ACK_USER_ID,
      acknowledgedByName: 'Breeze Admin',
    });

    expect(screen.getByText(/Breeze Admin/)).toBeTruthy();
    expect(container.textContent).not.toContain(ACK_USER_ID);
  });

  it('keeps the raw id available as a tooltip for tooling', () => {
    const { container } = renderDrawer({
      ...baseAlert,
      acknowledgedBy: ACK_USER_ID,
      acknowledgedByName: 'Breeze Admin',
    });

    expect(container.querySelector(`[title="${ACK_USER_ID}"]`)).toBeTruthy();
  });

  it('falls back to a generic label — never the UUID — when the name is unknown', () => {
    const { container } = renderDrawer({
      ...baseAlert,
      acknowledgedBy: ACK_USER_ID,
      acknowledgedByName: null,
    });

    expect(screen.getByText(/Unknown user/)).toBeTruthy();
    expect(container.textContent).not.toContain(ACK_USER_ID);
  });

  it('omits the "by" clause entirely when no actor id is set', () => {
    renderDrawer({ ...baseAlert, acknowledgedBy: undefined, acknowledgedByName: undefined });

    // Right after an optimistic acknowledge the client has a timestamp but no
    // actor yet — it must not claim an unknown user.
    expect(screen.queryByText(/Unknown user/)).toBeNull();
  });

  it('resolves the resolvedBy actor the same way', () => {
    const { container } = renderDrawer({
      ...baseAlert,
      status: 'resolved',
      resolvedAt: '2026-08-24T18:00:00Z',
      resolvedBy: RESOLVE_USER_ID,
      resolvedByName: 'Dana Tech',
    });

    expect(screen.getByText(/Dana Tech/)).toBeTruthy();
    expect(container.textContent).not.toContain(RESOLVE_USER_ID);
  });
});
