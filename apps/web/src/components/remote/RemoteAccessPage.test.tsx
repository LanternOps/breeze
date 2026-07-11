import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { i18n, loadLocale } from '@/lib/i18n';

import RemoteAccessPage from './RemoteAccessPage';

describe('RemoteAccessPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  afterEach(async () => {
    await act(() => i18n.changeLanguage('en'));
  });

  it('renders the landing page in Brazilian Portuguese', async () => {
    await loadLocale('pt-BR');
    await act(() => i18n.changeLanguage('pt-BR'));

    render(<RemoteAccessPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Acesso remoto' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Iniciar terminal' })).toBeInTheDocument();
    expect(screen.getByText('Selecione um dispositivo para conectar')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Transferência de arquivos' })).toBeInTheDocument();
    expect(screen.getByText('Transfira arquivos de e para dispositivos')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Histórico de sessões' })).toBeInTheDocument();
    expect(screen.getByText('Veja as sessões anteriores')).toBeInTheDocument();
  });
});
