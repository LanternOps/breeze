import { safeFetch } from './urlSafety';

export const DEFAULT_PAX8_API_BASE_URL = 'https://api.pax8.com/v1';
export const DEFAULT_PAX8_TOKEN_URL = 'https://api.pax8.com/v1/token';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGES = 250;

type JsonRecord = Record<string, unknown>;

export interface Pax8CompanyRecord {
  pax8CompanyId: string;
  name: string;
  status: string | null;
  metadata: JsonRecord;
}

export interface Pax8SubscriptionRecord {
  pax8SubscriptionId: string;
  pax8CompanyId: string;
  productId: string | null;
  productName: string | null;
  vendorName: string | null;
  vendorSkuId: string | null;
  status: string | null;
  billingTerm: string | null;
  quantity: string;
  unitPrice: string | null;
  unitCost: string | null;
  currencyCode: string | null;
  startDate: string | null;
  endDate: string | null;
  billingStart: string | null;
  commitmentTermEndDate: string | null;
  raw: JsonRecord;
}

export interface Pax8ProductRecord {
  pax8ProductId: string;
  name: string;
  vendorName: string | null;
  vendorSku: string | null;
  shortDescription: string | null;
  raw: JsonRecord;
}

export interface Pax8ProductPriceRecord {
  commitmentTerm: string | null;
  billingTerm: string | null;
  partnerBuyRate: string | null;        // OUR cost
  suggestedRetailPrice: string | null;  // end-customer list price
  currencyCode: string | null;
  raw: JsonRecord;
}

export interface Pax8ProvisioningDetailInput {
  key: string;
  values: string[];
}

export interface Pax8OrderLineInput {
  lineItemNumber: number;
  productId: string;
  quantity: number;
  billingTerm: string;
  commitmentTermId?: string;
  provisioningDetails?: Pax8ProvisioningDetailInput[];
}

export interface Pax8CreateOrderInput {
  companyId: string;
  lineItems: Pax8OrderLineInput[];
  orderedBy?: 'Pax8 Partner' | 'Customer' | 'Pax8';
  orderedByUserEmail?: string;
}

export interface Pax8OrderResult {
  pax8OrderId: string | null;
  lineItems: Array<{ lineItemNumber: number | null; productId: string | null; subscriptionId: string | null }>;
}

export interface Pax8ProvisionDetail {
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

export interface Pax8ProductDependencies {
  commitments: Pax8Commitment[];
}

export interface Pax8ClientCredentials {
  clientId: string;
  clientSecret: string;
  accessToken?: string | null;
  accessTokenExpiresAt?: Date | null;
}

export interface Pax8ClientOptions {
  apiBaseUrl?: string;
  tokenUrl?: string;
  credentials: Pax8ClientCredentials;
  fetch?: Pax8Fetch;
}

export class Pax8ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'Pax8ApiError';
  }
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function firstString(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstNumber(record: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function nestedRecord(record: JsonRecord, key: string): JsonRecord | null {
  return asRecord(record[key]);
}

function firstNestedString(record: JsonRecord, paths: Array<[string, string[]]>): string | null {
  for (const [key, keys] of paths) {
    const nested = nestedRecord(record, key);
    if (!nested) continue;
    const value = firstString(nested, keys);
    if (value) return value;
  }
  return null;
}

function normalizeMoney(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) return null;
  return numberValue.toFixed(2);
}

function normalizeQuantity(value: unknown): string {
  const normalized = normalizeMoney(value);
  return normalized ?? '0.00';
}

function normalizeIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const dateOnly = value.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(dateOnly) ? dateOnly : null;
}

function extractArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = asRecord(payload);
  if (!root) return [];
  for (const key of ['content', 'data', 'items', 'results']) {
    const value = root[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function extractPageState(payload: unknown): { page: number; totalPages: number | null; hasNext: boolean } {
  const root = asRecord(payload);
  if (!root) return { page: 0, totalPages: null, hasNext: false };
  const page = firstNumber(root, ['page', 'number', 'pageNumber']) ?? 0;
  const totalPages = firstNumber(root, ['totalPages', 'pageCount', 'total_pages']);
  const last = root.last;
  const hasNext = typeof last === 'boolean' ? !last : totalPages !== null ? page + 1 < totalPages : false;
  return { page, totalPages, hasNext };
}

function normalizeCompany(value: unknown): Pax8CompanyRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = firstString(record, ['id', 'companyId', 'company_id']);
  const name = firstString(record, ['name', 'companyName', 'company_name']);
  if (!id || !name) return null;
  return {
    pax8CompanyId: id,
    name,
    status: firstString(record, ['status', 'state']),
    metadata: record,
  };
}

function normalizeSubscription(value: unknown): Pax8SubscriptionRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = firstString(record, ['id', 'subscriptionId', 'subscription_id']);
  const companyId =
    firstString(record, ['companyId', 'company_id', 'customerId', 'customer_id']) ??
    firstNestedString(record, [['company', ['id', 'companyId']], ['customer', ['id', 'companyId']]]);
  if (!id || !companyId) return null;

  const product = nestedRecord(record, 'product');
  const vendor = nestedRecord(record, 'vendor') ?? (product ? nestedRecord(product, 'vendor') : null);
  const pricing = nestedRecord(record, 'pricing') ?? nestedRecord(record, 'price');
  const cost = nestedRecord(record, 'cost');

  return {
    pax8SubscriptionId: id,
    pax8CompanyId: companyId,
    productId: firstString(record, ['productId', 'product_id']) ?? (product ? firstString(product, ['id', 'productId']) : null),
    productName: firstString(record, ['productName', 'product_name']) ?? (product ? firstString(product, ['name', 'productName']) : null),
    vendorName: firstString(record, ['vendorName', 'vendor_name']) ?? (vendor ? firstString(vendor, ['name', 'vendorName']) : null),
    vendorSkuId: firstString(record, ['vendorSkuId', 'vendor_sku_id', 'sku', 'skuId']) ?? (product ? firstString(product, ['vendorSkuId', 'sku', 'skuId']) : null),
    status: firstString(record, ['status', 'state']),
    billingTerm: firstString(record, ['billingTerm', 'billing_term', 'term']),
    quantity: normalizeQuantity(record.quantity ?? record.seats ?? record.licenses ?? record.licenseCount),
    unitPrice: pricing ? normalizeMoney(pricing.unitPrice ?? pricing.price ?? pricing.amount) : normalizeMoney(record.unitPrice),
    unitCost: cost ? normalizeMoney(cost.unitCost ?? cost.cost ?? cost.amount) : normalizeMoney(record.unitCost),
    currencyCode: firstString(record, ['currencyCode', 'currency']) ?? (pricing ? firstString(pricing, ['currencyCode', 'currency']) : null),
    startDate: normalizeIsoDate(record.startDate ?? record.startedAt),
    endDate: normalizeIsoDate(record.endDate ?? record.endedAt),
    billingStart: normalizeIsoDate(record.billingStart ?? record.billingStartDate),
    commitmentTermEndDate: normalizeIsoDate(record.commitmentTermEndDate ?? record.commitmentEndDate),
    raw: record,
  };
}

function normalizeProduct(value: unknown): Pax8ProductRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = firstString(record, ['id', 'productId', 'product_id']);
  const name = firstString(record, ['name', 'productName', 'product_name']);
  if (!id || !name) return null;
  const vendor = nestedRecord(record, 'vendor');
  return {
    pax8ProductId: id,
    name,
    vendorName: firstString(record, ['vendorName', 'vendor_name']) ?? (vendor ? firstString(vendor, ['name', 'vendorName']) : null),
    vendorSku: firstString(record, ['vendorSku', 'vendor_sku', 'vendorSkuId', 'sku', 'skuId']),
    shortDescription: firstString(record, ['shortDescription', 'short_description', 'description']),
    raw: record,
  };
}

function normalizeProductPrice(value: unknown): Pax8ProductPriceRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    commitmentTerm: firstString(record, ['commitmentTerm', 'commitment_term', 'term']),
    billingTerm: firstString(record, ['billingTerm', 'billing_term', 'period', 'billingPeriod']),
    partnerBuyRate: normalizeMoney(record.partnerBuyRate ?? record.buyRate ?? record.cost ?? record.unitCost ?? null),
    suggestedRetailPrice: normalizeMoney(record.suggestedRetailPrice ?? record.msrp ?? record.retailPrice ?? record.listPrice ?? record.price ?? null),
    currencyCode: firstString(record, ['currencyCode', 'currency']),
    raw: record,
  };
}

export class Pax8Client {
  private accessToken: string | null;
  private accessTokenExpiresAt: Date | null;
  private readonly apiBaseUrl: string;
  private readonly tokenUrl: string;
  private readonly doFetch: Pax8Fetch;

