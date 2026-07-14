import '@/lib/i18n';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Building2, PackagePlus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { navigateTo } from '../../lib/navigation';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';
import { TableSkeleton } from '../billing/shared/TableSkeleton';
import {
  addPax8OrderLine,
  createPax8Order,
  getPax8Order,
  getProductDependencies,
  listPax8Companies,
  listPax8Orders,
  listPax8Products,
  listPax8Subscriptions,
  mapPax8Company,
  readData,
  type Pax8Commitment,
  type Pax8Company,
  type Pax8Order,
  type Pax8OrderBundle,
  type Pax8OrderLine,
  type Pax8ProductDependencies,
  type Pax8ProductOption,
  type Pax8Subscription,
} from '../../lib/api/pax8Orders';
import Pax8OrderBuilder from './Pax8OrderBuilder';
import { displayQuantity } from './pax8OrderUi';

const onUnauthorized = () => void navigateTo('/login', { replace: true });
const mutableStatuses = new Set(['draft', 'awaiting_details']);

function selectedOrderFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  const match = /^#pax8\/([0-9a-f-]{36})$/i.exec(window.location.hash);
  return match?.[1] ?? null;
}

function isKnownDrift(subscription: Pax8Subscription): boolean {
  return subscription.quantityKnown
    && subscription.breezeQuantity != null
    && Number(subscription.breezeQuantity) !== Number(subscription.quantity);
}

