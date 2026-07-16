import '@/lib/i18n';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PAX8_BILLING_TERMS } from '@breeze/shared';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';
import { navigateTo } from '../../lib/navigation';
import {
  addPax8OrderLine,
  getProductDependencies,
  getProvisionDetails,
  preflightPax8Order,
  reconcilePax8Order,
  readData,
  removePax8OrderLine,
  submitPax8Order,
  updatePax8OrderLine,
  type Pax8OrderBundle,
  type Pax8OrderLine,
  type Pax8ProductDependencies,
  type Pax8ProductOption,
  type Pax8ProvisionField,
  type ProvisioningValue,
} from '../../lib/api/pax8Orders';
import { Pax8ProvisioningForm } from './Pax8ProvisioningForm';
import {
  PAX8_BILLING_TERM_I18N_KEYS,
  PAX8_ORDER_ACTION_I18N_KEYS,
  PAX8_ORDER_STATUS_I18N_KEYS,
  PAX8_SUBMIT_STATE_I18N_KEYS,
  displayQuantity,
  extractPax8PreflightErrors,
  type PreflightErrors,
} from './pax8OrderUi';

const onUnauthorized = () => void navigateTo('/login', { replace: true });
const authoringStatuses = new Set(['draft', 'awaiting_details']);
const submittableStatuses = new Set(['draft', 'awaiting_details', 'ready']);

function lineLabel(line: Pax8OrderLine, products: Pax8ProductOption[], fallback: string): string {
  const product = products.find((candidate) => candidate.pax8ProductId === line.pax8ProductId);
  return product?.catalogName || line.pax8ProductId || line.targetSubscriptionId || fallback;
}

function statusClasses(status: string): string {
  if (status === 'succeeded' || status === 'completed') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (status === 'failed' || status === 'partially_failed') return 'border-destructive/40 bg-destructive/10 text-destructive';
  if (status === 'needs_reconcile' || status === 'in_flight' || status === 'submitting') return 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200';
  return 'border-border bg-muted text-muted-foreground';
}

