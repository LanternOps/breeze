/**
 * Xero contacts (Xero W03): wire mapping between Xero Contacts and Breeze's
 * neutral RemoteCustomer, paged listing, single read, and create/update with
 * ADOPTION. Adoption key: ContactNumber = `breeze:<orgId>` (API-only field,
 * ≤50, unique). It is written on create only — Xero's guidance is one number per
 * contact, never overwrite another integration's — so every update omits it.
 * Adoption runs before every create and after every uncertain outcome; a hit is
 * adopted and updated, never re-created. A duplicate NAME is surfaced to the
 * user (structured `duplicate_name`), never retried.
 */
import { AccountingProviderError, isAccountingProviderError, refusalCodeOf } from './accountingProviderError';
import {
  parseXeroDate, requireXeroBody, xeroApiGet, xeroApiWrite, xeroArray, xeroQuery, type XeroCallContext,
} from './xeroHttp';
import type { AccountingCustomerPayload, AccountingEntityMapping, RemoteAddress, RemoteCustomer, RemoteRef } from './types';

export interface XeroAddress {
  AddressType?: string; AddressLine1?: string; AddressLine2?: string; AddressLine3?: string; AddressLine4?: string;
  City?: string; Region?: string; PostalCode?: string; Country?: string;
}
export interface XeroPhone { PhoneType?: string; PhoneNumber?: string; PhoneAreaCode?: string; PhoneCountryCode?: string }
export interface XeroContact {
  ContactID?: string; ContactNumber?: string; ContactStatus?: string; Name?: string; FirstName?: string; LastName?: string;
  EmailAddress?: string; TaxNumber?: string; Addresses?: XeroAddress[]; Phones?: XeroPhone[];
  IsCustomer?: boolean; IsSupplier?: boolean; DefaultCurrency?: string; UpdatedDateUTC?: string;
}
interface ContactsBody { Contacts?: XeroContact[]; pagination?: { page?: number; pageSize?: number; pageCount?: number; itemCount?: number } }

export const XERO_CONTACT_PAGE_SIZE = 1000;
/**
 * Runaway guard only. Xero's 100k figure limits one response or unoptimised
 * query, not a tenant's size, so the loop follows pageCount and THROWS if it
 * ever passes this — it never returns a silently truncated list (refinement 19).
 */
export const XERO_CONTACT_PAGE_GUARD = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validation(operation: string, message: string, providerCode?: string): AccountingProviderError {
  return new AccountingProviderError({ kind: 'validation', provider: 'xero', operation, message, providerCode });
}

/** The value interpolated into a `where` clause, so it must never carry a quote: organisation ids are UUIDs. */
export function contactNumberFor(organizationId: string): string {
  if (!UUID_RE.test(organizationId)) throw validation('Xero contact number', 'Xero contact number needs an organization UUID');
  return `breeze:${organizationId.toLowerCase()}`;
}

/** Xero refuses angle brackets, leading/trailing and repeated whitespace; Name is ≤255. */
export function xeroContactName(displayName: string): string {
  const name = displayName.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 255).trim();
  if (!name) throw validation('Xero contact name', 'Xero contact name is empty after removing characters Xero refuses');
  return name;
}

function currencyOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : undefined;
}