  constructor(private readonly opts: Pax8ClientOptions) {
    this.apiBaseUrl = (opts.apiBaseUrl ?? DEFAULT_PAX8_API_BASE_URL).replace(/\/$/, '');
    this.tokenUrl = opts.tokenUrl ?? DEFAULT_PAX8_TOKEN_URL;
    this.accessToken = opts.credentials.accessToken ?? null;
    this.accessTokenExpiresAt = opts.credentials.accessTokenExpiresAt ?? null;
    this.doFetch = opts.fetch ?? ((url, init) => safeFetch(url, init ? { ...init, signal: init.signal ?? undefined } : undefined));
  }

  get cachedAccessToken(): { token: string | null; expiresAt: Date | null } {
    return { token: this.accessToken, expiresAt: this.accessTokenExpiresAt };
  }

  async testConnection(): Promise<{ ok: true; companiesVisible: number }> {
    const companies = await this.listCompanies({ limit: 1 });
    return { ok: true, companiesVisible: companies.length };
  }

  async listCompanies(opts: { limit?: number } = {}): Promise<Pax8CompanyRecord[]> {
    const rows = await this.fetchPaged('/companies', opts.limit);
    return rows.map(normalizeCompany).filter((row): row is Pax8CompanyRecord => row !== null);
  }

  async listSubscriptions(opts: { limit?: number } = {}): Promise<Pax8SubscriptionRecord[]> {
    const rows = await this.fetchPaged('/subscriptions', opts.limit);
    return rows.map(normalizeSubscription).filter((row): row is Pax8SubscriptionRecord => row !== null);
  }