export default function Pax8OrderBuilder({
  bundle,
  products,
  onReload,
  onBack,
}: {
  bundle: Pax8OrderBundle;
  products: Pax8ProductOption[];
  onReload: () => Promise<void>;
  onBack: () => void;
}) {
  const { t } = useTranslation('settings');
  const { order, lines } = bundle;
  const mutable = authoringStatuses.has(order.status);
  const directMutable = mutable && order.source === 'direct';
  const hasInFlight = lines.some((line) => line.submitState === 'in_flight');
  const hasNeedsReconcile = lines.some((line) => line.submitState === 'needs_reconcile');
  const allPending = lines.length > 0 && lines.every((line) => line.submitState === 'pending');
  const canReconcile = (order.status === 'submitting' && (hasInFlight || allPending))
    || (order.status === 'partially_failed' && hasNeedsReconcile);
  const canSubmit = submittableStatuses.has(order.status)
    && lines.every((line) => line.submitState === 'pending');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [billingTerm, setBillingTerm] = useState<(typeof PAX8_BILLING_TERMS)[number]>('Monthly');
  const [commitmentTermId, setCommitmentTermId] = useState('');
  const [details, setDetails] = useState<ProvisioningValue[]>([]);
  const [fields, setFields] = useState<Pax8ProvisionField[]>([]);
  const [dependencies, setDependencies] = useState<Pax8ProductDependencies>({ commitments: [] });
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState(false);
  const [metadataVersion, setMetadataVersion] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [preflightErrors, setPreflightErrors] = useState<PreflightErrors>({ byLine: new Map(), order: [] });
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [editDetails, setEditDetails] = useState<ProvisioningValue[]>([]);
  const [editCommitmentId, setEditCommitmentId] = useState('');
  const [editFields, setEditFields] = useState<Pax8ProvisionField[]>([]);
  const [editDependencies, setEditDependencies] = useState<Pax8ProductDependencies>({ commitments: [] });

  const selectedProduct = useMemo(
    () => products.find((product) => product.pax8ProductId === selectedProductId) ?? null,
    [products, selectedProductId],
  );

  useEffect(() => {
    if (!selectedProductId) {
      setFields([]);
      setDependencies({ commitments: [] });
      setDetails([]);
      setCommitmentTermId('');
      return;
    }
    let active = true;
    setMetadataLoading(true);
    setMetadataError(false);
    Promise.all([
      getProvisionDetails(selectedProductId).then((response) => readData<Pax8ProvisionField[]>(response, t('pax8.errors.loadProduct'))),
      getProductDependencies(selectedProductId).then((response) => readData<Pax8ProductDependencies>(response, t('pax8.errors.loadProduct'))),
    ]).then(([nextFields, nextDependencies]) => {
      if (!active) return;
      setFields(nextFields);
      setDependencies(nextDependencies);
      setCommitmentTermId(nextDependencies.commitments.length === 1 ? nextDependencies.commitments[0]!.id : '');
    }).catch(() => {
      if (!active) return;
      setFields([]);
      setDependencies({ commitments: [] });
      setMetadataError(true);
    }).finally(() => { if (active) setMetadataLoading(false); });
    return () => { active = false; };
  }, [selectedProductId, metadataVersion, t]);

  const mutation = async <T,>(key: string, options: Parameters<typeof runAction<T>>[0], after = true): Promise<T | null> => {
    setBusy(key);
    try {
      const result = await runAction<T>(options);
      if (after) await onReload();
      return result;
    } catch (error) {
      handleActionError(error, options.errorFallback);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const addProduct = async () => {
    if (!selectedProduct || !(Number(quantity) > 0)) return;
    const result = await mutation<Pax8OrderLine>('add', {
      request: () => addPax8OrderLine(order.id, {
        action: 'new_subscription',
        pax8ProductId: selectedProduct.pax8ProductId,
        catalogItemId: selectedProduct.catalogItemId,
        billingTerm,
        quantity,
        ...(commitmentTermId ? { commitmentTermId } : {}),
        provisioningDetails: details,
      }),
      parseSuccess: (value) => (value as { data: Pax8OrderLine }).data,
      successMessage: t('pax8.toasts.lineAdded'),
      errorFallback: t('pax8.errors.addLine'),
      onUnauthorized,
    });
    if (result) {
      setSelectedProductId('');
      setQuantity('1');
      setDetails([]);
      setPreflightErrors({ byLine: new Map(), order: [] });
    }
  };

  const beginEdit = async (line: Pax8OrderLine) => {
    if (!line.pax8ProductId) return;
    setBusy(`edit-load-${line.id}`);
    try {
      const [nextFields, nextDependencies] = await Promise.all([
        getProvisionDetails(line.pax8ProductId).then((response) => readData<Pax8ProvisionField[]>(response, t('pax8.errors.loadProduct'))),
        getProductDependencies(line.pax8ProductId).then((response) => readData<Pax8ProductDependencies>(response, t('pax8.errors.loadProduct'))),
      ]);
      setEditFields(nextFields);
      setEditDependencies(nextDependencies);
      setEditDetails(Array.isArray(line.provisioningDetails) ? line.provisioningDetails : []);
      setEditCommitmentId(line.commitmentTermId ?? '');
      setEditingLineId(line.id);
    } catch {
      setPreflightErrors({ byLine: new Map(), order: [t('pax8.errors.loadProduct')] });
    } finally {
      setBusy(null);
    }
  };

  const saveLine = async () => {
    if (!editingLineId) return;
    const result = await mutation<Pax8OrderLine>('edit-save', {
      request: () => updatePax8OrderLine(order.id, editingLineId, {
        commitmentTermId: editCommitmentId || null,
        provisioningDetails: editDetails,
      }),
      parseSuccess: (value) => (value as { data: Pax8OrderLine }).data,
      successMessage: t('pax8.toasts.lineUpdated'),
      errorFallback: t('pax8.errors.updateLine'),
      onUnauthorized,
    });
    if (result) setEditingLineId(null);
  };

  const removeLine = async (lineId: string) => {
    const result = await mutation<{ removed: boolean }>(`remove-${lineId}`, {
      request: () => removePax8OrderLine(order.id, lineId),
      successMessage: t('pax8.toasts.lineRemoved'),
      errorFallback: t('pax8.errors.removeLine'),
      onUnauthorized,
    });
    if (result) setPreflightErrors({ byLine: new Map(), order: [] });
  };

  const preflightAndSubmit = async () => {
    setBusy('submit');
    setPreflightErrors({ byLine: new Map(), order: [] });
    try {
      await runAction({
        request: () => preflightPax8Order(order.id),
        successMessage: t('pax8.toasts.preflightPassed'),
        errorFallback: t('pax8.errors.preflight'),
        onUnauthorized,
      });
      const result = await runAction<{ status: string }>({
        request: () => submitPax8Order(order.id),
        successMessage: (response) => response.status === 'completed'
          ? t('pax8.toasts.submitted')
          : t('pax8.toasts.submitNeedsAttention'),
        errorFallback: t('pax8.errors.submit'),
        onUnauthorized,
      });
      await onReload();
      return result;
    } catch (error) {
      if (error instanceof ActionError && error.status === 422) {
        setPreflightErrors(extractPax8PreflightErrors(error.body));
      }
      handleActionError(error, t('pax8.errors.submit'));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const reconcile = async () => {
    await mutation('reconcile', {
      request: () => reconcilePax8Order(order.id),
      successMessage: t('pax8.toasts.reconciled'),
      errorFallback: t('pax8.errors.reconcile'),
      onUnauthorized,
    });
  };

  return (
    <section className="space-y-5" data-testid="pax8-order-builder">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <button type="button" onClick={onBack} className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> {t('pax8.order.back')}
          </button>
          <h3 className="text-lg font-semibold">{t('pax8.order.title')}</h3>
          <p className="text-sm text-muted-foreground">
            {order.source === 'quote' ? t('pax8.order.quoteSource') : t('pax8.order.directSource')}
          </p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${statusClasses(order.status)}`}>
          {t(/* i18n-dynamic */ PAX8_ORDER_STATUS_I18N_KEYS[order.status])}
        </span>
      </div>

      {order.error && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100">
          <AlertTriangle className="mr-2 inline h-4 w-4" />{order.error}
        </div>
      )}

      {directMutable && (
        <div className="rounded-lg border bg-card p-4">
          <h4 className="font-medium">{t('pax8.order.addProduct')}</h4>
          <div className="mt-3 grid gap-3 md:grid-cols-4">
            <label className="space-y-1 text-sm md:col-span-2">
              <span className="font-medium">{t('pax8.order.product')}</span>
              <select data-testid="pax8-product-select" value={selectedProductId} onChange={(event) => setSelectedProductId(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3">
                <option value="">{t('pax8.order.chooseProduct')}</option>
                {products.map((product) => <option key={`${product.pax8ProductId}:${product.catalogItemId}`} value={product.pax8ProductId}>{product.catalogName}{product.catalogSku ? ` · ${product.catalogSku}` : ''}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">{t('pax8.order.billingTerm')}</span>
              <select value={billingTerm} onChange={(event) => setBillingTerm(event.target.value as typeof billingTerm)} className="h-10 w-full rounded-md border bg-background px-3">
                {PAX8_BILLING_TERMS.map((term) => <option key={term} value={term}>{t(/* i18n-dynamic */ PAX8_BILLING_TERM_I18N_KEYS[term])}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">{t('pax8.order.quantity')}</span>
              <input data-testid="pax8-product-quantity" type="number" min="0.01" step="0.01" value={quantity} onChange={(event) => setQuantity(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3" />
            </label>
          </div>
          {selectedProduct && (
            <div className="mt-4 space-y-4 border-t pt-4">
              {metadataLoading ? <p className="text-sm text-muted-foreground">{t('pax8.states.loadingProduct')}</p> : metadataError ? (
                <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  <p>{t('pax8.errors.loadProduct')}</p>
                  <button type="button" onClick={() => setMetadataVersion((version) => version + 1)} className="mt-2 rounded-md border bg-background px-3 py-1.5 text-foreground hover:bg-muted">{t('pax8.actions.retry')}</button>
                </div>
              ) : (
                <>
                  {dependencies.commitments.length > 0 && (
                    <label className="block max-w-sm space-y-1 text-sm">
                      <span className="font-medium">{t('pax8.order.commitment')}</span>
                      <select value={commitmentTermId} onChange={(event) => setCommitmentTermId(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3">
                        <option value="">{t('pax8.order.noCommitmentSelected')}</option>
                        {dependencies.commitments.map((commitment) => <option key={commitment.id} value={commitment.id}>{commitment.term || commitment.id}</option>)}
                      </select>
                    </label>
                  )}
                  <Pax8ProvisioningForm fields={fields} value={details} onChange={setDetails} />
                </>
              )}
              <button type="button" data-testid="pax8-add-product" onClick={() => void addProduct()} disabled={busy !== null || metadataLoading || metadataError || !(Number(quantity) > 0) || (dependencies.commitments.length > 0 && !commitmentTermId)} className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
                <Plus className="h-4 w-4" /> {t('pax8.order.addToOrder')}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="min-w-[680px] w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr><th className="px-3 py-2">{t('pax8.order.item')}</th><th className="px-3 py-2">{t('pax8.order.action')}</th><th className="px-3 py-2">{t('pax8.order.quantity')}</th><th className="px-3 py-2">{t('pax8.order.state')}</th><th className="px-3 py-2 text-right">{t('pax8.order.actions')}</th></tr>
          </thead>
          <tbody className="divide-y">
            {lines.length === 0 ? <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">{t('pax8.order.empty')}</td></tr> : lines.map((line) => {
              const messages = preflightErrors.byLine.get(line.sortOrder + 1) ?? [];
              return (
                <tr key={line.id} data-testid={`pax8-order-line-${line.id}`}>
                  <td className="px-3 py-3 font-medium">{lineLabel(line, products, t('pax8.order.unknownItem'))}{messages.map((message) => <p key={message} className="mt-1 text-xs font-normal text-destructive" data-testid={`pax8-line-error-${line.id}`}>{message}</p>)}{line.error && <p className="mt-1 text-xs font-normal text-destructive">{line.error}</p>}</td>
                  <td className="px-3 py-3">{t(/* i18n-dynamic */ PAX8_ORDER_ACTION_I18N_KEYS[line.action])}</td>
                  <td className="px-3 py-3 tabular-nums">{displayQuantity(line.quantity)}</td>
                  <td className="px-3 py-3"><span className={`rounded-full border px-2 py-0.5 text-xs ${statusClasses(line.submitState)}`}>{t(/* i18n-dynamic */ PAX8_SUBMIT_STATE_I18N_KEYS[line.submitState])}</span></td>
                  <td className="px-3 py-3"><div className="flex justify-end gap-1">
                    {mutable && line.action === 'new_subscription' && <button type="button" onClick={() => void beginEdit(line)} disabled={busy !== null} className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50">{t('pax8.order.editDetails')}</button>}
                    {directMutable && <button type="button" aria-label={t('pax8.order.remove')} onClick={() => void removeLine(line.id)} disabled={busy !== null} className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-50"><Trash2 className="h-4 w-4" /></button>}
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editingLineId && (
        <div className="rounded-lg border bg-card p-4" data-testid="pax8-staged-line-editor">
          <h4 className="font-medium">{t('pax8.order.editProvisioning')}</h4>
          {editDependencies.commitments.length > 0 && <label className="my-3 block max-w-sm space-y-1 text-sm"><span className="font-medium">{t('pax8.order.commitment')}</span><select value={editCommitmentId} onChange={(event) => setEditCommitmentId(event.target.value)} className="h-10 w-full rounded-md border bg-background px-3"><option value="">{t('pax8.order.noCommitmentSelected')}</option>{editDependencies.commitments.map((commitment) => <option key={commitment.id} value={commitment.id}>{commitment.term || commitment.id}</option>)}</select></label>}
          <Pax8ProvisioningForm fields={editFields} value={editDetails} onChange={setEditDetails} disabled={busy === 'edit-save'} />
          <div className="mt-4 flex gap-2"><button type="button" onClick={() => void saveLine()} disabled={busy !== null || (editDependencies.commitments.length > 0 && !editCommitmentId)} className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{t('pax8.order.saveDetails')}</button><button type="button" onClick={() => setEditingLineId(null)} className="rounded-md border px-3 py-2 text-sm hover:bg-muted">{t('pax8.order.cancelEdit')}</button></div>
        </div>
      )}

      {preflightErrors.order.length > 0 && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" data-testid="pax8-order-errors">{preflightErrors.order.map((message) => <p key={message}>{message}</p>)}</div>}

      <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
        {canReconcile ? <button type="button" data-testid="pax8-reconcile" onClick={() => void reconcile()} disabled={busy !== null} className="inline-flex items-center gap-2 rounded-md bg-amber-800 px-4 py-2 text-sm font-medium text-white hover:bg-amber-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"><RefreshCw className="h-4 w-4" />{t('pax8.order.reconcile')}</button> : canSubmit && <button type="button" data-testid="pax8-submit" onClick={() => void preflightAndSubmit()} disabled={busy !== null || lines.length === 0} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{busy === 'submit' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{t('pax8.order.reviewSubmit')}</button>}
        {order.status === 'completed' && <span className="inline-flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-4 w-4" />{t('pax8.order.completed')}</span>}
      </div>
    </section>
  );
}
