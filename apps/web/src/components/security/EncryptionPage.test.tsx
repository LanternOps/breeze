import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue({ data: [] }),
  }),
}));

import { fetchWithAuth } from '@/stores/auth';
import EncryptionPage from './EncryptionPage';

describe('EncryptionPage filter selects accessible name (#7156)', () => {
  it('gives the status/OS/escrow filter selects a real accessible name', async () => {
    render(<EncryptionPage />);
    expect(await screen.findByRole('combobox', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Operating system' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Key escrow' })).toBeInTheDocument();
  });
});

// #9607: Breeze does not collect TPM state, so the API now sends tpmPresent:
// null. The page must render that as "not reported", not as "No".
describe('EncryptionPage TPM column (#9607)', () => {
  const device = (deviceId: string, tpmPresent: boolean | null) => ({
    deviceId,
    deviceName: `dev-${deviceId}`,
    os: 'windows',
    encryptionMethod: 'unknown',
    encryptionStatus: 'encrypted',
    volumes: [],
    tpmPresent,
    recoveryKeyEscrowed: false,
  });

  it('renders null as an em dash and only shows Yes/No for reported values', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        data: [device('a', null), device('b', true), device('c', false)],
      }),
    } as unknown as Response);
    render(<EncryptionPage />);
    expect(await screen.findByTestId('encryption-tpm-a')).toHaveTextContent(/^—$/);
    expect(screen.getByTestId('encryption-tpm-a')).toHaveAttribute('title', 'Not reported by the agent');
    expect(screen.getByTestId('encryption-tpm-b')).toHaveTextContent(/^Yes$/);
    expect(screen.getByTestId('encryption-tpm-c')).toHaveTextContent(/^No$/);
  });
});

describe('EncryptionPage method tiles (#9607)', () => {
  it('shows an Unknown tile for encrypted devices that reported no method', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        data: [],
        summary: {
          total: 5, fullyEncrypted: 4, partial: 0, unencrypted: 1, recoveryKeysEscrowed: 0,
          methodCounts: { bitlocker: 1, filevault: 1, luks: 0, none: 1, unknown: 2 },
        },
      }),
    } as unknown as Response);
    render(<EncryptionPage />);
    expect(await screen.findByTestId('encryption-method-unknown')).toHaveTextContent('Unknown');
    expect(screen.getByTestId('encryption-method-unknown')).toHaveTextContent('2');
  });
});

describe('EncryptionPage test ids (#9609)', () => {
  it('exposes the page, tiles, filters and device rows', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        data: [{
          deviceId: 'z', deviceName: 'dev-z', os: 'windows', encryptionMethod: 'bitlocker',
          encryptionStatus: 'encrypted', volumes: [], tpmPresent: null, recoveryKeyEscrowed: true,
        }],
        summary: {
          total: 7, fullyEncrypted: 4, partial: 1, unencrypted: 2, recoveryKeysEscrowed: 3,
          methodCounts: { bitlocker: 4, filevault: 1, luks: 0, none: 2, unknown: 0 },
        },
      }),
    } as unknown as Response);
    render(<EncryptionPage />);
    expect(await screen.findByTestId('encryption-page')).toBeInTheDocument();
    expect(await screen.findByTestId('encryption-row-z')).toBeInTheDocument();
    expect(screen.getByTestId('encryption-state-total')).toHaveTextContent('7');
    expect(screen.getByTestId('encryption-state-encrypted')).toHaveTextContent('4');
    expect(screen.getByTestId('encryption-state-partial')).toHaveTextContent('1');
    expect(screen.getByTestId('encryption-state-unencrypted')).toHaveTextContent('2');
    expect(screen.getByTestId('encryption-method-bitlocker')).toHaveTextContent('4');
    for (const id of ['filevault', 'luks', 'none', 'unknown']) {
      expect(screen.getByTestId(`encryption-method-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('encryption-search')).toBeInTheDocument();
    expect(screen.getByTestId('encryption-filter-status')).toBeInTheDocument();
    expect(screen.getByTestId('encryption-filter-os')).toBeInTheDocument();
    expect(screen.getByTestId('encryption-filter-escrow')).toBeInTheDocument();
    expect(screen.getByTestId('encryption-table')).toBeInTheDocument();
    expect(screen.getByTestId('encryption-escrow-z')).toBeInTheDocument();
  });
});
