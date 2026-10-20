import { useEffect, useState } from 'react';
import { unwrapData, type Fetcher } from '../../lib/api/serviceDeliverables';

export interface ContractOption {
  id: string;
  name: string;
}

interface ContractRow extends ContractOption {
  status?: string;
}

/** `listContractsQuerySchema` caps `limit` at 100. The org is passed
 *  explicitly so both the org record's pinned fetch and plain `fetchWithAuth`
 *  resolve the same org. */
const contractsPath = (orgId: string) => `/contracts?limit=100&orgId=${encodeURIComponent(orgId)}`;

/**
 * The org's contracts a deliverable can be filed under (#9302): draft, active
 * and paused. Cancelled contracts are refused by the API
 * (`CONTRACT_NOT_ASSIGNABLE`) and expired ones are over, so neither is offered.
 * `enabled` defers the request until a picker is actually opened. A failed load
 * is reported as `'failed'`, never as an empty list.
 */
export function useContractOptions(
  fetcher: Fetcher,
  orgId: string,
  enabled = true,
): { options: ContractOption[]; state: 'loading' | 'failed' | 'ready' } {
  const [options, setOptions] = useState<ContractOption[]>([]);
  const [state, setState] = useState<'loading' | 'failed' | 'ready'>('loading');

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState('loading');
    (async () => {
      try {
        const list = await unwrapData<ContractRow[]>(await fetcher(contractsPath(orgId)));
        if (cancelled) return;
        setOptions(
          (Array.isArray(list) ? list : [])
            .filter((c) => c.status !== 'cancelled' && c.status !== 'expired')
            .map((c) => ({ id: c.id, name: c.name })),
        );
        setState('ready');
      } catch (err) {
        console.error('[useContractOptions] failed to load contracts', err);
        if (!cancelled) setState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetcher, orgId, enabled]);

  return { options, state };
}
