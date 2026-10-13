import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert } from 'lucide-react';
import { z } from 'zod';
import type { VerificationDetails } from '@/lib/api/callerVerification';
import { useCallerVerificationEnabled } from '@/lib/useCallerVerificationEnabled';
import { VerifyCallerModal } from './VerifyCallerModal';
import { useNow } from './useNow';

/** Refusal reasons with dedicated copy (CallerVerificationRefusal in the API's errors.ts). */
const KNOWN_REASONS = new Set([
  'no_fresh_verification', 'grant_consumed', 'subject_unmatched', 'subject_ambiguous', 'subject_mailboxes_unknown',
  'tenant_mismatch', 'contact_fenced', 'requester_not_authorized', 'technician_mismatch', 'target_rebound',
  'stepup_invalidated', 'administrative_disabled', 'feature_disabled',
]);

/**
 * The `requiresCallerVerification` payload (CallerVerificationRequiredError).
 * Non-strict: additive fields such as `latest` are ignored. The org and
 * action are required — a refusal without them never falls back to the
 * ambient org switcher.
 */
const payloadSchema = z.object({
  orgId: z.string().uuid(),
  contactId: z.string().uuid().nullable(),
  action: z.enum(['reset_password', 'disable_user']),
  requiredTier: z.number().int().min(0).max(3),
  reason: z.string().min(1).max(64),
});
export type CallerVerificationRefusalPayload = z.infer<typeof payloadSchema>;

/** Reads a tool/route error body (object or JSON string); null when it is not a refusal. */
export function parseRefusal(output: unknown): CallerVerificationRefusalPayload | null {
  let value = output;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || !('requiresCallerVerification' in value)) return null;
  const parsed = payloadSchema.safeParse((value as { requiresCallerVerification: unknown }).requiresCallerVerification);
  return parsed.success ? parsed.data : null;
}

/**
 * Inline workflow under an AI tool error that was refused for caller
 * verification. Offers to start a verification only; it never retries the
 * tool or confers approval from tool output.
 */
export function CallerVerificationRefusal({ output, isError }: { output: unknown; isError?: boolean }) {
  const enabled = useCallerVerificationEnabled();
  const refusal = enabled && isError ? parseRefusal(output) : null;
  return refusal ? <RefusalCard refusal={refusal} /> : null;
}

function RefusalCard({ refusal }: { refusal: CallerVerificationRefusalPayload }) {
  const { t } = useTranslation('callerVerificationTech');
  const [open, setOpen] = useState(false);
  const [latest, setLatest] = useState<VerificationDetails | null>(null);
  const now = useNow();
  const reason = KNOWN_REASONS.has(refusal.reason) ? refusal.reason : 'unknown';
  const verified = !!latest && latest.status === 'verified' && !latest.consumedAt && !!latest.usableUntil && Date.parse(latest.usableUntil) > now;
  return (
    <aside data-testid="cv-refusal" className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <ShieldAlert className="h-4 w-4 text-warning" aria-hidden="true" />
        {t('refusal.title')}
      </p>
      <p>{t(/* i18n-dynamic */ `refusal.reasons.${reason}`)}</p>
      <p className="text-xs text-muted-foreground">{t('refusal.tier', { tier: refusal.requiredTier })}</p>
      {verified && <p role="status" className="text-success">{t('refusal.verifiedRetry')}</p>}
      <button type="button" data-testid="cv-refusal-verify" onClick={() => setOpen(true)}
        className="h-8 rounded-md bg-primary px-3 text-xs text-primary-foreground">{t('refusal.verify')}</button>
      {open && (
        <VerifyCallerModal orgId={refusal.orgId} initialContactId={refusal.contactId ?? undefined} initialAction={refusal.action}
          onClose={() => setOpen(false)} onChanged={setLatest} />
      )}
    </aside>
  );
}
