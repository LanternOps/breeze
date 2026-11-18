import { describe, it, expect } from 'vitest';
import type { AiAgentRunDetailDto, AiAgentRunProgressEntryDto } from '@breeze/shared';

describe('run detail progress DTO', () => {
  it('carries a progress array of typed entries', () => {
    const entry: AiAgentRunProgressEntryDto = { step: 'export', label: 'Exported 12 rows', ordinal: 1, at: '2026-09-13T00:00:00.000Z' };
    const detail: Pick<AiAgentRunDetailDto, 'progress'> = { progress: [entry] };
    expect(detail.progress[0]!.ordinal).toBe(1);
  });

  it('models an empty window as [] rather than null', () => {
    const detail: Pick<AiAgentRunDetailDto, 'progress'> = { progress: [] };
    expect(detail.progress).toEqual([]);
  });

  it('the run detail route exposes progress from the ring', async () => {
    // A source-shape check only. It reads the file and does not import
    // `./aiAgents`: importing the real module pulled in the real `../db`
    // client, and under a loaded runner that import alone exceeded the test
    // timeout (four unrelated PR runs on 2026-11-10).
    const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('./aiAgents.ts', import.meta.url), 'utf8'));
    expect(source).toContain('readRunProgress(run.id)');
    expect(source).toMatch(/\n\s+progress,/);
  });
});
