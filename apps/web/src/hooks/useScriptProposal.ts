import { useCallback, useEffect, useState } from 'react';
import type { ScriptProposalDetailDto } from '@breeze/shared';
import { fetchScriptProposal, ScriptProposalLoadError } from '@/lib/api/scriptProposals';

/** Abortable read with an explicit reload, following useDeviceOptions.ts:239-267.
 *  `id === null` is a legitimate idle state (a non-proposal approval), not an error. */
export function useScriptProposal(id: string | null): {
  data: ScriptProposalDetailDto | null;
  loading: boolean;
  error: string | null;
  /** HTTP status of a failed load (null when none or not an HTTP failure). */
  errorStatus: number | null;
  reload: () => void;
} {
  const [data, setData] = useState<ScriptProposalDetailDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!id) {
      setData(null);
      setError(null);
      setErrorStatus(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    fetchScriptProposal(id, controller.signal)
      .then((dto) => {
        setData(dto);
        setError(null);
        setErrorStatus(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setData(null);
        setError(err instanceof Error ? err.message : 'Failed to load proposal');
        setErrorStatus(err instanceof ScriptProposalLoadError ? err.status : null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, nonce]);

  return { data, loading, error, errorStatus, reload };
}