  async listProducts(opts: { limit?: number; vendorName?: string } = {}): Promise<Pax8ProductRecord[]> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (opts.vendorName) query.vendorName = opts.vendorName;
    const rows = await this.fetchPaged('/products', opts.limit, query);
    return rows.map(normalizeProduct).filter((row): row is Pax8ProductRecord => row !== null);
  }

  async getProductPricing(productId: string): Promise<Pax8ProductPriceRecord[]> {
    const payload = await this.requestJson(`/products/${encodeURIComponent(productId)}/pricing`);
    return extractArray(payload).map(normalizeProductPrice).filter((row): row is Pax8ProductPriceRecord => row !== null);
  }

  /**
   * POST /v1/orders. Pax8 has NO idempotency key — calling this twice creates
   * two real, billable orders, and Order.createdDate is a DATE (not a timestamp)
   * so you cannot tell them apart afterward. Callers MUST claim their intent row
   * in a committed transaction before invoking this, and MUST NOT retry on
   * timeout. See pax8OrderSubmit.ts.
   *
   * `isMock: true` validates without touching Pax8's database. It is the ONLY
   * machine-checkable oracle for whether provisioningDetails are complete,
   * because their provision-details endpoint does not expose requiredness.
   */
  async createOrder(input: Pax8CreateOrderInput, opts: { isMock?: boolean } = {}): Promise<Pax8OrderResult> {
    const payload = await this.requestJson(
      '/orders',
      opts.isMock ? { isMock: true } : {},
      { method: 'POST', body: input },
    );
    const record = asRecord(payload);
    const lineItems = extractArray(record?.lineItems).map((raw) => {
      const li = asRecord(raw);
      return {
        lineItemNumber: li ? firstNumber(li, ['lineItemNumber']) : null,
        productId: li ? firstString(li, ['productId', 'product_id']) : null,
        subscriptionId: li ? firstString(li, ['subscriptionId', 'subscription_id']) : null,
      };
    });
    return { pax8OrderId: record ? firstString(record, ['id', 'orderId']) : null, lineItems };
  }

  /**
   * PUT /v1/subscriptions/{id}. Despite the verb this is a PARTIAL update, and
   * `price`, `partnerCost`, `currencyCode`, `startDate`, and `endDate` are all
   * writable. We send `quantity` and nothing else — a read-modify-write would
   * re-send pricing and can overwrite the customer's rate. Do not "helpfully"
   * add fields to this body.
   */
  async updateSubscriptionQuantity(subscriptionId: string, quantity: number): Promise<void> {
    await this.requestJson(
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {},
      { method: 'PUT', body: { quantity } },
    );
  }

  /** DELETE /v1/subscriptions/{id}. No body. Cancel is terminal — Pax8 exposes no reactivate. */
  async cancelSubscription(subscriptionId: string, cancelDate?: string | null): Promise<void> {
    await this.requestJson(
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      cancelDate ? { cancelDate } : {},
      { method: 'DELETE' },
    );
  }

  async getProvisionDetails(productId: string): Promise<Pax8ProvisionDetail[]> {
    const payload = await this.requestJson(`/products/${encodeURIComponent(productId)}/provision-details`);
    return extractArray(payload).map((raw): Pax8ProvisionDetail | null => {
      const r = asRecord(raw);
      const key = r ? firstString(r, ['key']) : null;
      if (!r || !key) return null;
      const valueType = firstString(r, ['valueType']);
      const possible = Array.isArray(r.possibleValues)
        ? r.possibleValues.filter((v): v is string => typeof v === 'string')
        : null;
      return {
        key,
        label: firstString(r, ['label']),
        description: firstString(r, ['description']),
        valueType: (valueType as Pax8ProvisionDetail['valueType']) ?? null,
        possibleValues: possible,
      };
    }).filter((d): d is Pax8ProvisionDetail => d !== null);
  }

  async getProductDependencies(productId: string): Promise<Pax8ProductDependencies> {
    const payload = await this.requestJson(`/products/${encodeURIComponent(productId)}/dependencies`);
    const root = asRecord(payload);
    const commitments = extractArray(root?.commitmentDependencies).map((raw): Pax8Commitment | null => {
      const r = asRecord(raw);
      const id = r ? firstString(r, ['id']) : null;
      if (!r || !id) return null;
      return {
        id,
        term: firstString(r, ['term']),
        allowForQuantityIncrease: r.allowForQuantityIncrease === true,
        allowForQuantityDecrease: r.allowForQuantityDecrease === true,
        allowForEarlyCancellation: r.allowForEarlyCancellation === true,
        cancellationFeeApplied: r.cancellationFeeApplied === true,
      };
    }).filter((c): c is Pax8Commitment => c !== null);
    return { commitments };
  }

  private async fetchPaged(path: string, limit?: number, extraQuery: Record<string, string | number | boolean | undefined> = {}): Promise<unknown[]> {
    const all: unknown[] = [];
    let page = 0;
    while (page < MAX_PAGES) {
      const payload = await this.requestJson(path, { ...extraQuery, page, size: Math.min(limit ?? DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE) });
      const rows = extractArray(payload);
      all.push(...rows);
      if (limit && all.length >= limit) return all.slice(0, limit);
      const state = extractPageState(payload);
      if (!state.hasNext || rows.length === 0) break;
      page = state.page + 1;
    }
    return all;
  }

  private async requestJson(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    init: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {},
  ): Promise<unknown> {
    const token = await this.getAccessToken();
    const url = new URL(`${this.apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    };
    if (init.body !== undefined) headers['content-type'] = 'application/json';

    const res = await this.doFetch(url.toString(), {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    } as RequestInit & { timeoutMs?: number });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Pax8 puts per-line-item validation failures in `details[]`. Keep the raw
      // body — the UI shows it verbatim rather than guessing at what's wrong,
      // because requiredness is NOT discoverable from their spec.
      throw new Pax8ApiError(`Pax8 API returned ${res.status}`, res.status, body.slice(0, 4000));
    }
    if (res.status === 204) return null;
    return res.json();
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessTokenExpiresAt && this.accessTokenExpiresAt.getTime() > Date.now() + 300_000) {
      return this.accessToken;
    }

    const res = await this.doFetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: this.opts.credentials.clientId,
        client_secret: this.opts.credentials.clientSecret,
        audience: 'https://api.pax8.com',
        grant_type: 'client_credentials',
      }),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    } as RequestInit & { timeoutMs?: number });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Pax8ApiError(`Pax8 token request returned ${res.status}`, res.status, body.slice(0, 500));
    }

    const payload = asRecord(await res.json());
    const token = payload ? firstString(payload, ['access_token', 'accessToken', 'token']) : null;
    if (!token) throw new Pax8ApiError('Pax8 token response did not include an access token');
    const expiresIn = payload ? firstNumber(payload, ['expires_in', 'expiresIn']) : null;
    this.accessToken = token;
    this.accessTokenExpiresAt = new Date(Date.now() + Math.max(60, expiresIn ?? 3600) * 1000);
    return token;
  }
}

type Pax8Fetch = (url: string, init?: RequestInit & { timeoutMs?: number }) => Promise<Response>;
