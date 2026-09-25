import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { navigateTo } from '@/lib/navigation';
import { useHashState } from '@/lib/useHashState';
import '@/lib/i18n';
import ContractEditor from './ContractEditor';
import ContractDetail from './ContractDetail';
import { usePermissions } from '../../lib/permissions';
import {
  getContract,
  CONTRACT_STATUS_ROLES,
  type ContractDetail as ContractDetailData,
} from '../../lib/api/contracts';
import { listContractDocuments, type ContractDocument } from '../../lib/api/contractDocuments';
import { StatusPill } from '../billing/shared/StatusPill';
import { useStableT } from '@/lib/i18n/useStableT';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Props {
  /** Route param: a contract id, or the literal `'new'` for the create form. */
  contractId?: string;
}

export default function ContractWorkspace({ contractId }: Props) {
  const { t } = useTranslation('billing');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const isNew = contractId === 'new';
  const { can } = usePermissions();
  const canWrite = can('contracts', 'write');

  // Deep-linked org for the create form (e.g. `/contracts/new#orgId=…`), adopted
  // post-mount to avoid SSR hydration mismatches (#2421). Only meaningful when
  // `isNew`; harmless otherwise.
  const [presetOrgId] = useHashState<string | undefined>(
    undefined,
    (h) => new URLSearchParams(h).get('orgId') ?? undefined,
  );

  const [detail, setDetail] = useState<ContractDetailData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string>();
  // Active contracts are read-mostly; an explicit toggle reveals the editor.
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    if (isNew) { setLoading(false); return; }
    if (!contractId) { setError(stableT('contracts.contractWorkspace.errors.missingContractId')); setLoading(false); return; }
    try {
      setLoading(true);
      setError(undefined);
      const res = await getContract(contractId);
      if (res.status === 401) return UNAUTHORIZED();
      if (res.status === 404) { setError(stableT('contracts.contractWorkspace.errors.notFound')); return; }
      if (!res.ok) throw new Error(stableT('contracts.contractWorkspace.errors.loadContract'));
      const body = (await res.json().catch(() => null)) as { data: ContractDetailData } | null;
      if (!body) throw new Error(stableT('contracts.contractWorkspace.errors.loadContract'));
      setDetail(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : stableT('contracts.contractWorkspace.errors.loadContract'));
    } finally {
      setLoading(false);
    }
  }, [isNew, contractId, stableT]);

  useEffect(() => { void load(); }, [load]);

  // Spec §6 reciprocal link: name the agreement this contract sits under.
  //
  // Fetched HERE rather than bubbled out of the embedded SignedAgreementsPage
  // on ContractDetail, on purpose: a DRAFT contract renders ContractEditor, not
  // ContractDetail, so that list never mounts — and a draft auto-created from an
  // accepted quote is exactly when this pill matters most. The cost is one
  // duplicate contractId-scoped list GET; the projection carries no PDF bytes,
  // so it is cheap.
  //
  // "First by created_at" (spec §6) = the LAST element: the service orders
  // desc(createdAt).
  const [firstAgreement, setFirstAgreement] = useState<ContractDocument | null>(null);
  useEffect(() => {
    if (isNew || !contractId) return;
    let cancelled = false;
    // try/catch around the WHOLE body, not `.catch()` on the call: the client
    // can throw synchronously (or, under a stubbed transport, return nothing at
    // all), and an unhandled rejection out of a decorative effect would take the
    // page down with it.
    void (async () => {
      try {
        const res = await listContractDocuments({ contractId });
        if (!res?.ok) return;               // decoration; a failure is silent
        const body = (await res.json().catch(() => null)) as { data?: ContractDocument[] } | null;
        const docs = body?.data ?? [];
        if (!cancelled && docs.length) setFirstAgreement(docs[docs.length - 1]!);
      } catch {
        // no pill; never a page-level error
      }
    })();
    return () => { cancelled = true; };
  }, [isNew, contractId]);

  if (isNew) {
    return (
      <div className="space-y-4" data-testid="contract-workspace">
        <div>
          <a href="/contracts" className="text-xs text-muted-foreground hover:underline">{t('contracts.contractWorkspace.backToContracts')}</a>
          <h1 className="text-xl font-semibold" data-testid="contract-workspace-title">{t('contracts.contractWorkspace.newContract')}</h1>
        </div>
        {/* ContractEditor seeds its org select from presetOrgId in a useState
            initializer, so it must remount when the hash-derived value arrives
            post-mount (#2421) — otherwise the deep-linked org (the "New
            contract" CTA on the org Contracts tab) is silently dropped and the
            picker comes up empty. */}
        <ContractEditor key={presetOrgId ?? 'new'} presetOrgId={presetOrgId} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16" data-testid="contract-workspace-loading">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-sm text-destructive" data-testid="contract-workspace-error">
        {error ?? t('contracts.contractWorkspace.errors.unavailable')}
        <div>
          <a href="/contracts" className="mt-3 inline-block rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted">
            {t('contracts.contractWorkspace.backToContractsText')}
          </a>
        </div>
      </div>
    );
  }

  const { contract } = detail;
  // Drafts always edit; active contracts read-mostly with an Edit toggle.
  // A read-only viewer (no contracts:write) never sees the editor, even for a
  // draft — the server enforces it too, this just hides the write affordance.
  const showEditor = canWrite && (contract.status === 'draft' || editing);

  return (
    <div className="space-y-4" data-testid="contract-workspace">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <a href="/contracts" className="text-xs text-muted-foreground hover:underline">{t('contracts.contractWorkspace.backToContracts')}</a>
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="truncate text-xl font-semibold" data-testid="contract-workspace-title">{contract.name}</h1>
            <StatusPill
              role={CONTRACT_STATUS_ROLES[contract.status].role}
              label={t(/* i18n-dynamic */ `contracts.shared.status.${contract.status}`)}
              className={CONTRACT_STATUS_ROLES[contract.status].className}
            />
            {firstAgreement && (
              <a href="#signed-agreements" data-testid="contract-under-agreement-pill"
                 className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/70">
                {t('agreements.contractPill.under', {
                  template: firstAgreement.templateName,
                  n: firstAgreement.templateVersionNumber,
                })}
              </a>
            )}
          </div>
        </div>
        {contract.status === 'active' && canWrite && (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            data-testid="contract-edit-toggle"
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            {editing ? t('contracts.contractWorkspace.doneEditing') : t('common:actions.edit')}
          </button>
        )}
      </div>
      {showEditor ? (
        <ContractEditor detail={detail} onChanged={() => void load()} />
      ) : (
        <ContractDetail detail={detail} onChanged={() => void load()} />
      )}
    </div>
  );
}