export function Pax8SubscriptionTable({
  subscriptions,
  onChangeQuantity,
  onCancel,
  busyId = null,
}: {
  subscriptions: Pax8Subscription[];
  onChangeQuantity: (subscription: Pax8Subscription, quantity: string) => void;
  onCancel: (subscription: Pax8Subscription) => void;
  busyId?: string | null;
}) {
  const { t } = useTranslation('settings');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (subscriptions.length === 0) {
    return <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground" data-testid="pax8-subscriptions-empty">{t('pax8.subscriptions.empty')}</div>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border bg-card" data-testid="pax8-subscriptions-table">
      <table className="min-w-[780px] w-full text-sm">
        <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2">{t('pax8.subscriptions.product')}</th><th className="px-3 py-2">{t('pax8.subscriptions.breeze')}</th><th className="px-3 py-2">{t('pax8.subscriptions.pax8')}</th><th className="px-3 py-2">{t('pax8.subscriptions.status')}</th><th className="px-3 py-2">{t('pax8.subscriptions.observed')}</th><th className="px-3 py-2 text-right">{t('pax8.subscriptions.actions')}</th></tr></thead>
        <tbody className="divide-y">{subscriptions.map((subscription) => {
          const unavailable = !subscription.productId || !subscription.contractLineId || subscription.breezeQuantity == null;
          const quantity = drafts[subscription.id] ?? subscription.breezeQuantity ?? '';
          return <tr key={subscription.id}>
            <td className="px-3 py-3"><p className="font-medium">{subscription.productName || subscription.productId || t('pax8.subscriptions.unknownProduct')}</p><p className="text-xs text-muted-foreground">{subscription.pax8SubscriptionId}</p></td>
            <td className="px-3 py-3"><strong data-testid={`pax8-breeze-quantity-${subscription.id}`} className="tabular-nums">{subscription.breezeQuantity == null ? t('pax8.subscriptions.notLinked') : displayQuantity(subscription.breezeQuantity)}</strong></td>
            <td className="px-3 py-3"><span data-testid={`pax8-reported-quantity-${subscription.id}`} className="tabular-nums text-muted-foreground">{subscription.quantityKnown ? displayQuantity(subscription.quantity) : t('pax8.subscriptions.notReported')}</span>{isKnownDrift(subscription) && <span data-testid={`pax8-drift-${subscription.id}`} className="ml-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-800 dark:text-amber-200">{t('pax8.subscriptions.drift')}</span>}</td>
            <td className="px-3 py-3">{subscription.status || t('pax8.subscriptions.unknownStatus')}</td>
            <td className="px-3 py-3 text-xs text-muted-foreground">{subscription.lastSeenAt ? new Date(subscription.lastSeenAt).toLocaleString() : t('pax8.subscriptions.neverObserved')}</td>
            <td className="px-3 py-3"><div className="flex items-center justify-end gap-2"><input aria-label={t('pax8.subscriptions.targetQuantity', { product: subscription.productName || '' })} type="number" min="0" step="0.01" value={quantity} disabled={unavailable || busyId === subscription.id} onChange={(event) => setDrafts((current) => ({ ...current, [subscription.id]: event.target.value }))} className="h-8 w-20 rounded-md border bg-background px-2 text-right tabular-nums disabled:opacity-50"/><button type="button" disabled={unavailable || busyId === subscription.id || quantity === '' || Number(quantity) < 0 || Number(quantity) === Number(subscription.breezeQuantity)} onClick={() => onChangeQuantity(subscription, quantity)} title={unavailable ? t('pax8.subscriptions.actionUnavailable') : undefined} className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50">{t('pax8.subscriptions.stageChange')}</button><button type="button" disabled={unavailable || busyId === subscription.id} onClick={() => onCancel(subscription)} title={unavailable ? t('pax8.subscriptions.actionUnavailable') : undefined} className="rounded-md border px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50">{t('pax8.subscriptions.cancel')}</button></div>{unavailable && <p className="mt-1 text-right text-xs text-muted-foreground">{t('pax8.subscriptions.actionUnavailable')}</p>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  );
}

export default function Pax8OrgTab({ orgId }: { orgId: string }) {
  const { t } = useTranslation('settings');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [integrationId, setIntegrationId] = useState<string | null>(null);
  const [companies, setCompanies] = useState<Pax8Company[]>([]);
  const [subscriptions, setSubscriptions] = useState<Pax8Subscription[]>([]);
  const [orders, setOrders] = useState<Pax8Order[]>([]);
  const [products, setProducts] = useState<Pax8ProductOption[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(() => selectedOrderFromHash());
  const [bundle, setBundle] = useState<Pax8OrderBundle | null>(null);
  const [bundleLoading, setBundleLoading] = useState(false);
  const [mappingChoice, setMappingChoice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelCandidate, setCancelCandidate] = useState<{ subscription: Pax8Subscription; commitment: Pax8Commitment } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [companiesResponse, subscriptionsResponse, ordersResponse, productsResponse] = await Promise.all([
        listPax8Companies(), listPax8Subscriptions(orgId), listPax8Orders(orgId), listPax8Products(),
      ]);
      const companyPayload = await companiesResponse.json().catch(() => null) as { data?: Pax8Company[]; integrationId?: string | null; error?: string } | null;
      if (!companiesResponse.ok) throw new Error(companyPayload?.error || t('pax8.errors.load'));
      const subscriptionPayload = await subscriptionsResponse.json().catch(() => null) as { data?: Pax8Subscription[]; integrationId?: string | null; error?: string } | null;
      if (!subscriptionsResponse.ok) throw new Error(subscriptionPayload?.error || t('pax8.errors.load'));
      const [nextOrders, nextProducts] = await Promise.all([
        readData<Pax8Order[]>(ordersResponse, t('pax8.errors.load')),
        readData<Pax8ProductOption[]>(productsResponse, t('pax8.errors.load')),
      ]);
      setCompanies(Array.isArray(companyPayload?.data) ? companyPayload.data : []);
      setIntegrationId(companyPayload?.integrationId ?? subscriptionPayload?.integrationId ?? null);
      setSubscriptions(Array.isArray(subscriptionPayload?.data) ? subscriptionPayload.data : []);
      setOrders(nextOrders.slice(0, 100));
      setProducts(nextProducts.slice(0, 200));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('pax8.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [orgId, t]);

  const loadBundle = useCallback(async () => {
    if (!selectedOrderId) { setBundle(null); return; }
    setBundleLoading(true);
    try {
      const loaded = await getPax8Order(selectedOrderId)
        .then((response) => readData<Pax8OrderBundle>(response, t('pax8.errors.loadOrder')));
      if (loaded.order.orgId !== orgId) throw new Error(t('pax8.errors.foreignOrder'));
      setBundle(loaded);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('pax8.errors.loadOrder'));
      setBundle(null);
    } finally { setBundleLoading(false); }
  }, [orgId, selectedOrderId, t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadBundle(); }, [loadBundle]);
  useEffect(() => {
    const syncHash = () => setSelectedOrderId(selectedOrderFromHash());
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
  }, []);

  const mappedCompany = companies.find((company) => company.mappedOrgId === orgId && !company.ignored) ?? null;
  const mappingOptions = companies.filter((company) => !company.ignored && (!company.mappedOrgId || company.mappedOrgId === orgId));
  const mappingReady = mappedCompany?.orderReady === true;

  const selectOrder = (id: string | null) => {
    setSelectedOrderId(id);
    const hash = id ? `#pax8/${id}` : '#pax8';
    if (window.location.hash !== hash) window.location.hash = hash;
  };

  const mapCompany = async () => {
    if (!integrationId || !mappingChoice) return;
    setBusy('mapping');
    try {
      await runAction({ request: () => mapPax8Company({ integrationId, pax8CompanyId: mappingChoice, orgId }), successMessage: t('pax8.toasts.companyMapped'), errorFallback: t('pax8.errors.mapCompany'), onUnauthorized });
      setMappingChoice('');
      await load();
    } catch (error) { handleActionError(error, t('pax8.errors.mapCompany')); }
    finally { setBusy(null); }
  };

  const ensureDraft = async (): Promise<Pax8Order | null> => {
    const existing = orders.find((order) => order.source === 'direct' && mutableStatuses.has(order.status));
    if (existing) return existing;
    try {
      return await runAction<Pax8Order>({ request: () => createPax8Order(orgId), parseSuccess: (value) => (value as { data: Pax8Order }).data, successMessage: t('pax8.toasts.draftReady'), errorFallback: t('pax8.errors.createDraft'), onUnauthorized });
    } catch (error) { handleActionError(error, t('pax8.errors.createDraft')); return null; }
  };

  const singleCommitment = async (subscription: Pax8Subscription): Promise<Pax8Commitment | null> => {
    if (!subscription.productId) return null;
    const dependencies = await getProductDependencies(subscription.productId).then((response) => readData<Pax8ProductDependencies>(response, t('pax8.errors.loadProduct')));
    if (subscription.activeCommitmentAmbiguous) {
      setActionError(t('pax8.subscriptions.commitmentUnavailable'));
      return null;
    }
    if (subscription.activeCommitmentId) {
      const matches = dependencies.commitments.filter(
        (commitment) => commitment.id === subscription.activeCommitmentId,
      );
      if (matches.length === 1) return matches[0]!;
      setActionError(t('pax8.subscriptions.commitmentUnavailable'));
      return null;
    }
    if (dependencies.commitments.length === 1) return dependencies.commitments[0]!;
    setActionError(t('pax8.subscriptions.commitmentUnavailable'));
    return null;
  };

  const stageQuantity = async (subscription: Pax8Subscription, target: string) => {
    setBusy(subscription.id); setActionError(null);
    try {
      const commitment = await singleCommitment(subscription);
      if (!commitment) return;
      const current = Number(subscription.breezeQuantity);
      const requested = Number(target);
      const allowed = requested > current ? commitment.allowForQuantityIncrease : commitment.allowForQuantityDecrease;
      if (!allowed) { setActionError(requested > current ? t('pax8.subscriptions.increaseBlocked') : t('pax8.subscriptions.decreaseBlocked')); return; }
      const order = await ensureDraft(); if (!order) return;
      await runAction<Pax8OrderLine>({ request: () => addPax8OrderLine(order.id, { action: 'change_quantity', targetSubscriptionId: subscription.pax8SubscriptionId, quantity: target, contractLineId: subscription.contractLineId }), parseSuccess: (value) => (value as { data: Pax8OrderLine }).data, successMessage: t('pax8.toasts.changeStaged'), errorFallback: t('pax8.errors.stageChange'), onUnauthorized });
      await load(); selectOrder(order.id);
    } catch (error) { if (!(error instanceof ActionError)) setActionError(error instanceof Error ? error.message : t('pax8.errors.stageChange')); handleActionError(error, t('pax8.errors.stageChange')); }
    finally { setBusy(null); }
  };

  const prepareCancel = async (subscription: Pax8Subscription) => {
    setBusy(subscription.id); setActionError(null);
    try {
      const commitment = await singleCommitment(subscription);
      if (!commitment) return;
      if (!commitment.allowForEarlyCancellation) { setActionError(t('pax8.subscriptions.cancelBlocked')); return; }
      setCancelCandidate({ subscription, commitment });
    } catch (error) { setActionError(error instanceof Error ? error.message : t('pax8.errors.stageCancel')); }
    finally { setBusy(null); }
  };

  const confirmCancel = async () => {
    if (!cancelCandidate) return;
    setBusy(cancelCandidate.subscription.id);
    try {
      const order = await ensureDraft(); if (!order) return;
      await runAction<Pax8OrderLine>({ request: () => addPax8OrderLine(order.id, { action: 'cancel', targetSubscriptionId: cancelCandidate.subscription.pax8SubscriptionId, contractLineId: cancelCandidate.subscription.contractLineId }), parseSuccess: (value) => (value as { data: Pax8OrderLine }).data, successMessage: t('pax8.toasts.cancelStaged'), errorFallback: t('pax8.errors.stageCancel'), onUnauthorized });
      setCancelCandidate(null); await load(); selectOrder(order.id);
    } catch (error) { handleActionError(error, t('pax8.errors.stageCancel')); }
    finally { setBusy(null); }
  };

  if (loading) return <div className="rounded-lg border bg-card"><TableSkeleton cols={5} rows={5} /></div>;
  if (loadError) return <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-5"><p className="text-sm text-destructive">{loadError}</p><button type="button" onClick={() => void load()} className="mt-3 rounded-md border bg-background px-3 py-2 text-sm hover:bg-muted">{t('pax8.actions.retry')}</button></div>;
  if (selectedOrderId) {
    if (bundleLoading) return <div className="rounded-lg border bg-card"><TableSkeleton cols={5} rows={4} /></div>;
    if (bundle) return <Pax8OrderBuilder bundle={bundle} products={products} onReload={async () => { await Promise.all([load(), loadBundle()]); }} onBack={() => selectOrder(null)} />;
  }

  return <div className="space-y-6" data-testid="pax8-org-tab">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{t('pax8.title')}</h2><p className="text-sm text-muted-foreground">{t('pax8.description')}</p></div><button type="button" data-testid="pax8-new-order" disabled={!mappingReady || products.length === 0 || busy !== null} title={!mappingReady ? t('pax8.mapping.activeRequired') : products.length === 0 ? t('pax8.products.emptyReason') : undefined} onClick={() => void (async () => { setBusy('draft'); const order = await ensureDraft(); setBusy(null); if (order) { await load(); selectOrder(order.id); } })()} className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"><PackagePlus className="h-4 w-4"/>{t('pax8.actions.newOrder')}</button></header>

    <section className="rounded-lg border bg-card p-5" data-testid="pax8-company-mapping"><div className="flex items-start gap-3"><Building2 className="mt-0.5 h-5 w-5 text-muted-foreground"/><div className="min-w-0 flex-1"><h3 className="font-medium">{t('pax8.mapping.title')}</h3>{mappedCompany ? <><p className="mt-1 text-sm">{mappedCompany.pax8CompanyName}</p><p className={`text-xs ${mappingReady ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-800 dark:text-amber-200'}`}>{mappedCompany.status || t('pax8.mapping.unknownStatus')}</p>{!mappingReady && <p className="mt-2 text-sm text-muted-foreground">{t('pax8.mapping.activeRequired')}</p>}</> : <div data-testid="pax8-mapping-empty"><p className="mt-1 text-sm text-muted-foreground">{integrationId ? t('pax8.mapping.empty') : t('pax8.mapping.noIntegration')}</p>{integrationId && <div className="mt-3 flex flex-col gap-2 sm:flex-row"><select aria-label={t('pax8.mapping.company')} value={mappingChoice} onChange={(event) => setMappingChoice(event.target.value)} className="h-10 flex-1 rounded-md border bg-background px-3 text-sm"><option value="">{t('pax8.mapping.choose')}</option>{mappingOptions.map((company) => <option key={company.pax8CompanyId} value={company.pax8CompanyId}>{company.pax8CompanyName}{company.status ? ` · ${company.status}` : ''}</option>)}</select><button type="button" disabled={!mappingChoice || busy !== null} onClick={() => void mapCompany()} className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{t('pax8.mapping.map')}</button></div>}</div>}</div></div></section>

    {actionError && <div role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100"><AlertTriangle className="mr-2 inline h-4 w-4"/>{actionError}</div>}
    {cancelCandidate && <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4"><p className="font-medium text-amber-900 dark:text-amber-100">{t('pax8.subscriptions.confirmCancel', { product: cancelCandidate.subscription.productName || cancelCandidate.subscription.pax8SubscriptionId })}</p>{cancelCandidate.commitment.cancellationFeeApplied && <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">{t('pax8.subscriptions.feeWarning')}</p>}<div className="mt-3 flex gap-2"><button type="button" onClick={() => void confirmCancel()} disabled={busy !== null} className="rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-50">{t('pax8.subscriptions.confirm')}</button><button type="button" onClick={() => setCancelCandidate(null)} className="rounded-md border bg-background px-3 py-2 text-sm hover:bg-muted">{t('pax8.subscriptions.keep')}</button></div></div>}

    <section className="space-y-3"><div><h3 className="font-medium">{t('pax8.subscriptions.title')}</h3><p className="text-sm text-muted-foreground">{t('pax8.subscriptions.description')}</p></div><Pax8SubscriptionTable subscriptions={subscriptions} onChangeQuantity={(subscription, next) => void stageQuantity(subscription, next)} onCancel={(subscription) => void prepareCancel(subscription)} busyId={busy}/></section>

    <section className="space-y-3"><div><h3 className="font-medium">{t('pax8.orders.title')}</h3><p className="text-sm text-muted-foreground">{t('pax8.orders.description')}</p></div>{orders.length === 0 ? <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{t('pax8.orders.empty')}</div> : <div className="divide-y rounded-lg border bg-card">{orders.map((order) => <button type="button" key={order.id} onClick={() => selectOrder(order.id)} className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-muted/50"><span><span className="block text-sm font-medium">{order.source === 'quote' ? t('pax8.orders.quoteOrder') : t('pax8.orders.directOrder')}</span><span className="block text-xs text-muted-foreground">{new Date(order.updatedAt).toLocaleString()}</span></span><span className="rounded-full border bg-muted px-2 py-0.5 text-xs capitalize">{order.status.replaceAll('_', ' ')}</span></button>)}</div>}</section>
  </div>;
}
