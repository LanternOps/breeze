import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { CreateDeliverableInput, UpdateDeliverableInput } from '@breeze/shared';
import {
  createDeliverable,
  updateDeliverable,
  type Deliverable,
  type DeliverableCadence,
  type DeliverableCompletionMode,
  type Fetcher,
} from '../../lib/api/serviceDeliverables';
import { ActionError, handleActionError } from '../../lib/runAction';
import { runClientAction } from '../../lib/runClientAction';

const CADENCES: readonly DeliverableCadence[] = ['monthly', 'quarterly', 'semiannual', 'annual', 'one_time'];
const COMPLETION_MODES: readonly DeliverableCompletionMode[] = ['explicit', 'on_ticket_resolve'];

export interface DeliverableFormProps {
  fetcher: Fetcher;
  orgId: string;
  /** When set, the deliverable is pinned to this contract and the contract
   *  picker is hidden. */
  contractId?: string | null;
  /** Contracts to choose from when `contractId` is not fixed. */
  contractOptions?: Array<{ id: string; name: string }>;
  /** Lifecycle of the `contractOptions` load when `contractId` is not fixed:
   *  `'loading'` disables the picker, `'failed'` shows an inline error and
   *  blocks Save — a deliverable that belongs under a contract must never be
   *  silently created standalone because the list did not arrive. */
  contractsState?: 'loading' | 'failed';
  /** Present in edit mode; cadence and anchor date become read-only. */
  initial?: Deliverable;
  onSaved: (d: Deliverable) => void;
  onCancel: () => void;
}