function fromXeroAddress(address: XeroAddress | undefined): RemoteAddress | undefined {
  if (!address) return undefined;
  const line2 = [address.AddressLine2, address.AddressLine3, address.AddressLine4].map((s) => s?.trim()).filter(Boolean).join(', ');
  const out: RemoteAddress = {
    ...(address.AddressLine1?.trim() ? { line1: address.AddressLine1.trim() } : {}),
    ...(line2 ? { line2 } : {}),
    ...(address.City?.trim() ? { city: address.City.trim() } : {}),
    ...(address.Region?.trim() ? { region: address.Region.trim() } : {}),
    ...(address.PostalCode?.trim() ? { postalCode: address.PostalCode.trim() } : {}),
    ...(address.Country?.trim() ? { country: address.Country.trim() } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

function toXeroAddress(type: 'POBOX' | 'STREET', address: RemoteAddress | undefined): XeroAddress | null {
  if (!address) return null;
  const out: XeroAddress = {
    AddressType: type,
    ...(address.line1 ? { AddressLine1: address.line1.slice(0, 500) } : {}),
    ...(address.line2 ? { AddressLine2: address.line2.slice(0, 500) } : {}),
    ...(address.city ? { City: address.city.slice(0, 255) } : {}),
    ...(address.region ? { Region: address.region.slice(0, 255) } : {}),
    ...(address.postalCode ? { PostalCode: address.postalCode.slice(0, 50) } : {}),
    ...(address.country ? { Country: address.country.slice(0, 50) } : {}),
  };
  return Object.keys(out).length > 1 ? out : null;
}

function phoneOf(phones: XeroPhone[] | undefined): string | undefined {
  const list = xeroArray<XeroPhone>(phones);
  const pick = list.find((p) => p.PhoneType === 'DEFAULT' && p.PhoneNumber?.trim())
    ?? list.find((p) => p.PhoneType === 'MOBILE' && p.PhoneNumber?.trim());
  if (!pick) return undefined;
  return [pick.PhoneCountryCode, pick.PhoneAreaCode, pick.PhoneNumber].map((s) => s?.trim()).filter(Boolean).join(' ');
}

function addressOf(contact: XeroContact, type: 'POBOX' | 'STREET'): RemoteAddress | undefined {
  return fromXeroAddress(xeroArray<XeroAddress>(contact.Addresses).find((a) => a.AddressType === type));
}

export function toRemoteCustomer(contact: XeroContact): RemoteCustomer | null {
  if (!contact.ContactID || contact.ContactStatus === 'GDPRREQUEST') return null;
  const person = [contact.FirstName, contact.LastName].map((s) => s?.trim()).filter(Boolean).join(' ');
  const phone = phoneOf(contact.Phones);
  const billAddr = addressOf(contact, 'POBOX');
  const shipAddr = addressOf(contact, 'STREET');
  const remoteVersion = parseXeroDate(contact.UpdatedDateUTC);
  const currencyCode = currencyOf(contact.DefaultCurrency);
  return {
    id: contact.ContactID,
    displayName: contact.Name?.trim() || contact.ContactID,
    ...(contact.EmailAddress ? { email: contact.EmailAddress } : {}),
    ...(contact.Name?.trim() ? { companyName: contact.Name.trim() } : {}),
    ...(person ? { contactName: person } : {}),
    ...(phone ? { phone } : {}),
    ...(billAddr ? { billAddr } : {}),
    ...(shipAddr ? { shipAddr } : {}),
    active: contact.ContactStatus === undefined || contact.ContactStatus === 'ACTIVE',
    ...(remoteVersion ? { remoteVersion } : {}),
    ...(currencyCode ? { currencyCode } : {}),
    ...(contact.IsSupplier === true && contact.IsCustomer !== true ? { supplierOnly: true } : {}),
  };
}

function toRef(contact: XeroContact | undefined, operation: string): RemoteRef {
  if (!contact?.ContactID) {
    throw new AccountingProviderError({ kind: 'transient', provider: 'xero', operation, message: `${operation} returned no contact` });
  }
  const remoteVersion = parseXeroDate(contact.UpdatedDateUTC);
  const currencyCode = currencyOf(contact.DefaultCurrency);
  const billAddr = addressOf(contact, 'POBOX');
  const shipAddr = addressOf(contact, 'STREET');
  return {
    id: contact.ContactID,
    ...(remoteVersion ? { remoteVersion } : {}),
    ...(currencyCode ? { currencyCode } : {}),
    ...(billAddr ? { billAddr } : {}),
    ...(shipAddr ? { shipAddr } : {}),
  };
}

/** Everything we send on create AND update. ContactNumber is added by the create path only (refinement 3). */
function contactFields(customer: AccountingCustomerPayload): XeroContact {
  const addresses = [toXeroAddress('POBOX', customer.billAddr), toXeroAddress('STREET', customer.shipAddr)]
    .filter((a): a is XeroAddress => a !== null);
  return {
    Name: xeroContactName(customer.displayName),
    ...(customer.billingEmail ? { EmailAddress: customer.billingEmail.slice(0, 255) } : {}),
    ...(customer.taxId ? { TaxNumber: customer.taxId.slice(0, 50) } : {}),
    ...(customer.phone ? { Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: customer.phone.slice(0, 50) }] } : {}),
    ...(addresses.length ? { Addresses: addresses } : {}),
  };
}

export async function listXeroContacts(ctx: XeroCallContext, query?: string): Promise<RemoteCustomer[]> {
  const operation = 'Xero contact list';
  const searchTerm = query?.trim() || undefined;
  const out: RemoteCustomer[] = [];
  for (let page = 1; ; page++) {
    if (page > XERO_CONTACT_PAGE_GUARD) {
      throw new AccountingProviderError({ kind: 'transient', provider: 'xero', operation, message: `${operation} pagination did not terminate` });
    }
    // Paged requests return every field (IsCustomer/IsSupplier included); summaryOnly would drop them.
    const body = requireXeroBody(await xeroApiGet<ContactsBody | null>(
      ctx, `Contacts${xeroQuery({ page, pageSize: XERO_CONTACT_PAGE_SIZE, includeArchived: true, searchTerm })}`, operation,
    ), operation);
    const rows = xeroArray<XeroContact>(body.Contacts);
    for (const row of rows) {
      const customer = toRemoteCustomer(row);
      if (customer) out.push(customer);
    }
    const pageCount = body.pagination?.pageCount;
    if (typeof pageCount === 'number' ? page >= pageCount : rows.length < XERO_CONTACT_PAGE_SIZE) break;
  }
  return out;
}

export async function getXeroContact(ctx: XeroCallContext, contactId: string): Promise<RemoteCustomer | null> {
  const operation = 'Xero contact read';
  let body: ContactsBody | null;
  try {
    body = await xeroApiGet<ContactsBody | null>(ctx, `Contacts/${encodeURIComponent(contactId)}`, operation);
  } catch (err) {
    if (isAccountingProviderError(err) && err.kind === 'not_found') return null;
    throw err;
  }
  const row = xeroArray<XeroContact>(requireXeroBody(body, operation).Contacts)[0];
  return row ? toRemoteCustomer(row) : null;
}

export async function findXeroContactByNumber(ctx: XeroCallContext, contactNumber: string): Promise<XeroContact | null> {
  const operation = 'Xero contact lookup';
  const body = requireXeroBody(await xeroApiGet<ContactsBody | null>(
    ctx, `Contacts${xeroQuery({ where: `ContactNumber=="${contactNumber}"`, includeArchived: true })}`, operation,
  ), operation);
  // The where clause is a hint; the exact value is the proof.
  return xeroArray<XeroContact>(body.Contacts).find((c) => c.ContactID && c.ContactNumber === contactNumber) ?? null;
}

async function updateContact(ctx: XeroCallContext, contactId: string, fields: XeroContact): Promise<RemoteRef> {
  const operation = 'Xero contact update';
  let body: ContactsBody | null;
  try {
    body = await xeroApiWrite<ContactsBody | null>(
      ctx, 'POST', `Contacts/${encodeURIComponent(contactId)}`, { Contacts: [{ ContactID: contactId, ...fields }] }, operation,
    );
  } catch (err) {
    // The contact Breeze is linked to is gone: terminal, "unlink and map it again" (refinement 4).
    if (isAccountingProviderError(err) && err.kind === 'not_found') {
      throw new AccountingProviderError({
        kind: 'not_found', provider: 'xero', operation, message: `${operation} found no contact`,
        httpStatus: 404, providerCode: 'remote_missing', cause: err,
      });
    }
    throw err;
  }
  const contact = xeroArray<XeroContact>(requireXeroBody(body, operation).Contacts)[0];
  // An archived / GDPR-erased contact cannot be invoiced: the (harmless) update must not read as success.
  if (contact?.ContactStatus && contact.ContactStatus !== 'ACTIVE') {
    throw validation(operation, `${operation} found an archived contact`, 'remote_archived');
  }
  return toRef(contact, operation);
}

async function adoptContact(ctx: XeroCallContext, contact: XeroContact, fields: XeroContact): Promise<RemoteRef> {
  if (contact.ContactStatus && contact.ContactStatus !== 'ACTIVE') {
    throw validation('Xero contact adoption', 'Xero contact adoption found an archived contact', 'remote_archived');
  }
  return updateContact(ctx, contact.ContactID as string, fields);
}

/**
 * An outcome after which our create may have landed (or a peer's did): look
 * before acting again. duplicate_name is included because our own earlier
 * create owns both the name and the ContactNumber, and Xero may report the name
 * first (refinement 5); a miss still surfaces the duplicate_name.
 */
function shouldLookAgain(err: unknown): boolean {
  if (isAccountingProviderError(err) && err.kind === 'transient') return true;
  const code = refusalCodeOf(err);
  return code === 'duplicate_key' || code === 'duplicate_name';
}

export async function upsertXeroContact(
  ctx: XeroCallContext,
  customer: AccountingCustomerPayload,
  mapping: AccountingEntityMapping | null,
): Promise<RemoteRef> {
  const fields = contactFields(customer);
  if (mapping) return updateContact(ctx, mapping.remoteEntityId, fields);

  const contactNumber = contactNumberFor(customer.organizationId);
  const existing = await findXeroContactByNumber(ctx, contactNumber);
  if (existing) return adoptContact(ctx, existing, fields);

  const operation = 'Xero contact create';
  try {
    const body = requireXeroBody(await xeroApiWrite<ContactsBody | null>(
      ctx, 'PUT', 'Contacts', { Contacts: [{ ...fields, ContactNumber: contactNumber }] }, operation,
    ), operation);
    return toRef(xeroArray<XeroContact>(body.Contacts)[0], operation);
  } catch (err) {
    if (!shouldLookAgain(err)) throw err;
    const landed = await findXeroContactByNumber(ctx, contactNumber).catch(() => null);
    if (!landed) throw err;
    return adoptContact(ctx, landed, fields);
  }
}
