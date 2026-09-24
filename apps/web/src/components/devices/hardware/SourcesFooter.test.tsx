import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SourcesFooter, { HARDWARE_DOCS_URL } from './SourcesFooter';

describe('SourcesFooter', () => {
  it('explains every source status and preserves partial-report warnings', () => {
    render(<SourcesFooter lastCollectedAt="2026-09-23T12:00:00Z" sources={[
      { source: 'storcli', status: 'ok', complete: false, toolVersion: '7.4', warnings: ['PD query truncated'] },
      { source: 'ssacli', status: 'unavailable' },
      { source: 'megacli', status: 'superseded' },
      { source: 'arcconf', status: 'failed', error: 'exit 2' },
      { source: 'omreport', status: 'backing_off', retryAt: '2026-09-23T18:00:00Z', error: 'timeout' },
      { source: 'smartctl', status: 'disabled' },
    ]} />);
    const footer = screen.getByTestId('hardware-sources-footer');
    expect(footer).toHaveTextContent('v7.4');
    expect(footer).toHaveTextContent('Partial report');
    expect(footer).toHaveTextContent('PD query truncated');
    expect(footer).toHaveTextContent('Superseded by storcli');
    expect(footer).toHaveTextContent('Failing: exit 2');
    expect(footer).toHaveTextContent('Backing off until');
    expect(footer).toHaveTextContent('timeout');
    expect(footer).toHaveTextContent('Disabled');
    expect(screen.getByRole('link', { name: 'Not installed' })).toHaveAttribute('href', HARDWARE_DOCS_URL);
  });
  it('does not claim an absent tool superseded another', () => {
    render(<SourcesFooter lastCollectedAt={null} sources={[
      { source: 'megacli', status: 'superseded' },
    ]} />);
    expect(screen.getByTestId('hardware-sources-footer')).not.toHaveTextContent('storcli');
  });
});
