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

  it(
    'the run detail route exposes progress from the ring',
    // Higher timeout: this dynamically imports the real (unmocked)
    // `./aiAgents` module purely to prove the source shape below — that pulls
    // in the real `../db` client, whose module-scope `postgres()` construction
    // is slow to settle under the no-DB unit runner. Same tradeoff other
    // source-string-check tests in this repo accept rather than replicating
    // aiAgents.test.ts's full mock surface for a check that never calls the
    // handler.
    async () => {
      const mod = await import('./aiAgents');
      expect(mod).toBeTruthy();
      const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('./aiAgents.ts', import.meta.url), 'utf8'));
      expect(source).toContain('readRunProgress(run.id)');
      expect(source).toMatch(/\n\s+progress,/);
    },
    15000,
  );
});