interface FormState {
  name: string;
  description: string;
  contractId: string;
  cadence: DeliverableCadence;
  anchorDueDate: string;
  effectiveFrom: string;
  effectiveUntil: string;
  leadDays: string;
  graceDays: string;
  artifactRequired: boolean;
  completionMode: DeliverableCompletionMode;
  portalVisible: boolean;
  sortOrder: string;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function initialState(initial: Deliverable | undefined, fixedContractId: string | null | undefined): FormState {
  if (initial) {
    return {
      name: initial.name,
      description: initial.description ?? '',
      contractId: initial.contractId ?? '',
      cadence: initial.cadence,
      anchorDueDate: initial.anchorDueDate,
      effectiveFrom: initial.effectiveFrom,
      effectiveUntil: initial.effectiveUntil ?? '',
      leadDays: String(initial.leadDays),
      graceDays: String(initial.graceDays),
      artifactRequired: initial.artifactRequired,
      completionMode: initial.completionMode,
      portalVisible: initial.portalVisible,
      sortOrder: String(initial.sortOrder),
    };
  }
  const today = todayISO();
  return {
    name: '',
    description: '',
    contractId: fixedContractId ?? '',
    cadence: 'monthly',
    anchorDueDate: today,
    effectiveFrom: today,
    effectiveUntil: '',
    leadDays: '7',
    graceDays: '14',
    artifactRequired: true,
    completionMode: 'on_ticket_resolve',
    portalVisible: true,
    sortOrder: '0',
  };
}

function intOr(value: string, fallback: number): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const inputClass =
  'w-full rounded-md border bg-background px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60';
const labelClass = 'block text-xs font-medium text-muted-foreground';

export default function DeliverableForm({
  fetcher,
  orgId,
  contractId: fixedContractId,
  contractOptions,
  contractsState,
  initial,
  onSaved,
  onCancel,
}: DeliverableFormProps) {
  const { t } = useTranslation('deliverables');
  const uid = useId();
  const id = (field: string) => `${uid}-${field}`;
  const isEdit = Boolean(initial);
  const [form, setForm] = useState<FormState>(() => initialState(initial, fixedContractId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The picker is always offered when no contract is pinned — an empty list
  // still lets the user confirm "not tied to a contract" deliberately.
  const showContractPicker = !fixedContractId;
  const contractsFailed = showContractPicker && contractsState === 'failed';
  const contractsLoading = showContractPicker && contractsState === 'loading';
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const resolvedContractId = (): string | null | undefined => {
    if (fixedContractId) return fixedContractId;
    if (showContractPicker) return form.contractId || null;
    return isEdit ? undefined : null;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    // Enter in a field submits past the disabled Save button; the guard has to
    // live here too or a failed contracts load still files the row standalone.
    if (saving || contractsFailed) return;
    setError(null);
    setSaving(true);
    try {
      const common = {
        name: form.name.trim(),
        description: form.description.trim() ? form.description.trim() : null,
        effectiveFrom: form.effectiveFrom,
        effectiveUntil: form.effectiveUntil ? form.effectiveUntil : null,
        leadDays: intOr(form.leadDays, 7),
        graceDays: intOr(form.graceDays, 14),
        artifactRequired: form.artifactRequired,
        completionMode: form.completionMode,
        portalVisible: form.portalVisible,
        sortOrder: intOr(form.sortOrder, 0),
      };
      const contractId = resolvedContractId();
      let saved: Deliverable;
      if (initial) {
        // cadence + anchorDueDate are deliberately absent: history is not rewritten (spec §16).
        const body: UpdateDeliverableInput = { ...common, ...(contractId !== undefined ? { contractId } : {}) };
        saved = await runClientAction(() => updateDeliverable(fetcher, orgId, initial.id, body), {
          errorFallback: t('errors.saveFailed'),
          successMessage: t('toast.saved'),
        });
      } else {
        const body: CreateDeliverableInput = {
          ...common,
          contractId: contractId ?? null,
          cadence: form.cadence,
          anchorDueDate: form.anchorDueDate,
        };
        saved = await runClientAction(() => createDeliverable(fetcher, orgId, body), {
          errorFallback: t('errors.saveFailed'),
          successMessage: t('toast.saved'),
        });
      }
      onSaved(saved);
    } catch (err) {
      if (err instanceof ActionError && err.status === 409 && err.code === 'DUPLICATE_NAME') {
        setError(t('errors.duplicateName'));
        return;
      }
      if (err instanceof ActionError && err.status !== 401) setError(err.message);
      handleActionError(err, t('errors.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3" data-testid="deliverable-form" noValidate>
      <div>
        <label htmlFor={id('name')} className={labelClass}>{t('form.name')}</label>
        <input
          id={id('name')}
          className={inputClass}
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          required
          maxLength={200}
        />
      </div>
      <div>
        <label htmlFor={id('description')} className={labelClass}>{t('form.description')}</label>
        <textarea
          id={id('description')}
          className={inputClass}
          rows={2}
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          maxLength={2000}
        />
      </div>
      {showContractPicker && (
        <div>
          <label htmlFor={id('contract')} className={labelClass}>{t('form.contract')}</label>
          <select
            id={id('contract')}
            className={inputClass}
            value={form.contractId}
            onChange={(e) => set('contractId', e.target.value)}
            disabled={contractsLoading || contractsFailed}
            aria-invalid={contractsFailed || undefined}
            data-testid="deliverable-form-contract"
          >
            <option value="">{t('form.noContract')}</option>
            {contractOptions?.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {contractsFailed && (
            <p className="mt-1 text-xs text-destructive" role="alert" data-testid="deliverable-form-contracts-error">
              {t('form.contractsUnavailable')}
            </p>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id('cadence')} className={labelClass}>{t('form.cadence')}</label>
          <select
            id={id('cadence')}
            className={inputClass}
            value={form.cadence}
            onChange={(e) => set('cadence', e.target.value as DeliverableCadence)}
            disabled={isEdit}
            data-testid="deliverable-form-cadence"
          >
            {CADENCES.map((c) => (
              <option key={c} value={c}>{t(/* i18n-dynamic */ `cadence.${c}`)}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id('anchor')} className={labelClass}>{t('form.anchorDueDate')}</label>
          <input
            id={id('anchor')}
            type="date"
            className={inputClass}
            value={form.anchorDueDate}
            onChange={(e) => set('anchorDueDate', e.target.value)}
            disabled={isEdit}
            required
            data-testid="deliverable-form-anchor"
          />
        </div>
        <div>
          <label htmlFor={id('from')} className={labelClass}>{t('form.effectiveFrom')}</label>
          <input
            id={id('from')}
            type="date"
            className={inputClass}
            value={form.effectiveFrom}
            onChange={(e) => set('effectiveFrom', e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor={id('until')} className={labelClass}>{t('form.effectiveUntil')}</label>
          <input
            id={id('until')}
            type="date"
            className={inputClass}
            value={form.effectiveUntil}
            onChange={(e) => set('effectiveUntil', e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={id('lead')} className={labelClass}>{t('form.leadDays')}</label>
          <input
            id={id('lead')}
            type="number"
            min={0}
            max={365}
            className={inputClass}
            value={form.leadDays}
            onChange={(e) => set('leadDays', e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={id('grace')} className={labelClass}>{t('form.graceDays')}</label>
          <input
            id={id('grace')}
            type="number"
            min={0}
            max={365}
            className={inputClass}
            value={form.graceDays}
            onChange={(e) => set('graceDays', e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={id('mode')} className={labelClass}>{t('form.completionMode.label')}</label>
          <select
            id={id('mode')}
            className={inputClass}
            value={form.completionMode}
            onChange={(e) => set('completionMode', e.target.value as DeliverableCompletionMode)}
          >
            {COMPLETION_MODES.map((m) => (
              <option key={m} value={m}>{t(/* i18n-dynamic */ `form.completionMode.${m}`)}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id('sort')} className={labelClass}>{t('form.sortOrder')}</label>
          <input
            id={id('sort')}
            type="number"
            min={0}
            className={inputClass}
            value={form.sortOrder}
            onChange={(e) => set('sortOrder', e.target.value)}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.artifactRequired}
            onChange={(e) => set('artifactRequired', e.target.checked)}
            data-testid="deliverable-form-artifact-required"
          />
          {t('form.artifactRequired')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.portalVisible}
            onChange={(e) => set('portalVisible', e.target.checked)}
            data-testid="deliverable-form-portal-visible"
          />
          {t('form.portalVisible')}
        </label>
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert" data-testid="deliverable-form-error">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
          data-testid="deliverable-form-cancel"
        >
          {t('actions.cancel')}
        </button>
        <button
          type="submit"
          disabled={saving || !form.name.trim() || contractsFailed}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          data-testid="deliverable-form-save"
        >
          {t('actions.save')}
        </button>
      </div>
    </form>
  );
}
