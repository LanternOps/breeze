import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '@/stores/auth';
import { formatNumber } from '@/lib/i18n/format';

/**
 * Transcript retention preview (#4342 W4, spec §3.4): how many AI
 * conversations the window being edited would empty (counted with the job's
 * own predicate: flagged, recently active and already-emptied sessions are
 * not counted), and whether the nightly job empties them yet. All three
 * previews (org card, partner card, client-AI policy editor) answer
 * `{ eligible, capped, enforced }`; `capped` means the count stopped at its
 * bound, shown as "N+". While `enforced` is false the job only reports, and
 * the copy says plainly that nothing is removed yet.
 */
export const TRANSCRIPT_PREVIEW_DEBOUNCE_MS = 400;

export type TranscriptPreview = { eligible: number; capped: boolean; enforced: boolean };

export function parseTranscriptPreview(body: unknown): TranscriptPreview | null {
  if (!body || typeof body !== 'object') return null;
  const { eligible, capped, enforced } = body as Record<string, unknown>;
  if (typeof eligible !== 'number' || typeof capped !== 'boolean' || typeof enforced !== 'boolean') return null;
  return { eligible, capped, enforced };
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; preview: TranscriptPreview }
  /** 403: the caller may edit the policy but not read AI sessions; the count is not theirs to see. */
  | { kind: 'forbidden' }
  | { kind: 'error' };

/** A plain window (1..3650 whole days) or null: nothing to preview (blank, keep forever, invalid). */
export function previewDays(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!/^\d{1,4}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 3650 ? n : null;
}

export default function TranscriptRetentionPreview({
  url,
  scope,
  testId,
}: {
  /** The preview endpoint with `days` already in it; null renders nothing. */
  url: string | null;
  /** `partner` sums across the partner's orgs (those without a tighter window of their own). */
  scope: 'org' | 'partner';
  testId: string;
}) {
  const { t } = useTranslation('ai');
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    if (!url) return;
    setState({ kind: 'loading' });
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetchWithAuth(url, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          console.warn('[TranscriptRetentionPreview] Preview request failed:', res.status, url);
          setState(res.status === 403 ? { kind: 'forbidden' } : { kind: 'error' });
          return;
        }
        const preview = parseTranscriptPreview(await res.json());
        if (controller.signal.aborted) return;
        if (!preview) console.warn('[TranscriptRetentionPreview] Malformed preview body:', res.status, url);
        setState(preview ? { kind: 'ready', preview } : { kind: 'error' });
      } catch (err) {
        if (controller.signal.aborted) return;
        console.warn('[TranscriptRetentionPreview] Preview failed:', err);
        setState({ kind: 'error' });
      }
    }, TRANSCRIPT_PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url]);

  if (!url || state.kind === 'forbidden') return null;

  let text: string;
  let enforced: boolean | undefined;
  if (state.kind === 'loading') {
    text = t('transcriptRetention.preview.counting');
  } else if (state.kind === 'error') {
    text = t('transcriptRetention.preview.unavailable');
  } else {
    const { eligible, capped } = state.preview;
    enforced = state.preview.enforced;
    if (eligible === 0) {
      text = enforced ? t('transcriptRetention.preview.noneEnforced') : t('transcriptRetention.preview.nonePending');
    } else {
      const display = `${formatNumber(eligible)}${capped ? '+' : ''}`;
      if (scope === 'partner') {
        text = enforced
          ? t('transcriptRetention.preview.partnerEnforced', { count: eligible, display })
          : t('transcriptRetention.preview.partnerPending', { count: eligible, display });
      } else {
        text = enforced
          ? t('transcriptRetention.preview.orgEnforced', { count: eligible, display })
          : t('transcriptRetention.preview.orgPending', { count: eligible, display });
      }
    }
  }

  return (
    <p
      className="mt-1 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
      data-testid={testId}
      data-enforced={enforced === undefined ? undefined : String(enforced)}
    >
      {text}
    </p>
  );
}
