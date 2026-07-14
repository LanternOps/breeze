import { fetchWithAuth } from '../../stores/auth';
import type { Pax8BillingTerm } from '@breeze/shared';

export type Pax8OrderStatus =
  | 'draft' | 'awaiting_details' | 'ready' | 'submitting' | 'completed'
  | 'partially_failed' | 'failed' | 'cancelled' | 'needs_reconcile';
export type Pax8OrderAction = 'new_subscription' | 'change_quantity' | 'cancel';

export interface ProvisioningValue { key: string; values: string[] }
export interface Pax8ProvisionField {
  key: string;
  label: string | null;
  description: string | null;
  valueType: 'Input' | 'Single-Value' | 'Multi-Value' | null;
  possibleValues: string[] | null;
}
export interface Pax8Commitment {
  id: string;
  term: string | null;
  allowForQuantityIncrease: boolean;
  allowForQuantityDecrease: boolean;
  allowForEarlyCancellation: boolean;
  cancellationFeeApplied: boolean;
}
export interface Pax8ProductDependencies { commitments: Pax8Commitment[] }

export interface Pax8ProductOption {
  pax8ProductId: string;
  catalogItemId: string;
  catalogName: string;
  catalogSku: string | null;
  catalogDescription: string | null;
  productName: string | null;
  vendorSkuId: string | null;
  billingFrequency: string | null;
  commitmentTermMonths: number | null;
}

export interface Pax8Order {
  id: string;
  integrationId: string;
  partnerId: string;
  orgId: string;
  pax8CompanyId: string | null;
  status: Pax8OrderStatus;
  source: 'direct' | 'quote';
  sourceQuoteId: string | null;
  pax8OrderId: string | null;
  error: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Pax8OrderLine {
  id: string;
  orderId: string;
  action: Pax8OrderAction;
  submitState: 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'needs_reconcile';
  pax8ProductId: string | null;
  catalogItemId: string | null;
  billingTerm: string | null;
  commitmentTermId: string | null;
  quantity: string | null;
  provisioningDetails: ProvisioningValue[];
  targetSubscriptionId: string | null;
  resultSubscriptionId: string | null;
  contractLineId: string | null;
  sourceQuoteLineId: string | null;
  error: string | null;
  sortOrder: number;
}

export interface Pax8OrderBundle { order: Pax8Order; lines: Pax8OrderLine[] }
export interface AddPax8OrderLineRequest {
  action: Pax8OrderAction;
  pax8ProductId?: string;
  catalogItemId?: string;
  billingTerm?: Pax8BillingTerm;
  commitmentTermId?: string;
  quantity?: string;
  provisioningDetails?: ProvisioningValue[];
  targetSubscriptionId?: string;
  cancelDate?: string;
}
export interface UpdatePax8OrderLineRequest {
  commitmentTermId?: string | null;
  provisioningDetails?: ProvisioningValue[];
}
export interface Pax8Company {
  pax8CompanyId: string;
  pax8CompanyName: string;
  status: string | null;
  mappedOrgId: string | null;
  mappedOrgName: string | null;
  ignored: boolean;
  lastSeenAt: string | null;
  statusActive?: boolean;
  primaryAdminReady?: boolean;
  primaryBillingReady?: boolean;
  primaryTechnicalReady?: boolean;
  orderReady?: boolean;
}
export interface Pax8Subscription {
  id: string;
  pax8SubscriptionId: string;
  productId: string | null;
  productName: string | null;
  status: string | null;
  billingTerm?: string | null;
  breezeQuantity: string | null;
  quantity: string;
  quantityKnown: boolean;
  lastSeenAt: string | null;
  contractLineId?: string | null;
  activeCommitmentId?: string | null;
  activeCommitmentAmbiguous?: boolean;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const json = (body: unknown): RequestInit => ({ headers: JSON_HEADERS, body: JSON.stringify(body) });

export async function readData<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json().catch(() => null) as { data?: T; error?: string } | null;
  if (!response.ok) throw new Error(payload?.error || fallback);
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'data')) throw new Error(fallback);
  return payload.data as T;
}

export const listPax8Companies = () => fetchWithAuth('/pax8/companies');
export const listPax8Products = () => fetchWithAuth('/pax8/products');
export const listPax8Orders = (orgId: string) =>
  fetchWithAuth(`/pax8/orders?orgId=${encodeURIComponent(orgId)}`);
export const getPax8Order = (orderId: string) =>
  fetchWithAuth(`/pax8/orders/${encodeURIComponent(orderId)}`);
export const listPax8Subscriptions = (orgId: string) =>
  fetchWithAuth(`/pax8/subscriptions?orgId=${encodeURIComponent(orgId)}&limit=100`);
export const getProvisionDetails = (productId: string) =>
  fetchWithAuth(`/pax8/products/${encodeURIComponent(productId)}/provision-details`);
export const getProductDependencies = (productId: string) =>
  fetchWithAuth(`/pax8/products/${encodeURIComponent(productId)}/dependencies`);

export const mapPax8Company = (body: { integrationId: string; pax8CompanyId: string; orgId: string }) =>
  fetchWithAuth('/pax8/companies/map', { method: 'POST', ...json(body) });
export const createPax8Order = (orgId: string) =>
  fetchWithAuth('/pax8/orders', { method: 'POST', ...json({ orgId }) });
export const addPax8OrderLine = (orderId: string, body: AddPax8OrderLineRequest) =>
  fetchWithAuth(`/pax8/orders/${encodeURIComponent(orderId)}/lines`, { method: 'POST', ...json(body) });
export const updatePax8OrderLine = (orderId: string, lineId: string, body: UpdatePax8OrderLineRequest) =>
  fetchWithAuth(`/pax8/orders/${encodeURIComponent(orderId)}/lines/${encodeURIComponent(lineId)}`, {
    method: 'PATCH', ...json(body),
  });
export const removePax8OrderLine = (orderId: string, lineId: string) =>
  fetchWithAuth(`/pax8/orders/${encodeURIComponent(orderId)}/lines/${encodeURIComponent(lineId)}`, { method: 'DELETE' });
export const preflightPax8Order = (orderId: string) =>
  fetchWithAuth(`/pax8/orders/${encodeURIComponent(orderId)}/preflight`, { method: 'POST' });
export const submitPax8Order = (orderId: string) =>
  fetchWithAuth(`/pax8/orders/${encodeURIComponent(orderId)}/submit`, { method: 'POST' });
export const reconcilePax8Order = (orderId: string) =>
  fetchWithAuth(`/pax8/orders/${encodeURIComponent(orderId)}/reconcile`, { method: 'POST' });
