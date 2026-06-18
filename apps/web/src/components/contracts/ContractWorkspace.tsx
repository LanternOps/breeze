import { useCallback, useEffect, useState } from 'react';
import { navigateTo } from '@/lib/navigation';
import ContractEditor from './ContractEditor';
import ContractDetail from './ContractDetail';
import { usePermissions } from '../../lib/permissions';
import {
  getContract,
  CONTRACT_STATUS_COLORS,
  CONTRACT_STATUS_LABELS,
  type ContractDetail as ContractDetailData,
} from '../../lib/api/contracts';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Props {
  /** Route param: a contract id, or the literal `'new'` for the create form. */
  contractId?: string;
}

/** Read a deep-linked org for the create form (e.g. `/contracts/new#orgId=…`). */
function readPresetOrgId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return params.get('orgId') ?? undefined;
}

export default function ContractWorkspace({ contractId }: Props) {
  const isNew = contractId === 'new';
  const { can } = usePermissions();
  const canWrite = can('contracts', 'write');

  const [detail, setDetail] = useState<ContractDetailData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string>();
  // Active contracts are read-mostly; an explicit toggle reveals the editor.
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    if (isNew) { setLoading(false); return; }
    if (!contractId) { setError('Missing contract id'); setLoading(false); return; }
    try {
      setLoading(true);
      setError(undefined);
      const res = await getContract(contractId);
      if (res.status === 401) return UNAUTHORIZED();
      if (res.status === 404) { setError('Contract not found.'); return; }
      if (!res.ok) throw new Error('Failed to load contract');
      const body = (await res.json().catch(() => null)) as { data: ContractDetailData } | null;
      if (!body) throw new Error('Failed to load contract');
      setDetail(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load contract');
    } finally {
      setLoading(false);
    }
  }, [isNew, contractId]);

  useEffect(() => { void load(); }, [load]);

  if (isNew) {
    return (
      <div className="space-y-4" data-testid="contract-workspace">
        <div>
          <a href="/contracts" className="text-xs text-muted-foreground hover:underline">← Contracts</a>
          <h1 className="text-xl font-semibold" data-testid="contract-workspace-title">New contract</h1>
        </div>
        <ContractEditor presetOrgId={readPresetOrgId()} />
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
        {error ?? 'Contract unavailable.'}
        <div>
          <a href="/contracts" className="mt-3 inline-block rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted">
            Back to contracts
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
        <div>
          <a href="/contracts" className="text-xs text-muted-foreground hover:underline">← Contracts</a>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold" data-testid="contract-workspace-title">{contract.name}</h1>
            <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${CONTRACT_STATUS_COLORS[contract.status]}`}>
              {CONTRACT_STATUS_LABELS[contract.status]}
            </span>
          </div>
        </div>
        {contract.status === 'active' && canWrite && (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            data-testid="contract-edit-toggle"
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            {editing ? 'Done editing' : 'Edit'}
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
