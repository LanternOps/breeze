import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useJwtClaims } from '@/lib/authScope';
import { i18n } from '@/lib/i18n';
import { ActionError, runAction } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { fetchWithAuth, useAuthStore } from '../../../stores/auth';
import { useOrgStore } from '../../../stores/orgStore';
import { showToast } from '../../shared/Toast';
import type { EnsurePolicyResult } from '../featureTabs/policyCreateContext';
import {
  createOwnerBody,
  creatorKind,
  offersMspOwner,
  ownerDefault,
  type CreatorKind,
  type OwnerChoice,
} from './policyOwner';

/** The row `POST /configuration-policies` answers with (201). */
export type CreatedPolicy = {
  id: string;
  name: string;
  description?: string | null;
  status: 'active' | 'inactive' | 'archived';
  orgId: string | null;
  partnerId: string | null;
  parentPolicyId: string | null;
};

export type DraftParent = { id: string; name: string };

export type PolicyDraftState = {
  name: string;
  description: string;
  owner: OwnerChoice;
  /** Start from: null = Blank; else Based on this parent policy. */
  parent: DraftParent | null;
};

function parseCreated(raw: unknown): CreatedPolicy {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id) throw new Error(i18n.t('policies:configurationPolicies.policyCreate.createFailed'));
  const status = row.status === 'active' || row.status === 'archived' ? row.status : 'inactive';
  return {
    id: row.id,
    name: typeof row.name === 'string' ? row.name : '',
    description: typeof row.description === 'string' ? row.description : null,
    status,
    orgId: typeof row.orgId === 'string' ? row.orgId : null,
    partnerId: typeof row.partnerId === 'string' ? row.partnerId : null,
    parentPolicyId: typeof row.parentPolicyId === 'string' ? row.parentPolicyId : null,
  };
}

type Options = {
  /** False on an existing policy's page: nothing here is used. */
  enabled: boolean;
  /** The create succeeded; the page switches to edit mode in place. */
  onCreated: (row: CreatedPolicy, draft: PolicyDraftState) => void;
};

/**
 * The create page's draft (name, description, owner, parent) and the one
 * create call (plan W03d C1/C2). Nothing is created until a feature Save,
 * Activate or "Don't apply yet" asks for the policy.
 */
