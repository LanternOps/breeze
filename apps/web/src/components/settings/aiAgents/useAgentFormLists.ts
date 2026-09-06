import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import type { PolicyDecidableKeyOption } from './PolicyKeysCheckboxes';
import type { RoleOption } from './agentFields';

export interface UseAgentFormListsResult {
  roles: RoleOption[];
  /** GET /roles failed — render "could not load", never "no roles". */
  rolesFailed: boolean;
  policyKeys: PolicyDecidableKeyOption[];
  /** GET /ai/agents/policy-decidable-keys failed — render "could not load", never an empty registry. */
  policyKeysFailed: boolean;
}

/**
 * The two static lists both agent forms feed into `SafetyStep` (#5063 review):
 * recipient roles and the POLICY_DECIDABLE_TIER3 registry. Fetched once per
 * mount; the edit drawer and the guided create flow used to carry a verbatim
 * copy of each effect, so a fix to one silently missed the other.
 *
 * Roles: recipients are role IDs, never role names — `roles` is a
 * tenant-scoped table with partner-defined names, so the picker has to show
 * the real rows. A failure must NOT render as "no roles exist": the agents
 * page is gated on organizations:read but GET /roles is gated on users:read,
 * so a technician holding the former and not the latter gets a 403 — telling
 * them their tenant has no roles would turn an authorization error into a
 * configuration decision they never made, saving an agent that notifies
 * nobody.
 *
 * Registry (wave 5 Part B, #3827): a static, read-only list, so no dependency
 * on mode/agent. Defensive row filter, not just a type assertion: `key` /
 * `toolName` drive both the DOM id splice and the translated-label fallback,
 * and this registry is server-owned — a shape drift must degrade to "skip
 * the row", never crash the whole form. This route needs only
 * ai_agents:read, which the page is already gated on, so a 403 here is
 * unexpected — but the failure state still must not claim the registry is
 * empty.
 */
export function useAgentFormLists(): UseAgentFormListsResult {
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [rolesFailed, setRolesFailed] = useState(false);
  const [policyKeys, setPolicyKeys] = useState<PolicyDecidableKeyOption[]>([]);
  const [policyKeysFailed, setPolicyKeysFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithAuth('/roles');
        if (!response.ok) throw new Error(`GET /roles ${response.status}`);
        const body = (await response.json()) as { data?: RoleOption[] };
        if (!cancelled) setRoles(Array.isArray(body.data) ? body.data : []);
      } catch (err) {
        console.error('[useAgentFormLists] could not load roles', err);
        if (!cancelled) setRolesFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithAuth('/ai/agents/policy-decidable-keys');
        if (!response.ok) throw new Error(`GET /ai/agents/policy-decidable-keys ${response.status}`);
        const body = (await response.json()) as { data?: PolicyDecidableKeyOption[] };
        const rows = Array.isArray(body.data)
          ? body.data.filter(
              (row): row is PolicyDecidableKeyOption =>
                typeof row?.key === 'string' && typeof row?.toolName === 'string',
            )
          : [];
        if (!cancelled) setPolicyKeys(rows);
      } catch (err) {
        console.error('[useAgentFormLists] could not load policy-decidable keys', err);
        if (!cancelled) setPolicyKeysFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { roles, rolesFailed, policyKeys, policyKeysFailed };
}
