import { render } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi } from 'vitest';

const panelProps = vi.fn();
vi.mock('../remediation/RemediationSuggestionsPanel', () => ({
  default: (props: Record<string, unknown>) => {
    panelProps(props);
    return null;
  },
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

describe('AlertDetails — suggestions panel org', () => {
  it('passes the alert org to the panel (partner-scope research POST needs it in the body)', () => {
    panelProps.mockClear();
    render(<AlertDetails alert={{ ...baseAlert, orgId: 'org-1' }} isOpen onClose={() => {}} />);
    expect(panelProps).toHaveBeenCalledWith(expect.objectContaining({ sourceType: 'alert', sourceId: 'a-1', orgId: 'org-1' }));
  });

  it('passes undefined (not null) when the alert carries no org', () => {
    panelProps.mockClear();
    render(<AlertDetails alert={{ ...baseAlert, orgId: null }} isOpen onClose={() => {}} />);
    expect(panelProps.mock.calls[0][0].orgId).toBeUndefined();
  });
});
