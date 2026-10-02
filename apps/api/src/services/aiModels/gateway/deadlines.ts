/**
 * The gateway's upstream response-header deadline (#7794).
 *
 * The deadline covers DNS, connect and the wait for the status line. A local
 * OpenAI-compatible server (llama.cpp, Ollama, LiteLLM in front of either)
 * sends nothing until the first token, so its whole prompt prefill counts
 * against it, and Breeze's chat prompt is 29k–69k tokens. 30 s aborts that
 * on ordinary self-hosted hardware, so self-host gets a longer default. The
 * operator can set it explicitly, clamped, because the deadline exists for
 * resource protection and must stay a bound. Hosted keeps the strict default.
 * The idle (GATEWAY_IDLE_TIMEOUT_MS) and total (GATEWAY_TOTAL_TIMEOUT_MS)
 * deadlines still bound everything after the headers.
 */
import { isHosted } from '../../../config/env';
import { GATEWAY_CONNECT_TIMEOUT_MS } from './limits';

export const GATEWAY_HEADERS_TIMEOUT_ENV = 'AI_GATEWAY_HEADERS_TIMEOUT_SECONDS';
/** Self-host default: covers a ~70k-token prefill on Apple-silicon / mid-range GPU hardware. */
export const GATEWAY_SELF_HOST_HEADERS_TIMEOUT_MS = 120_000;
export const GATEWAY_HEADERS_TIMEOUT_MIN_MS = 5_000;
/** Below GATEWAY_TOTAL_TIMEOUT_MS (15 min), so a request that never answers still ends with this error. */
export const GATEWAY_HEADERS_TIMEOUT_MAX_MS = 600_000;

let warnedInvalid = false;

/** The headers deadline for the next upstream request, in ms. Read per request, so an env change needs no code path. */
export function gatewayHeadersTimeoutMs(): number {
  const fallback = isHosted() ? GATEWAY_CONNECT_TIMEOUT_MS : GATEWAY_SELF_HOST_HEADERS_TIMEOUT_MS;
  const raw = process.env[GATEWAY_HEADERS_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return fallback;
  const trimmed = raw.trim();
  const seconds = /^\d{1,7}$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    if (!warnedInvalid) {
      warnedInvalid = true;
      console.warn(`[modelGateway] ${GATEWAY_HEADERS_TIMEOUT_ENV} must be a whole number of seconds; using the default ${fallback / 1000} s.`);
    }
    return fallback;
  }
  return Math.min(GATEWAY_HEADERS_TIMEOUT_MAX_MS, Math.max(GATEWAY_HEADERS_TIMEOUT_MIN_MS, seconds * 1000));
}

const seconds = (ms: number): string => `${Number((ms / 1000).toFixed(1))} s`;

/**
 * The client-facing reason a request hit the deadline. It names the deadline,
 * and on self-host the setting that raises it (the operator reads this in the
 * chat panel). Hosted partners cannot change it, so hosted names no setting.
 * Holds no URL, host or credential.
 */
export function headersTimeoutMessage(ms: number): string {
  const base = `The model endpoint did not start responding within ${seconds(ms)} (the gateway's response-header deadline).`;
  return isHosted()
    ? base
    : `${base} A slow local server can be given longer with ${GATEWAY_HEADERS_TIMEOUT_ENV} (up to ${GATEWAY_HEADERS_TIMEOUT_MAX_MS / 1000}).`;
}

export function __resetHeadersDeadlineWarningForTests(): void {
  warnedInvalid = false;
}
