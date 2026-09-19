import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import RunWorkspaceSection from './RunWorkspaceSection';

const workspace = {
  backend: 'vercel',
  region: 'eu' as const,
  status: 'destroyed',
  bootstrapHash: 'sha256:abc', runtimeImage: 'analysis@sha256:abc',
  createdAt: '2026-09-13T10:00:00.000Z',
  readyAt: '2026-09-13T10:00:04.000Z',
  destroyedAt: '2026-09-13T10:03:00.000Z',
  cpuMs: 41000,
  wallMs: 176000,
  memAllocatedMb: 2048,
  stagedBytes: 1048576,
  artifactBytes: 40112,
  stepCount: 2,
  steps: [
    {
      ordinal: 1,
      language: 'python' as const,
      scriptArtifactHandle: 's1',
      exitCode: 0,
      timedOut: false,
      durationMs: 1820,
      stdoutArtifactHandle: 'o1',
    },
    {
      ordinal: 2,
      language: 'bash' as const,
      scriptArtifactHandle: 's2',
      exitCode: null,
      timedOut: true,
      durationMs: 300000,
      stdoutArtifactHandle: null,
    },
  ],
};

describe('RunWorkspaceSection (spec §5.8)', () => {
  it('renders nothing when the run never created a workspace', () => {
    const { container } = render(<RunWorkspaceSection workspace={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows one row per step with its ordinal, language, exit code and duration', () => {
    const { getByTestId } = render(<RunWorkspaceSection workspace={workspace} />);
    expect(getByTestId('run-workspace-step-1').textContent).toContain('python');
    expect(getByTestId('run-workspace-step-1').textContent).toContain('0');
  });

  it('says TIMED OUT rather than showing a blank exit code', () => {
    // A null exit code rendered as empty reads as success. It is not.
    const { getByTestId } = render(<RunWorkspaceSection workspace={workspace} />);
    expect(getByTestId('run-workspace-step-2').textContent).toContain('timedOut');
  });

  it('links the script and stdout artifacts, and marks an expired one instead of a dead link', () => {
    const { getByTestId, queryByTestId } = render(<RunWorkspaceSection workspace={workspace} />);
    expect(getByTestId('run-workspace-step-script-1').getAttribute('href'))
      .toBe('/api/v1/ai/artifacts/s1');
    expect(queryByTestId('run-workspace-step-stdout-2')).toBeNull();
  });

  it('marks an expired SCRIPT artifact as expired rather than linking to nothing', () => {
    // The 30-day TTL outlives nothing; the run row outlives the artifact. A
    // handle that is null is "expired", never an href to a 404.
    const expired = {
      ...workspace,
      steps: [{ ...workspace.steps[0]!, scriptArtifactHandle: null }],
    };
    const { getByTestId, queryByTestId } = render(<RunWorkspaceSection workspace={expired} />);
    expect(queryByTestId('run-workspace-step-script-1')).toBeNull();
    expect(getByTestId('run-workspace-step-1').textContent).toContain('artifactExpired');
  });
});
