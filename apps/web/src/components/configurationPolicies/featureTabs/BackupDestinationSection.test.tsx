import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import BackupDestinationSection, { emptyConfigForm } from './BackupDestinationSection';

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
