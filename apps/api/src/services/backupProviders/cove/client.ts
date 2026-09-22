import { safeFetch } from '../../urlSafety';
import { ProviderRequestError, type VendorCustomer, type VendorDevice } from '../types';
import { COVE_STATISTIC_COLUMNS, coveRowToVendorDevice, type CoveStatisticsRow } from './columns';

export const COVE_DEFAULT_BASE_URL = 'https://api.backup.management/jsonapi';
/** Cove's documented page size for EnumerateAccountStatistics. */
export const COVE_PAGE_SIZE = 1000;
/**
 * Hard stop on pagination. 200 pages = 200,000 devices, an order of magnitude
 * past the largest realistic MSP. Without it, a vendor bug that ignores
 * `StartRecordNumber` turns one sync into an unbounded loop holding a worker
 * slot forever.
 */
export const COVE_MAX_PAGES = 200;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_DELAY_MS = 200;
const MAX_TRANSPORT_RETRIES = 3;

export interface CoveCredentials {
  partnerName: string;
  username: string;
  password: string;
}

/** The subset of a fetch response this client needs; keeps the test stub tiny. */
export interface CoveFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type CoveFetchImpl = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    timeoutMs: number;
  },
) => Promise<CoveFetchResponse>;

export interface CoveJsonRpcClientOptions {
  baseUrl: string;
  /**
   * Defaults to `safeFetch`: `base_url` is operator-supplied and therefore
   * tenant-controlled, so the request must go through the SSRF guard (DNS
   * pinned to a validated public IP, redirects never followed) AND through its
   * `assertOutsideHeldDbContext` tripwire, which fails CI if this is ever
   * called inside a held request transaction.
   */
  fetchImpl?: CoveFetchImpl;
  /** Spacing between consecutive calls. 0 in tests. */
  delayMs?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to a real timer. */
  sleepImpl?: (ms: number) => Promise<void>;
  logger?: Pick<Console, 'warn' | 'error'>;
}

interface CoveRpcEnvelope {
  id?: unknown;
  visa?: unknown;
  result?: { result?: unknown } | unknown;
  error?: { code?: number; message?: string } | null;
}

/**
 * Vendor error codes we recognise. Best-effort: the message regexes below are
 * the real discriminators, and the CALL IDENTITY (Login vs not) is what decides
 * `reauth`. Widen these from a real tenant's logs without touching the control
 * flow.
 */
const VISA_EXPIRED_CODES = new Set([-32001]);
const VISA_EXPIRED_MESSAGE = /\bvisa\b|session (?:has )?expired|not authenticated/i;
const PERMISSION_DENIED_CODES = new Set([-32003]);
const PERMISSION_DENIED_MESSAGE = /permission|not authori[sz]ed|access denied|forbidden/i;

const defaultFetchImpl: CoveFetchImpl = (url, init) =>
  safeFetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    timeoutMs: init.timeoutMs,
  });

