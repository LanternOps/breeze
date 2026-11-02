import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import '@/lib/i18n';
import RecentActivity from './RecentActivity';
import { DEFAULT_DASHBOARD_EXCLUDE_ACTIONS } from '@/lib/auditFormat';
import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type { AuditLogEntry } from './types';

function loaded(data: AuditLogEntry[]): DashboardQueryState<AuditLogEntry[]> {
  return { data, error: null, isLoading: false, isFetching: false, unavailable: false, staleScope: false };
}

const ts = new Date().toISOString();

describe('RecentActivity target column (#9856)', () => {
  it('labels a nameless row by its resource type instead of the raw token', () => {
    render(
      <RecentActivity
        onRetry={() => {}}
        activity={loaded([
          { id: '1', action: 'filter.create', timestamp: ts, resource: { type: 'saved_filter', id: 'f1', name: '' } },
        ])}
      />,
    );
    expect(screen.queryByText('saved_filter')).toBeNull();
    expect(screen.getByText('Saved view')).toBeInTheDocument();
  });

  it('prefers the target name when the API returns one', () => {
    render(
      <RecentActivity
        onRetry={() => {}}
        activity={loaded([
          { id: '1', action: 'filter.create', timestamp: ts, resource: { type: 'saved_filter', id: 'f1', name: 'Offline laptops' } },
        ])}
      />,
    );
    expect(screen.getByText('Offline laptops')).toBeInTheDocument();
    expect(screen.queryByText('Saved view')).toBeNull();
  });

  it('shows "-" when there is neither a name nor a type', () => {
    render(
      <RecentActivity onRetry={() => {}} activity={loaded([{ id: '1', action: 'user.login', timestamp: ts }])} />,
    );
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('-');
  });

  it('keeps filter previews out of the widget', () => {
    expect(DEFAULT_DASHBOARD_EXCLUDE_ACTIONS).toContain('filter.preview');
  });
});
