import { describe, expect, it } from 'vitest';

import reports from '../../locales/pt-BR/reports.json';

describe('reports pt-BR copy', () => {
  it('preserves accents in the recent reports empty state', () => {
    expect(reports.reports.reportsList.tabs.recentRuns).toBe('Execuções Recentes');
    expect(reports.reports.reportsList.emptyReportsTitle).toBe('Ainda não há relatórios');
    expect(reports.reports.reportsList.emptyReportsDescription).toBe(
      'Crie seu primeiro relatório para começar.',
    );
  });
});
