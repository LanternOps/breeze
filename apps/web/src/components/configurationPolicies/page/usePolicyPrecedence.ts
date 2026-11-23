import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchPolicyPrecedence, type PolicyPrecedence } from './precedenceApi';

/**
 * The policy's "outranked on N devices" answer (#12472). null = unknown: not
 * loaded yet, or the read failed or came back malformed. The page then shows
 * no outranked line at all, never a zero.
 *
 * `reload` drops the old answer at once (it describes the policy before the
 * change) and reads again. Only the newest read may land, so a slow first
 * read cannot overwrite the one taken after a change.
 */
export function usePolicyPrecedence(policyId: string | undefined): {
  precedence: PolicyPrecedence | null;
  reload: () => void;
} {
  const [precedence, setPrecedence] = useState<PolicyPrecedence | null>(null);
  const req = useRef(0);
  const load = useCallback(async () => {
    if (!policyId) return;
    const mine = ++req.current;
    try {
      const next = await fetchPolicyPrecedence(policyId);
      if (mine === req.current) setPrecedence(next);
    } catch (err) {
      console.warn('[configuration policies] precedence read failed', err);
      if (mine === req.current) setPrecedence(null);
    }
  }, [policyId]);
  useEffect(() => {
    void load();
  }, [load]);
  const reload = useCallback(() => {
    setPrecedence(null);
    void load();
  }, [load]);
  return { precedence, reload };
}
