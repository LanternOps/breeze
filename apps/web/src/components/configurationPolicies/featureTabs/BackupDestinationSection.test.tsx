import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import BackupDestinationSection, { destinationPrefixError, emptyConfigForm } from './BackupDestinationSection';

// DBT-5: Chrome ignores `autoComplete="off"` on password-type inputs and
// autofills the operator's saved Breeze login into the S3 credential fields.
// The repo convention for credential forms (e.g. AddDnsIntegrationModal,
// ChangePasswordForm) is `autoComplete="off"` on plain-text secret-ish inputs
// and `autoComplete="new-password"` on `type="password"` inputs — Chrome
// respects `new-password` as "do not offer a saved credential here".
describe('BackupDestinationSection credential autofill (DBT-5)', () => {
  const baseProps = {
    configs: [],
    configsLoading: false,
    selectedConfigId: '',
    onSelect: vi.fn(),
    mode: 'create' as const,
    onStartCreate: vi.fn(),
    onCancelForm: vi.fn(),
    onBeginEdit: vi.fn(),
    form: { ...emptyConfigForm, provider: 's3' as const },
    onFormChange: vi.fn(),
    fieldErrors: {},
    testStatus: 'idle' as const,
    onTest: vi.fn(),
  };

  it('disables autofill on the S3 access key ID and secret access key inputs', () => {
    render(<BackupDestinationSection {...baseProps} />);

    const accessKeyInput = screen.getByPlaceholderText('AKIA...');
    const secretKeyInput = screen.getByPlaceholderText('Secret key');

    expect(accessKeyInput).toHaveAttribute('autoComplete', 'off');
    expect(secretKeyInput).toHaveAttribute('type', 'password');
    expect(secretKeyInput).toHaveAttribute('autoComplete', 'new-password');
  });
});

// #8152: an org with zero destinations showed the "Backups need a destination
// first" empty state with no way to act on it — the only "New destination"
// tile lived inside the grid of existing destinations.
describe('BackupDestinationSection empty state (#8152)', () => {
  const baseProps = {
    configs: [],
    configsLoading: false,
    selectedConfigId: '',
    onSelect: vi.fn(),
    mode: 'select' as const,
    onStartCreate: vi.fn(),
    onCancelForm: vi.fn(),
    onBeginEdit: vi.fn(),
    form: { ...emptyConfigForm },
    onFormChange: vi.fn(),
    fieldErrors: {},
    testStatus: 'idle' as const,
    onTest: vi.fn(),
  };

  it('offers a create action when the org has no destinations', () => {
    const onStartCreate = vi.fn();
    render(<BackupDestinationSection {...baseProps} onStartCreate={onStartCreate} />);

    const button = screen.getByTestId('backup-destination-empty-create');
    expect(button).toHaveTextContent('New destination');
    fireEvent.click(button);
    expect(onStartCreate).toHaveBeenCalledTimes(1);
  });

  it('hides the empty-state create action while the form is open', () => {
    render(<BackupDestinationSection {...baseProps} mode="create" />);

    expect(screen.queryByTestId('backup-destination-empty-create')).not.toBeInTheDocument();
  });
});

// #7081: the S3 key prefix now relocates new snapshots, so the form explains
// what it does and flags a prefix the server would refuse.
describe('BackupDestinationSection key prefix (#7081)', () => {
  const baseProps = {
    configs: [],
    configsLoading: false,
    selectedConfigId: '',
    onSelect: vi.fn(),
    mode: 'create' as const,
    onStartCreate: vi.fn(),
    onCancelForm: vi.fn(),
    onBeginEdit: vi.fn(),
    form: { ...emptyConfigForm, provider: 's3' as const },
    onFormChange: vi.fn(),
    fieldErrors: {},
    testStatus: 'idle' as const,
    onTest: vi.fn(),
  };

  it('explains where new snapshots go and that existing ones stay', () => {
    render(<BackupDestinationSection {...baseProps} />);
    expect(screen.getByText(
      'Key prefix for this destination. New snapshots are stored under <prefix>/snapshots/. Existing snapshots stay where they are. Changing it makes the next backup a full backup.',
    )).toBeInTheDocument();
  });

  it.each([
    ['a//b', 'Invalid key prefix: it must not contain empty, "." or ".." segments.'],
    ['msp/Snapshots', 'Invalid key prefix: it must not contain a "snapshots" segment.'],
    ['has space', "Invalid key prefix: use only letters, digits and ! _ . * ' ( ) - in each segment, separated by /."],
    ['x'.repeat(257), 'Invalid key prefix: it must be at most 256 characters.'],
  ])('shows the validator message inline for %s', (prefix, message) => {
    render(<BackupDestinationSection {...baseProps} form={{ ...baseProps.form, prefix }} />);
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it.each(['', 'msp/acme', '/msp/acme/'])('shows no prefix error for %j', (prefix) => {
    render(<BackupDestinationSection {...baseProps} form={{ ...baseProps.form, prefix }} />);
    expect(screen.queryByText(/Invalid key prefix/)).not.toBeInTheDocument();
  });

  it('destinationPrefixError ignores a local destination whatever prefix the form holds', () => {
    expect(destinationPrefixError({ ...emptyConfigForm, provider: 'local', prefix: 'a//b' })).toBeNull();
    expect(destinationPrefixError({ ...emptyConfigForm, provider: 's3', prefix: 'a//b' })).toMatch(/^Invalid key prefix/);
  });
});