export function usePolicyDraft({ enabled, onCreated }: Options) {
  const claims = useJwtClaims();
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide);
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const kind: CreatorKind = creatorKind(claims, canManagePartnerWide);
  const ownOrgId = claims.status === 'resolved' ? claims.claims.orgId : null;
  const partnerId = claims.status === 'resolved' ? claims.claims.partnerId : null;

  const [name, setNameState] = useState('');
  const [description, setDescription] = useState('');
  const [owner, setOwnerState] = useState<OwnerChoice>(() => ownerDefault(kind, currentOrgId, ownOrgId));
  const [parent, setParentState] = useState<DraftParent | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [ownerError, setOwnerError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // An explicit owner choice is never overwritten by a late default.
  const ownerTouched = useRef(false);
  const createdRef = useRef<string | null>(null);
  const inflight = useRef<Promise<EnsurePolicyResult> | null>(null);

  // `canManagePartnerWide` is undefined until /users/me answers, which reads
  // as limited access; re-evaluate the default when it resolves, before the
  // first save only.
  useEffect(() => {
    if (!enabled || ownerTouched.current || createdRef.current) return;
    const next = ownerDefault(kind, currentOrgId, ownOrgId);
    setOwnerState((prev) => {
      if (JSON.stringify(prev) === JSON.stringify(next)) return prev;
      // A parent is eligible for one owner only: a new default drops it.
      setParentState(null);
      return next;
    });
  }, [enabled, kind, currentOrgId, ownOrgId]);

  // MSP-managed is never kept for a caller who may not manage it.
  useEffect(() => {
    if (owner.kind === 'msp' && !offersMspOwner(kind)) setOwnerState(ownerDefault(kind, currentOrgId, ownOrgId));
  }, [owner.kind, kind, currentOrgId, ownOrgId]);

  const draft = useMemo<PolicyDraftState>(() => ({ name, description, owner, parent }), [name, description, owner, parent]);
  const latest = useRef({ draft, kind, onCreated });
  latest.current = { draft, kind, onCreated };

  const setName = useCallback((next: string) => {
    setNameState(next);
    if (next.trim()) setNameError(null);
  }, []);
  const setOwner = useCallback((next: OwnerChoice) => {
    if (createdRef.current) return;
    ownerTouched.current = true;
    setOwnerState(next);
    setOwnerError(null);
    // A parent is eligible for one owner only.
    setParentState(null);
  }, []);
  const setParent = useCallback((next: DraftParent | null) => {
    if (createdRef.current) return;
    setParentState(next);
  }, []);

  const ensurePolicy = useCallback(
    async (opts: { successMessage?: string } = {}): Promise<EnsurePolicyResult> => {
      if (createdRef.current) return { ok: true, id: createdRef.current, created: false };
      if (inflight.current) return inflight.current;
      const { draft: d, kind: k } = latest.current;
      const trimmed = d.name.trim();
      if (!trimmed) {
        const message = i18n.t('policies:configurationPolicies.policyCreate.nameRequired');
        setNameError(message);
        return { ok: false, message };
      }
      const ownerBody = createOwnerBody(d.owner, k);
      if (!ownerBody) {
        const message = i18n.t('policies:configurationPolicies.policyCreate.organizationRequired');
        setOwnerError(message);
        return { ok: false, message };
      }
      const body = {
        name: trimmed,
        ...(d.description.trim() ? { description: d.description.trim() } : {}),
        // Inactive until someone activates it (spec Decision 2).
        status: 'inactive' as const,
        ...ownerBody,
        ...(d.parent ? { parentPolicyId: d.parent.id } : {}),
      };
      const fallback = i18n.t('policies:configurationPolicies.policyCreate.createFailed');
      const run = (async (): Promise<EnsurePolicyResult> => {
        setCreating(true);
        try {
          const row = await runAction<CreatedPolicy>({
            request: () => fetchWithAuth('/configuration-policies', { method: 'POST', body: JSON.stringify(body) }),
            errorFallback: fallback,
            parseSuccess: parseCreated,
            // One human message for every invalid parent (not found, not
            // eligible, hidden): show it, not the machine code.
            friendly: (code, _message, raw) => {
              if (code !== 'INVALID_PARENT_POLICY') return undefined;
              const msg = raw && typeof raw === 'object' ? (raw as { message?: unknown }).message : undefined;
              return typeof msg === 'string' && msg ? msg : i18n.t('policies:configurationPolicies.policyCreate.invalidParent');
            },
            ...(opts.successMessage ? { successMessage: opts.successMessage } : {}),
            onUnauthorized: () => void navigateTo('/login', { replace: true }),
          });
          createdRef.current = row.id;
          setCreatedId(row.id);
          try {
            latest.current.onCreated(row, d);
          } catch (err) {
            console.error('[configuration policies] after create', err);
          }
          return { ok: true, id: row.id, created: true };
        } catch (err) {
          if (err instanceof ActionError && err.status === 401) return { ok: false, message: null };
          if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback });
          return { ok: false, message: err instanceof Error && err.message ? err.message : fallback };
        } finally {
          setCreating(false);
          inflight.current = null;
        }
      })();
      inflight.current = run;
      return run;
    },
    [],
  );

  /** True when the owner can be sent; otherwise shows why on the Managed-by line. */
  const checkOwner = useCallback((): boolean => {
    if (createOwnerBody(latest.current.draft.owner, latest.current.kind)) return true;
    setOwnerError(i18n.t('policies:configurationPolicies.policyCreate.organizationRequired'));
    return false;
  }, []);

  return {
    kind,
    partnerId,
    checkOwner,
    draft,
    setName,
    setDescription,
    setOwner,
    setParent,
    nameError,
    ownerError,
    creating,
    createdId,
    ensurePolicy,
  };
}

export type PolicyDraftApi = ReturnType<typeof usePolicyDraft>;
