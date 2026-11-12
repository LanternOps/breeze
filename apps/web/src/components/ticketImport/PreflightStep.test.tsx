import '@/lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { fetchMock, toastMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), toastMock: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchMock }));
vi.mock('../shared/Toast', () => ({ showToast: toastMock }));

import PreflightStep from './PreflightStep';
import { SOURCE_ID, json, preflight, sourceDetail } from './testFixtures';

beforeEach(() => vi.clearAllMocks());

describe('PreflightStep (#8313 W6)', () => {
  it('runs the preflight and hands its result up', async () => {
    fetchMock.mockResolvedValue(json(200, { data: preflight() }));
    const onPreflight = vi.fn();
    render(<PreflightStep source={sourceDetail()} preflight={null} onPreflight={onPreflight} onContinue={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ticket-import-preflight-run'));
    await waitFor(() => expect(onPreflight).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(`/ticket-imports/sources/${SOURCE_ID}/preflight`, expect.objectContaining({ method: 'POST', skipOrgIdInjection: true }));
  });

  it('shows storage, identity, warnings, counts and flags inactive and unreadable groups', () => {
    render(<PreflightStep source={sourceDetail()} preflight={preflight()} onPreflight={vi.fn()} onContinue={vi.fn()} />);
    expect(screen.getByTestId('ticket-import-preflight-storage')).toHaveAttribute('data-ok', 'true');
    expect(screen.getByTestId('ticket-import-preflight-identity')).toHaveTextContent('Breeze Import (import@example.com)');
    expect(screen.getByTestId('ticket-import-preflight-version')).toHaveTextContent('7.2.2');
    expect(screen.getByTestId('ticket-import-preflight-warning-group_inactive')).toHaveTextContent('Group Archive is inactive');
    expect(screen.getByTestId('ticket-import-preflight-warning-token_not_read_only')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-import-preflight-group-11')).toHaveTextContent('Inactive: not imported');
    expect(screen.getByTestId('ticket-import-preflight-group-10')).not.toHaveTextContent('Inactive');
    expect(screen.getByTestId('ticket-import-preflight-counts')).toHaveTextContent('42');
    expect(screen.getByTestId('ticket-import-preflight-attributes')).toHaveTextContent('Contract');
  });

  it('says when object storage is missing, and shows an unknown warning by its code', () => {
    const result = preflight({ objectStorage: { configured: false } });
    result.connect.warnings = [{ code: 'something_new', detail: 'x' }];
    render(<PreflightStep source={sourceDetail()} preflight={result} onPreflight={vi.fn()} onContinue={vi.fn()} />);
    expect(screen.getByTestId('ticket-import-preflight-storage')).toHaveAttribute('data-ok', 'false');
    expect(screen.getByTestId('ticket-import-preflight-warning-something_new')).toHaveTextContent('something_new: x');
  });

  it('refuses to run for a revoked source', () => {
    render(<PreflightStep source={sourceDetail({ hasCredentials: false })} preflight={null} onPreflight={vi.fn()} onContinue={vi.fn()} />);
    expect(screen.getByTestId('ticket-import-preflight-revoked')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-import-preflight-run')).toBeDisabled();
  });

  it('an unreachable source is reported in words', async () => {
    fetchMock.mockResolvedValue(json(502, { error: 'The source could not be reached', code: 'TICKET_IMPORT_SOURCE_UNREACHABLE' }));
    const onPreflight = vi.fn();
    render(<PreflightStep source={sourceDetail()} preflight={null} onPreflight={onPreflight} onContinue={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ticket-import-preflight-run'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'The help desk could not be reached.' })));
    expect(onPreflight).not.toHaveBeenCalled();
  });
});
