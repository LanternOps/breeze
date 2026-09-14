import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import {
  applyTemplateSet,
  listTemplateSets,
  type ApplyTemplateResult,
  type Fetcher,
  type TemplateSet,
} from '../../lib/api/deliverableTemplates';
import { ActionError, handleActionError } from '../../lib/runAction';
import { runClientAction } from '../../lib/runClientAction';
import { Drawer } from '../shared/Drawer';

export interface ApplyTemplateModalProps {
  fetcher: Fetcher;
  orgId: string;
  /** Preselects and locks the contract when opened from the contract
   *  deliverables section. */
  contractId?: string;
  onApplied: (result: ApplyTemplateResult) => void;
  onClose: () => void;
}

interface ContractOption {
  id: string;
  name: string;
}

type SetsState = 'loading' | 'failed' | TemplateSet[];
type ContractsState = 'loading' | 'failed' | ContractOption[];

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function collisionNames(err: ActionError): string[] {
  const body = err.body as { details?: { collisions?: unknown } } | undefined;
  const collisions = body?.details?.collisions;
  return Array.isArray(collisions) ? collisions.filter((c): c is string => typeof c === 'string') : [];
}

const inputClass = 'h-9 w-full rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring';
const labelClass = 'block text-xs font-medium text-muted-foreground';

/**
 * Applies a deliverable template set to an organization, optionally pinned to
 * a contract (feature #5573 W05, spec §9). Opened from OrgServiceTab (no
 * `contractId`, org-pinned `orgFetch`) or ContractDeliverablesSection (fixed
 * `contractId`, ambient `fetchWithAuth`) — both pass their own `fetcher`, same
 * shape as the rest of the deliverables surface (serviceDeliverables.ts).
 */
export function ApplyTemplateModal({ fetcher, orgId, contractId, onApplied, onClose }: ApplyTemplateModalProps) {
  const { t } = useTranslation('deliverables');
  const uid = useId();

  const [sets, setSets] = useState<SetsState>('loading');
  const [contracts, setContracts] = useState<ContractsState>(contractId ? [] : 'loading');
  const [setId, setSetId] = useState('');
  const [selectedContractId, setSelectedContractId] = useState(contractId ?? '');
  const [effectiveFrom, setEffectiveFrom] = useState(todayISO());
  const [submitting, setSubmitting] = useState(false);
  const [collisions, setCollisions] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await listTemplateSets(fetcher);
        if (!cancelled) setSets(rows);
      } catch (err) {
        console.error('[ApplyTemplateModal] failed to load template sets', err);
        if (!cancelled) setSets('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetcher]);

  // The contract picker is only fetched when the caller did not already pin
  // one — opened from the contract section, the field is hidden and fixed.
  useEffect(() => {
    if (contractId) return;
    let cancelled = false;
    setContracts('loading');
    (async () => {
      try {
        const res = await fetcher(`/contracts?limit=100&orgId=${encodeURIComponent(orgId)}`);
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const body = (await res.json()) as { data?: Array<{ id: string; name: string }> };
        const list = Array.isArray(body.data) ? body.data : [];
        if (!cancelled) setContracts(list.map((c) => ({ id: c.id, name: c.name })));
      } catch (err) {
        console.error('[ApplyTemplateModal] failed to load contracts', err);
        if (!cancelled) setContracts('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetcher, orgId, contractId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!setId || submitting) return;
    setSubmitting(true);
    setError(null);
    setCollisions(null);
    try {
      const chosenContractId = contractId ?? (selectedContractId || undefined);
      const result = await runClientAction(
        () =>
          applyTemplateSet(fetcher, orgId, {
            setId,
            ...(chosenContractId ? { contractId: chosenContractId } : {}),
            effectiveFrom,
          }),
        {
          errorFallback: t('templates.errors.applyFailed'),
          successMessage: (r) => {
            const parts = [
              t('templates.toast.applied'),
              t('templates.apply.created', { count: r.created.length }),
            ];
            if (r.skipped.length > 0) {
              parts.push(t('templates.apply.skipped', { names: r.skipped.join(', ') }));
            }
            return parts.join(' — ');
          },
        },
      );
      onApplied(result);
    } catch (err) {
      if (err instanceof ActionError && err.status === 409 && err.code === 'TEMPLATE_NAME_COLLISION') {
        setCollisions(collisionNames(err));
        return;
      }
      if (err instanceof ActionError && err.status !== 401) setError(err.message);
      handleActionError(err, t('templates.errors.applyFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const setsLoading = sets === 'loading';
  const setsFailed = sets === 'failed';
  const contractsLoading = !contractId && contracts === 'loading';
  const contractsFailed = !contractId && contracts === 'failed';

  return (
    <Drawer open onClose={onClose} title={t('templates.apply.title')} width="max-w-md" dataTestId="apply-template-modal" closeDisabled={submitting}>
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 p-5" data-testid="apply-template-form">
        <div>
          <label htmlFor={`${uid}-set`} className={labelClass}>{t('templates.apply.set')}</label>
          <select
            id={`${uid}-set`}
            data-testid="apply-template-set"
            className={inputClass}
            value={setId}
            onChange={(e) => setSetId(e.target.value)}
            disabled={setsLoading || setsFailed}
            required
          >
            <option value="" disabled>
              {t('templates.apply.set')}
            </option>
            {Array.isArray(sets) &&
              sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.orgId === null ? `${s.name} (${t('templates.allOrganizations')})` : s.name}
                </option>
              ))}
          </select>
          {setsFailed && (
            <p className="mt-1 text-xs text-destructive" role="alert">{t('templates.errors.loadFailed')}</p>
          )}
        </div>

        {contractId ? (
          <input type="hidden" data-testid="apply-template-contract" value={contractId} readOnly />
        ) : (
          <div>
            <label htmlFor={`${uid}-contract`} className={labelClass}>{t('templates.apply.contract')}</label>
            <select
              id={`${uid}-contract`}
              data-testid="apply-template-contract"
              className={inputClass}
              value={selectedContractId}
              onChange={(e) => setSelectedContractId(e.target.value)}
              disabled={contractsLoading || contractsFailed}
            >
              <option value="">{t('templates.apply.noContract')}</option>
              {Array.isArray(contracts) &&
                contracts.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
            </select>
          </div>
        )}

        <div>
          <label htmlFor={`${uid}-effective-from`} className={labelClass}>{t('templates.apply.effectiveFrom')}</label>
          <input
            id={`${uid}-effective-from`}
            type="date"
            data-testid="apply-template-effective-from"
            className={inputClass}
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            required
          />
        </div>

        {collisions && collisions.length > 0 && (
          <p className="text-sm text-destructive" role="alert" data-testid="apply-template-collision">
            {t('templates.errors.collision', { names: collisions.join(', ') })}
          </p>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert" data-testid="apply-template-error">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {t('templates.actions.cancel')}
          </button>
          <button
            type="submit"
            data-testid="apply-template-submit"
            disabled={submitting || !setId || setsFailed}
            className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {t('templates.apply.submit')}
          </button>
        </div>
      </form>
    </Drawer>
  );
}

export default ApplyTemplateModal;
