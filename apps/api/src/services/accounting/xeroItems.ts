/**
 * Xero items (Xero W03). Items have no external-id field and no archive, so
 * the item Code (≤30, unique) is the only key (refinement 6):
 *   Code = slug(sku || name)[0..19] + '-' + sha256(catalogItemId)[0..10]
 * The adoption lookup reads the whole price list (one unpaged GET) and matches
 * the `-<hash>` SUFFIX, so it survives renames and SKU edits, and it can never
 * pick up an MSP's own item that merely shares a SKU (that one is offered to the
 * user as an exact_sku suggestion instead). More than one suffix hit is refused.
 * Updates read the item first and post back its own Code (a linked item keeps the
 * code its owner chose) and never touch the purchase side.
 */
import { createHash } from 'node:crypto';
import { AccountingProviderError, isAccountingProviderError, refusalCodeOf } from './accountingProviderError';
import {
  parseXeroDate, requireXeroBody, xeroApiGet, xeroApiWrite, xeroArray, xeroQuery, type XeroCallContext,
} from './xeroHttp';
import type { AccountingEntityMapping, AccountingItemPayload, RemoteItem, RemoteRef } from './types';

export interface XeroItem {
  ItemID?: string; Code?: string; Name?: string; Description?: string;
  IsSold?: boolean; IsPurchased?: boolean; IsTrackedAsInventory?: boolean;
  SalesDetails?: { UnitPrice?: number; AccountCode?: string; TaxType?: string };
  UpdatedDateUTC?: string;
}
interface ItemsBody { Items?: XeroItem[] }

export const XERO_ITEM_UNITDP = 4;
const UNITDP = xeroQuery({ unitdp: XERO_ITEM_UNITDP });
const SUFFIX_LEN = 10;
const PREFIX_MAX = 30 - 1 - SUFFIX_LEN; // 19

function normalized(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export function xeroItemSuffix(catalogItemId: string): string {
  return createHash('sha256').update(catalogItemId).digest('hex').slice(0, SUFFIX_LEN);
}

function slugOf(source: string): string {
  return source.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, PREFIX_MAX).replace(/-+$/, '');
}

export function xeroItemCode(item: Pick<AccountingItemPayload, 'catalogItemId' | 'sku' | 'name'>): string {
  const skuSlug = item.sku?.trim() ? slugOf(item.sku.trim()) : '';
  const prefix = skuSlug || slugOf(item.name) || 'item';
  return `${prefix}-${xeroItemSuffix(item.catalogItemId)}`;
}

/** Truncates by code point (never by UTF-16 unit) so a surrogate pair at the boundary is never split. */
function truncateCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('');
}

export function xeroItemName(name: string): string {
  return truncateCodePoints(name.replace(/\s+/g, ' ').trim(), 50).trim();
}

export function toRemoteItem(item: XeroItem): RemoteItem | null {
  if (!item.ItemID) return null;
  const remoteVersion = parseXeroDate(item.UpdatedDateUTC);
  return {
    id: item.ItemID,
    displayName: item.Name?.trim() || item.Code || item.ItemID,
    ...(item.Code ? { sku: item.Code } : {}),
    ...(item.Description ? { description: item.Description } : {}),
    ...(typeof item.SalesDetails?.UnitPrice === 'number' ? { unitPrice: item.SalesDetails.UnitPrice } : {}),
    active: item.IsSold !== false,
    ...(remoteVersion ? { remoteVersion } : {}),
  };
}

function toRef(item: XeroItem | undefined, operation: string): RemoteRef {
  if (!item?.ItemID) {
    throw new AccountingProviderError({ kind: 'transient', provider: 'xero', operation, message: `${operation} returned no item` });
  }
  const remoteVersion = parseXeroDate(item.UpdatedDateUTC);
  return { id: item.ItemID, ...(remoteVersion ? { remoteVersion } : {}) };
}

function remoteMissing(operation: string, cause?: unknown): AccountingProviderError {
  return new AccountingProviderError({
    kind: 'not_found', provider: 'xero', operation, message: `${operation} found no item`, httpStatus: 404, providerCode: 'remote_missing', cause,
  });
}

function itemFields(item: AccountingItemPayload, tax: { taxCodeRef: string | null; exemptTaxCodeRef: string | null }): XeroItem {
  const unitPrice = Number(item.unitPrice);
  if (!Number.isFinite(unitPrice)) {
    throw new AccountingProviderError({ kind: 'validation', provider: 'xero', operation: 'Xero item payload', message: 'Xero item payload has no numeric unit price' });
  }
  const taxType = item.taxable ? tax.taxCodeRef : tax.exemptTaxCodeRef;
  return {
    Name: xeroItemName(item.name),
    ...(item.description ? { Description: truncateCodePoints(item.description, 4000) } : {}),
    IsSold: true,
    SalesDetails: {
      UnitPrice: unitPrice,
      ...(item.incomeAccountRef ? { AccountCode: item.incomeAccountRef } : {}),
      ...(taxType ? { TaxType: taxType } : {}),
    },
  };
}

