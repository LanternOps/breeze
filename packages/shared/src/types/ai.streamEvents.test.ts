import { describe, expect, it } from 'vitest';
import type { AiStreamEvent, AiRunResultArtifactRef } from './ai';

describe('AiStreamEvent — execution-plane run events (spec §5.5)', () => {
  it('accepts a run_progress event with an ordinal', () => {
    const event: AiStreamEvent = {
      type: 'run_progress',
      runId: '11111111-1111-4111-8111-111111111111',
      step: 'export_dataset',
      label: 'Exported 12,400 event log rows',
      ordinal: 2,
    };
    expect(event.type).toBe('run_progress');
  });

  it('accepts a run_result event carrying artifact references', () => {
    const artifacts: AiRunResultArtifactRef[] = [
      {
        handle: '22222222-2222-4222-8222-222222222222',
        name: 'failed-logons.csv',
        bytes: 40_112,
        contentType: 'text/csv',
      },
    ];
    const event: AiStreamEvent = {
      type: 'run_result',
      runId: '11111111-1111-4111-8111-111111111111',
      status: 'completed',
      summary: 'Three accounts failed logon from outside the office.',
      artifacts,
    };
    expect(event.artifacts[0]!.name).toBe('failed-logons.csv');
  });

  it('allows a failed run to carry a null summary and no artifacts', () => {
    const event: AiStreamEvent = {
      type: 'run_result',
      runId: '11111111-1111-4111-8111-111111111111',
      status: 'failed',
      summary: null,
      artifacts: [],
    };
    expect(event.summary).toBeNull();
  });
});
