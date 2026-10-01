/**
 * W03 parity (#7601): the REAL resolveModel against the legacy routing frozen
 * by w03Goldens.test.ts, through W02's harness (#7600 Task 11) — same
 * fixtures, same queries, same comparison rule (`sameUse`), same declared
 * divergences. Only the legacy side changed: a golden lookup instead of the
 * legacy code, which W03 deletes. (Task 7 appends toSurfaceUse + assertSurfaceParity.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ParityQuery, SurfaceUse } from './harness';

export const W03_GOLDENS_PATH = join(__dirname, 'w03Goldens.json');
export type W03Goldens = Record<string, Record<string, SurfaceUse>>;

export function queryKey(q: ParityQuery): string {
  switch (q.kind) {
    case 'surface': return `surface:${q.surface}:${q.orgId}`;
    case 'agent': return `agent:${q.agentKind}:${q.orgId}`;
    case 'session': return `session:${q.sessionId}`;
  }
}

export function loadW03Goldens(): W03Goldens {
  return JSON.parse(readFileSync(W03_GOLDENS_PATH, 'utf8')) as W03Goldens;
}