async function readAllItems(ctx: XeroCallContext, operation: string): Promise<XeroItem[]> {
  // /Items is not paged: one call returns the whole price list.
  return xeroArray<XeroItem>(requireXeroBody(await xeroApiGet<ItemsBody | null>(ctx, `Items${UNITDP}`, operation), operation).Items);
}

export async function listXeroItems(ctx: XeroCallContext, query?: string): Promise<RemoteItem[]> {
  const items = (await readAllItems(ctx, 'Xero item list')).map(toRemoteItem).filter((i): i is RemoteItem => i !== null);
  const q = normalized(query);
  if (!q) return items;
  return items.filter((i) => [i.displayName, i.sku, i.description].some((v) => normalized(v).includes(q)));
}

async function readItem(ctx: XeroCallContext, itemId: string): Promise<XeroItem | null> {
  const operation = 'Xero item read';
  let body: ItemsBody | null;
  try {
    body = await xeroApiGet<ItemsBody | null>(ctx, `Items/${encodeURIComponent(itemId)}${UNITDP}`, operation);
  } catch (err) {
    if (isAccountingProviderError(err) && err.kind === 'not_found') return null;
    throw err;
  }
  return xeroArray<XeroItem>(requireXeroBody(body, operation).Items)[0] ?? null;
}

export async function getXeroItem(ctx: XeroCallContext, itemId: string): Promise<RemoteItem | null> {
  const item = await readItem(ctx, itemId);
  return item ? toRemoteItem(item) : null;
}

/** Every item whose Code ends in `-<suffix>` (case-insensitive): ours by construction. */
async function findOurItems(ctx: XeroCallContext, suffix: string): Promise<XeroItem[]> {
  const tail = `-${suffix}`.toLowerCase();
  return (await readAllItems(ctx, 'Xero item lookup')).filter((i) => i.ItemID && i.Code?.toLowerCase().endsWith(tail));
}

async function updateItem(ctx: XeroCallContext, existing: XeroItem, fields: XeroItem): Promise<RemoteRef> {
  const operation = 'Xero item update';
  const itemId = existing.ItemID as string;
  let body: ItemsBody | null;
  try {
    body = await xeroApiWrite<ItemsBody | null>(
      ctx, 'POST', `Items/${encodeURIComponent(itemId)}${UNITDP}`, { Items: [{ ItemID: itemId, Code: existing.Code, ...fields }] }, operation,
    );
  } catch (err) {
    if (isAccountingProviderError(err) && err.kind === 'not_found') throw remoteMissing(operation, err);
    throw err;
  }
  return toRef(xeroArray<XeroItem>(requireXeroBody(body, operation).Items)[0], operation);
}

/** An outcome after which our create may have landed (or a peer's did): look before acting again. */
function shouldLookAgain(err: unknown): boolean {
  return (isAccountingProviderError(err) && err.kind === 'transient') || refusalCodeOf(err) === 'duplicate_key';
}

function ambiguous(suffix: string): AccountingProviderError {
  return new AccountingProviderError({
    kind: 'validation', provider: 'xero', operation: 'Xero item adoption',
    message: `Xero has more than one item whose code ends in -${suffix}`, providerCode: 'duplicate_key',
  });
}

export async function upsertXeroItem(
  ctx: XeroCallContext,
  item: AccountingItemPayload,
  mapping: AccountingEntityMapping | null,
  tax: { taxCodeRef: string | null; exemptTaxCodeRef: string | null },
): Promise<RemoteRef> {
  const fields = itemFields(item, tax);
  if (mapping) {
    const existing = await readItem(ctx, mapping.remoteEntityId);
    if (!existing?.ItemID) throw remoteMissing('Xero item update');
    return updateItem(ctx, existing, fields);
  }

  const suffix = xeroItemSuffix(item.catalogItemId);
  const ours = await findOurItems(ctx, suffix);
  if (ours.length > 1) throw ambiguous(suffix);
  if (ours.length === 1) return updateItem(ctx, ours[0]!, fields);

  const operation = 'Xero item create';
  try {
    const body = requireXeroBody(await xeroApiWrite<ItemsBody | null>(
      ctx, 'PUT', `Items${UNITDP}`, { Items: [{ Code: xeroItemCode(item), IsPurchased: false, ...fields }] }, operation,
    ), operation);
    return toRef(xeroArray<XeroItem>(body.Items)[0], operation);
  } catch (err) {
    if (!shouldLookAgain(err)) throw err;
    // A re-look that itself fails leaves the outcome unresolved, so its own
    // error surfaces unchanged (a throttle stays rate_limited with its
    // Retry-After). The next attempt's pre-create look is the safe adoption
    // path (review ruling T3-a). The original error is rethrown only when the
    // look succeeded and found nothing.
    const landed = await findOurItems(ctx, suffix);
    if (landed.length > 1) throw ambiguous(suffix);
    if (landed.length === 1) return updateItem(ctx, landed[0]!, fields);
    throw err;
  }
}
