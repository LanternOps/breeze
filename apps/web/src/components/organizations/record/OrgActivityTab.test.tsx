import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OrgActivityTab from './OrgActivityTab';

const auditLogViewerProps: Array<Record<string, unknown>> = [];
vi.mock('@/components/audit/AuditLogViewer', () => ({
  default: (props: Record<string, unknown>) => {
    auditLogViewerProps.push(props);
    return <div data-testid="audit-log-viewer-stub" />;
  },
}));

describe('OrgActivityTab', () => {
  it('renders AuditLogViewer pinned to the record org', () => {
    auditLogViewerProps.length = 0;
    render(<OrgActivityTab orgId="org-record-1" />);

    expect(screen.getByTestId('org-activity-tab')).toBeTruthy();
    expect(screen.getByTestId('audit-log-viewer-stub')).toBeTruthy();
    expect(auditLogViewerProps.at(-1)).toEqual({ orgId: 'org-record-1' });
  });
});
