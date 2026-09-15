import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import RunArtifactsSection from './RunArtifactsSection';

const artifact = {
  id: 'a1',
  runId: 'r1',
  sessionId: null,
  kind: 'output' as const,
  name: 'failed-logons.csv',
  contentType: 'text/csv',
  bytes: 40112,
  sha256: 'f'.repeat(64),
  headPreview: 'user,when\nalice,09:14\n',
  tailPreview: 'zed,17:02\n',
  sourceDeviceId: null,
  createdByTool: 'workspace_collect',
  expiresAt: '2026-10-13T00:00:00.000Z',
  createdAt: '2026-09-13T10:03:00.000Z',
  downloadPath: '/api/v1/ai/artifacts/a1',
};

describe('RunArtifactsSection (spec §5.8, §8)', () => {
  it('renders nothing when the run produced no artifacts', () => {
    const { container } = render(<RunArtifactsSection artifacts={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('lists name, kind and size with a download link marked as an attachment', () => {
    const { getByTestId } = render(<RunArtifactsSection artifacts={[artifact]} />);
    const link = getByTestId('run-artifact-download-a1');
    expect(link.getAttribute('href')).toBe('/api/v1/ai/artifacts/a1');
    expect(link.getAttribute('download')).toBe('failed-logons.csv');
    expect(getByTestId('run-artifact-row-a1').textContent).toContain('output');
  });

  it('hides the preview until asked, then shows head and tail as text', () => {
    const { getByTestId, queryByTestId } = render(<RunArtifactsSection artifacts={[artifact]} />);
    expect(queryByTestId('run-artifact-preview-a1')).toBeNull();
    fireEvent.click(getByTestId('run-artifact-preview-toggle-a1'));
    expect(getByTestId('run-artifact-preview-a1').textContent).toContain('alice,09:14');
  });

  it('never interprets preview bytes as markup', () => {
    const hostile = { ...artifact, id: 'a2', headPreview: '<img src=x onerror=alert(1)>' };
    const { getByTestId, container } = render(<RunArtifactsSection artifacts={[hostile]} />);
    fireEvent.click(getByTestId('run-artifact-preview-toggle-a2'));
    expect(container.querySelector('img')).toBeNull();
    expect(getByTestId('run-artifact-preview-a2').textContent).toContain('<img src=x');
  });
});
