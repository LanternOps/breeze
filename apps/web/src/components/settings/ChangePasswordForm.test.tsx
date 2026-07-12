import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { i18n, loadLocale } from '@/lib/i18n';
import ChangePasswordForm from './ChangePasswordForm';

describe('ChangePasswordForm', () => {
  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage('en');
  });

  it('uses the localized default submit label', async () => {
    await loadLocale('pt-BR');
    await i18n.changeLanguage('pt-BR');

    render(<ChangePasswordForm />);

    expect(screen.getByRole('button', { name: 'Alterar a senha' })).toBeInTheDocument();
  });
});
