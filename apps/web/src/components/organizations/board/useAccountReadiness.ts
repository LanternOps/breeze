import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import type { ServiceManagementMode } from '@/stores/orgStore';
import type {
  AccountReadinessResponse,
  ReadinessCapabilities,
  ReadinessConnector,
  ReadinessOrg,
  ReadinessRowState,
} from '@/lib/orgReadiness';

/** The endpoint's hard cap on `orgIds` (400 above it). */
export const READINESS_BATCH_SIZE = 200;
/** At most two readiness requests in flight — the spec's ceiling for the web. */
export const READINESS_CONCURRENCY = 2;

export type ReadinessStatus = 'idle' | 'loading' | 'partial' | 'ready';

export interface AccountReadinessState {
  /** From the last batch that landed; null until the first one does. */
  capabilities: ReadinessCapabilities | null;
  mode: ServiceManagementMode | null;
  byOrg: ReadonlyMap<string, ReadinessOrg>;
  rowState: ReadonlyMap<string, ReadinessRowState>;
  status: ReadinessStatus;
  /** Partner-level connectors, identical across batches — the first successful batch wins. null until then, or when withheld. */
  connectors: ReadinessConnector[] | null;
  /** Re-requests only the batches that failed; rows that already landed are kept. */
  retry: () => void;
}

export function chunkIds(ids: readonly string[], size = READINESS_BATCH_SIZE): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

type BatchResult = { kind: 'ok'; response: AccountReadinessResponse } | { kind: 'failed' } | { kind: 'unauthorized' };

async function fetchBatch(ids: string[], partnerId?: string): Promise<BatchResult> {
  try {
    const res = await fetchWithAuth(`/orgs/account-readiness?${partnerId ? `partnerId=${encodeURIComponent(partnerId)}&` : ''}orgIds=${ids.join(',')}`);
    if (res.status === 401) return { kind: 'unauthorized' };
    if (!res.ok) return { kind: 'failed' };
    const body = (await res.json()) as AccountReadinessResponse | null;
    // An envelope without `orgs`/`capabilities` is not a readiness payload; treat it as a failed batch, never as "all complete".
    if (!body || typeof body !== 'object' || !Array.isArray(body.orgs) || !body.capabilities) return { kind: 'failed' };
    return { kind: 'ok', response: body };
  } catch {
    return { kind: 'failed' };
  }
}

/**
 * Batched account-readiness reads for the board. Every change to the SET of
 * ids starts a new generation: state is reset and the old generation's
 * responses are discarded on arrival (latest-wins). A manual reorder changes
 * the order, not the set, so it never refetches.
 */
export function useAccountReadiness(orgIds: readonly string[], partnerId?: string): AccountReadinessState {
  const key = [...orgIds].sort().join(',');
  const [capabilities, setCapabilities] = useState<ReadinessCapabilities | null>(null);
  const [mode, setMode] = useState<ServiceManagementMode | null>(null);
  const [byOrg, setByOrg] = useState<Map<string, ReadinessOrg>>(() => new Map());
  const [rowState, setRowState] = useState<Map<string, ReadinessRowState>>(() => new Map());
  const [connectors, setConnectors] = useState<ReadinessConnector[] | null>(null);
  const [inFlight, setInFlight] = useState(0);
  const [failedChunks, setFailedChunks] = useState<string[][]>([]);
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const runChunks = useCallback(async (chunks: string[][], gen: number) => {
    const queue = [...chunks];
    setInFlight((n) => n + chunks.length);
    const worker = async () => {
      for (;;) {
        const chunk = queue.shift();
        if (!chunk) return;
        const result = await fetchBatch(chunk, partnerId);
        // Latest-wins: a response for a superseded id set never touches state —
        // the newer generation already reset everything it is about to fill.
        if (!mounted.current || gen !== generation.current) return;
        if (result.kind === 'unauthorized') {
          handleSessionExpired();
          setInFlight((n) => n - 1);
          return;
        }
        if (result.kind === 'failed') {
          setRowState((prev) => {
            const next = new Map(prev);
            for (const id of chunk) next.set(id, 'failed');
            return next;
          });
          setFailedChunks((prev) => [...prev, chunk]);
        } else {
          const { response } = result;
          setCapabilities(response.capabilities);
          setMode(response.serviceManagementMode);
          setConnectors((current) => current ?? (response.capabilities.integrations ? (response.connectors ?? []) : null));
          setByOrg((prev) => {
            const next = new Map(prev);
            for (const org of response.orgs) next.set(org.orgId, org);
            return next;
          });
          // Mark ready only ids the server actually returned; a requested id
          // absent from `response.orgs` is a real data gap, not "complete" —
          // 'ready' with no `byOrg` entry would render an indistinguishable dash.
          const returnedIds = new Set(response.orgs.map((org) => org.orgId));
          setRowState((prev) => {
            const next = new Map(prev);
            for (const id of chunk) next.set(id, returnedIds.has(id) ? 'ready' : 'failed');
            return next;
          });
        }
        setInFlight((n) => n - 1);
      }
    };
    await Promise.all(Array.from({ length: Math.min(READINESS_CONCURRENCY, chunks.length) }, worker));
  }, [partnerId]);

  useEffect(() => {
    const gen = ++generation.current;
    const ids = key ? key.split(',') : [];
    setCapabilities(null);
    setMode(null);
    setByOrg(new Map());
    setConnectors(null);
    setFailedChunks([]);
    setRowState(new Map<string, ReadinessRowState>(ids.map((id) => [id, 'pending'])));
    setInFlight(0);
    if (ids.length === 0) return;
    void runChunks(chunkIds(ids), gen);
  }, [key, runChunks]);

  const retry = useCallback(() => {
    if (failedChunks.length === 0) return;
    const chunks = failedChunks;
    setFailedChunks([]);
    setRowState((prev) => {
      const next = new Map(prev);
      for (const id of chunks.flat()) next.set(id, 'pending');
      return next;
    });
    void runChunks(chunks, generation.current);
  }, [failedChunks, runChunks]);

  const status: ReadinessStatus = key === '' ? 'idle' : inFlight > 0 ? 'loading' : failedChunks.length > 0 ? 'partial' : 'ready';

  return { capabilities, mode, byOrg, rowState, status, connectors, retry };
}
