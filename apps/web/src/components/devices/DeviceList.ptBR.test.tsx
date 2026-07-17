import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyLocale } from '@/lib/i18n';
import DeviceList, { type Device } from './DeviceList';
import { QuickAddChips } from './QuickAddChips';

vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: vi.fn(),
}));
// Fleet view so the fleet-only Organization column stays available to these
// suites (see DeviceList isColumnAvailable).
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({
  default: () => null,
}));

const device: Device = {
  id: '11111111-1111-1111-1111-111111111111',
  hostname: 'host-a',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 10,
  ramPercent: 20,
  lastSeen: '2026-07-11T17:56:00.000Z',
  orgId: 'org-1',
  orgName: 'Acme',
  siteId: 'site-1',
  siteName: 'Matriz',
  agentVersion: '0.67.0',
  tags: [],
  deviceRole: 'unknown',
};

describe('DeviceList — pt-BR presentation', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T18:00:00.000Z'));
    await applyLocale('pt-BR');
  });

  afterEach(async () => {
    vi.useRealTimers();
    await applyLocale('en');
  });

  it('translates the default table headers, row labels, selection name, and relative age', () => {
    render(<DeviceList devices={[device]} timezone="UTC" />);

    expect(screen.getByText('Dispositivo')).toBeInTheDocument();
    expect(screen.getByText('Organização')).toBeInTheDocument();
    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('SO')).toBeInTheDocument();
    expect(screen.getByText('Função')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('CPU %')).toBeInTheDocument();
    expect(screen.getByText('RAM %')).toBeInTheDocument();
    expect(screen.getByText('Visto por último')).toBeInTheDocument();
    expect(screen.getByText('Ativo')).toBeInTheDocument();
    expect(screen.getByLabelText('Desconhecido')).toBeInTheDocument();
    expect(screen.getByLabelText('Selecionar host-a')).toBeInTheDocument();
    expect(screen.getByText('há 4 min.')).toBeInTheDocument();

    for (const englishResidue of ['Device', 'Organization', 'Site', 'Role', 'Up', 'Unknown', '4m ago']) {
      expect(screen.queryByText(englishResidue)).toBeNull();
    }
  });

  it('translates every quick-filter label while preserving canonical filter values', () => {
    const onChange = vi.fn();
    render(<QuickAddChips value={null} onChange={onChange} />);

    for (const label of [
      'Servidores',
      'Precisa de patches',
      'Crítico',
      'Reinicialização necessária',
      'Não visto há 7 dias',
      'Pouco espaço em disco',
      'Sem tags',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    fireEvent.click(screen.getByText('Servidores'));
    expect(onChange).toHaveBeenCalledWith({
      operator: 'AND',
      conditions: [
        { field: 'deviceRole', operator: 'equals', value: 'server' },
      ],
    });
  });
});
