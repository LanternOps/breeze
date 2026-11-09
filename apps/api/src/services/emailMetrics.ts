/**
 * Outbound-email Prometheus series, recorded once per `EmailService.deliverRaw`
 * call so Resend rate-limit and quota exhaustion can alert before customer
 * alert emails stop. Leaf: `prom-client` + the shared registry only, like
 * admission/admissionMetrics.ts. Labels are closed sets: never an address,
 * never provider free text.
 */
import { Counter, Gauge } from 'prom-client';
import { metricsRegistry } from './metricsRegistry';

export type EmailMetricsProvider = 'resend' | 'mailgun' | 'smtp';

/** Resend error names kept as their own `error` label value; any other failure is `other`. */
const RESEND_ERROR_LABELS = new Set([
  'rate_limit_exceeded',
  'daily_quota_exceeded',
  'monthly_quota_exceeded',
  'validation_error',
  'invalid_from_address',
]);

function counter<L extends string>(name: string, help: string, labelNames: L[]): Counter<L> {
  return (metricsRegistry.getSingleMetric(name) as Counter<L> | undefined)
    ?? new Counter<L>({ name, help, labelNames, registers: [metricsRegistry] });
}

function gauge<L extends string>(name: string, help: string, labelNames: L[]): Gauge<L> {
  return (metricsRegistry.getSingleMetric(name) as Gauge<L> | undefined)
    ?? new Gauge<L>({ name, help, labelNames, registers: [metricsRegistry] });
}

const sends = counter(
  'breeze_email_send_total',
  'Platform email sends via EmailService.deliverRaw. error is "none" on success; on a Resend failure the Resend error name if it is rate_limit_exceeded, daily_quota_exceeded, monthly_quota_exceeded, validation_error or invalid_from_address, otherwise "other"',
  ['provider', 'result', 'error'],
);
const monthlyUsed = gauge(
  'breeze_email_provider_monthly_used',
  'Emails the provider account has used this month, as last reported by the provider (Resend: x-resend-monthly-quota response header)',
  ['provider'],
);
const monthlyUsedUpdated = gauge(
  'breeze_email_provider_monthly_used_updated_timestamp_seconds',
  'Unix time breeze_email_provider_monthly_used was last set',
  ['provider'],
);

function errorLabel(provider: EmailMetricsProvider, err: unknown): string {
  if (provider !== 'resend' || typeof err !== 'object' || err === null) return 'other';
  const name = (err as { providerErrorName?: unknown }).providerErrorName;
  return typeof name === 'string' && RESEND_ERROR_LABELS.has(name) ? name : 'other';
}

export function recordEmailSendSuccess(provider: EmailMetricsProvider): void {
  sends.labels(provider, 'success', 'none').inc();
}

/** `err` is whatever deliverRaw is about to throw; only an EmailTransportError's `providerErrorName` is read. */
export function recordEmailSendFailure(provider: EmailMetricsProvider, err: unknown): void {
  sends.labels(provider, 'failure', errorLabel(provider, err)).inc();
}

/**
 * Sets the Resend monthly-used gauge from a response's headers (the SDK
 * lower-cases names). A missing or non-integer value is ignored: the gauge
 * keeps its last good reading rather than going NaN.
 */
export function recordResendQuotaHeaders(headers: Record<string, string> | null | undefined): void {
  const raw = headers?.['x-resend-monthly-quota'];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return;
  const used = Number(raw.trim());
  if (!Number.isSafeInteger(used)) return;
  monthlyUsed.labels('resend').set(used);
  monthlyUsedUpdated.labels('resend').setToCurrentTime();
}