function unwrapResult(env: CoveRpcEnvelope): unknown {
  const outer = env.result;
  if (outer && typeof outer === 'object' && 'result' in (outer as Record<string, unknown>)) {
    return (outer as { result: unknown }).result;
  }
  return outer;
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/**
 * A JSON-RPC client for Cove Data Protection.
 *
 * Auth is a 15-minute `visa`, not a static key: `Login` mints one, every
 * response carries a fresh one, and the client always sends the newest it has
 * seen. An expired visa mid-sync triggers EXACTLY ONE re-login and one retry of
 * the same call — more would turn a genuinely revoked credential into an
 * unbounded login loop against the vendor.
 *
 * Nothing in this class ever logs the password or a visa.
 */
export class CoveJsonRpcClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: CoveFetchImpl;
  private readonly delayMs: number;
  private readonly timeoutMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly logger: Pick<Console, 'warn' | 'error'>;

  private visa: string | null = null;
  private credentials: CoveCredentials | null = null;
  private calledAtLeastOnce = false;
  /** Codes already reported this run, so one sync logs each unknown code once. */
  private readonly reportedUnknownCodes = new Set<number>();

  constructor(options: CoveJsonRpcClientOptions) {
    this.baseUrl = options.baseUrl || COVE_DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? defaultFetchImpl;
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.logger = options.logger ?? console;
  }

  /** Authenticate and remember the visa + credentials for the one permitted re-login. */
  async login(creds: CoveCredentials): Promise<{ visa: string; partnerId: string; partnerName: string }> {
    this.credentials = creds;
    const payload = await this.rpc('Login', {
      partner: creds.partnerName,
      username: creds.username,
      password: creds.password,
    }, { isLogin: true });

    const record = (payload ?? {}) as Record<string, unknown>;
    const partnerId = asText(record.PartnerId) ?? asText(record.Id);
    if (!this.visa || !partnerId) {
      throw new ProviderRequestError('Cove Login returned no visa or partner id', {
        code: 'malformed_response',
        reauth: false,
      });
    }
    return {
      visa: this.visa,
      partnerId,
      // Cove echoes the console partner name; fall back to what the operator
      // typed so the connection card is never blank.
      partnerName: asText(record.PartnerName) ?? creds.partnerName,
    };
  }

  /**
   * One authenticated RPC, with the visa attached and one re-login retry on an
   * expired visa.
   */
  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.visa) {
      throw new ProviderRequestError(`Cove ${method} attempted before login`, {
        code: 'not_authenticated',
        reauth: false,
      });
    }
    try {
      return (await this.rpc(method, params, { isLogin: false })) as T;
    } catch (error) {
      if (!(error instanceof ProviderRequestError) || error.code !== 'visa_expired') throw error;
      if (!this.credentials) throw error;
      // Exactly one re-login. A rejected re-login surfaces as `login_rejected`
      // (reauth: true) from `rpc`, which is what marks the connection dead.
      await this.rpc('Login', {
        partner: this.credentials.partnerName,
        username: this.credentials.username,
        password: this.credentials.password,
      }, { isLogin: true });
      return (await this.rpc(method, params, { isLogin: false, noVisaRetry: true })) as T;
    }
  }

  /** Every customer under `rootId`, flattened, excluding the root itself. */
  async enumeratePartners(rootId: string): Promise<VendorCustomer[]> {
    // `fields` is deliberately omitted: the API takes numeric field ids we have
    // not verified, and the default record already carries
    // Id/Name/Level/ParentId/ExternalCode.
    const payload = await this.call<unknown>('EnumeratePartners', {
      parentPartnerId: Number(rootId),
      fetchRecursively: true,
    });
    if (!Array.isArray(payload)) {
      throw new ProviderRequestError('Cove EnumeratePartners did not return a list', {
        code: 'malformed_response',
        reauth: false,
      });
    }
    const out: VendorCustomer[] = [];
    for (const raw of payload) {
      if (!raw || typeof raw !== 'object') continue;
      const record = raw as Record<string, unknown>;
      const vendorCustomerId = asText(record.Id);
      if (!vendorCustomerId || vendorCustomerId === String(rootId)) continue;
      out.push({
        vendorCustomerId,
        name: asText(record.Name) ?? vendorCustomerId,
        parentId: asText(record.ParentId),
        level: asText(record.Level),
        externalCode: asText(record.ExternalCode),
      });
    }
    return out;
  }

  /**
   * Every device across every customer under `rootId`.
   *
   * ALL-OR-NOTHING. The sync job deletes rows whose vendor device vanished, so
   * a partial enumeration returned as a success would delete a customer's whole
   * backup inventory. Any page failure propagates as a `ProviderRequestError`
   * and nothing is written.
   */
  async enumerateAccountStatisticsAll(rootId: string): Promise<VendorDevice[]> {
    const devices: VendorDevice[] = [];
    let startRecordNumber = 0;

    for (let page = 0; page < COVE_MAX_PAGES; page++) {
      const payload = await this.call<unknown>('EnumerateAccountStatistics', {
        query: {
          PartnerId: Number(rootId),
          Filter: '',
          Columns: [...COVE_STATISTIC_COLUMNS],
          SelectionMode: 'Merged',
          StartRecordNumber: startRecordNumber,
          RecordsCount: COVE_PAGE_SIZE,
          OrderBy: 'I0 ASC',
        },
      });
      if (!Array.isArray(payload)) {
        throw new ProviderRequestError('Cove EnumerateAccountStatistics did not return a list', {
          code: 'malformed_response',
          reauth: false,
        });
      }

      for (const raw of payload) {
        try {
          const device = coveRowToVendorDevice(raw as CoveStatisticsRow);
          if (device.vendorStatusCode !== null && device.status === 'unknown'
              && !this.reportedUnknownCodes.has(device.vendorStatusCode)) {
            this.reportedUnknownCodes.add(device.vendorStatusCode);
            this.logger.warn(`[cove] unmapped session status code ${device.vendorStatusCode}`);
          }
          devices.push(device);
        } catch (error) {
          // One unusable row must not cost the whole inventory — but it is
          // logged, because a systematic identity problem would otherwise be
          // invisible. NOT counted as a page failure.
          this.logger.warn(
            `[cove] skipping an unusable statistics row: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (payload.length < COVE_PAGE_SIZE) return devices;
      startRecordNumber += COVE_PAGE_SIZE;
    }

    throw new ProviderRequestError(
      `Cove EnumerateAccountStatistics exceeded ${COVE_MAX_PAGES} pages — refusing to page further`,
      { code: 'too_many_pages', reauth: false },
    );
  }

  // -------------------------------------------------------------------------

  private async rpc(
    method: string,
    params: Record<string, unknown>,
    opts: { isLogin: boolean; noVisaRetry?: boolean },
  ): Promise<unknown> {
    let lastTransportError: ProviderRequestError | null = null;

    for (let attempt = 0; attempt <= MAX_TRANSPORT_RETRIES; attempt++) {
      if (this.calledAtLeastOnce && this.delayMs > 0) await this.sleepImpl(this.delayMs);
      this.calledAtLeastOnce = true;

      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'jsonrpc',
        method,
        params: this.visa && !opts.isLogin ? { ...params, visa: this.visa } : params,
      });

      let response: CoveFetchResponse;
      try {
        response = await this.fetchImpl(this.baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
          timeoutMs: this.timeoutMs,
        });
      } catch (error) {
        lastTransportError = new ProviderRequestError(
          `Cove ${method} request failed: ${error instanceof Error ? error.message : String(error)}`,
          { code: 'network', reauth: false, cause: error },
        );
        continue;
      }

      if (!response.ok) {
        // 401/403 is a credential/permission problem: retrying cannot help and
        // would hammer the vendor with a dead credential.
        const reauth = response.status === 401 || response.status === 403;
        const err = new ProviderRequestError(
          `Cove ${method} returned HTTP ${response.status}`,
          { code: `http_${response.status}`, reauth },
        );
        if (reauth || response.status < 500) throw err;
        lastTransportError = err;
        continue;
      }

      const text = await response.text();
      let envelope: CoveRpcEnvelope;
      try {
        envelope = JSON.parse(text) as CoveRpcEnvelope;
      } catch {
        // No body preview in the message: a vendor error page can echo back
        // request material.
        throw new ProviderRequestError(`Cove ${method} returned a non-JSON response`, {
          code: 'malformed_response',
          reauth: false,
        });
      }

      // Every response carries a fresh visa; adopt it even on an error envelope.
      const freshVisa = asText(envelope.visa);
      if (freshVisa) this.visa = freshVisa;

      if (envelope.error) {
        throw this.classifyVendorError(method, envelope.error, opts);
      }
      if (!('result' in envelope) || envelope.result === undefined || envelope.result === null) {
        throw new ProviderRequestError(`Cove ${method} returned neither a result nor an error`, {
          code: 'malformed_response',
          reauth: false,
        });
      }
      return unwrapResult(envelope);
    }

    throw lastTransportError ?? new ProviderRequestError(`Cove ${method} failed`, {
      code: 'network',
      reauth: false,
    });
  }

  /**
   * The one place "the credential is dead" and "the visa aged out" are told
   * apart, and they are NEVER conflated:
   *
   *   - a failing `Login` is ALWAYS `login_rejected` / reauth — the operator
   *     must re-enter the credential;
   *   - a non-Login call whose error looks like a permission problem is
   *     `permission_denied` / reauth — the console user's role was narrowed;
   *   - a non-Login call whose error looks like an aged visa is `visa_expired`
   *     / NOT reauth — `call()` re-logs in once and retries;
   *   - anything else is `vendor_error` / NOT reauth.
   */
  private classifyVendorError(
    method: string,
    error: { code?: number; message?: string },
    opts: { isLogin: boolean; noVisaRetry?: boolean },
  ): ProviderRequestError {
    const message = error.message ?? 'unknown error';
    const code = typeof error.code === 'number' ? error.code : null;

    if (opts.isLogin) {
      return new ProviderRequestError(`Cove login was rejected: ${message}`, {
        code: 'login_rejected',
        reauth: true,
      });
    }
    if ((code !== null && PERMISSION_DENIED_CODES.has(code)) || PERMISSION_DENIED_MESSAGE.test(message)) {
      return new ProviderRequestError(`Cove ${method} was denied: ${message}`, {
        code: 'permission_denied',
        reauth: true,
      });
    }
    if ((code !== null && VISA_EXPIRED_CODES.has(code)) || VISA_EXPIRED_MESSAGE.test(message)) {
      return new ProviderRequestError(`Cove ${method} failed on an expired visa: ${message}`, {
        code: 'visa_expired',
        // Not reauth: `call()` handles this by re-logging in once. Only if that
        // re-login is itself rejected does the connection become reauth.
        reauth: false,
      });
    }
    return new ProviderRequestError(`Cove ${method} failed: ${message}`, {
      code: 'vendor_error',
      reauth: false,
    });
  }
}
