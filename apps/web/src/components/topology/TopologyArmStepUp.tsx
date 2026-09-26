import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionError, handleActionError } from '../../lib/runAction';
import { mintStepUpGrant } from '../../lib/mfaStepUp';
import { fetchWithAuth } from '../../stores/auth';
import { pickReauthTier, type ReauthTier } from '../settings/StepUpPrompt';

/** Exactly the resource the server digests for a `topology_arm` grant (routes/auth/schemas.ts `topologyArmStepUpResource`). */
export type TopologyArmResource = { siteId: string; action: 'arm_policy' | 'arm_telemetry'; subjectId: string };
type Pending = { resource: TopologyArmResource; submit: (grantId?: string) => Promise<void>; fallback: string };

async function discoverTier(): Promise<ReauthTier> {
  const [user, passkeys] = await Promise.all([fetchWithAuth('/users/me'), fetchWithAuth('/auth/passkeys')]);
  if (!user.ok || !passkeys.ok) throw new Error('factor discovery failed');
  const me = await user.json() as { mfaMethod?: string | null } | null;
  const keys = await passkeys.json() as unknown;
  const list = Array.isArray(keys) ? keys : (keys as { passkeys?: unknown[] } | null)?.passkeys;
  if (!me || !Array.isArray(list)) throw new Error('factor discovery failed');
  return pickReauthTier(list.length, me.mfaMethod ?? null);
}

/**
 * Server-driven `topology_arm` step-up (same contract as MaintenanceModeDialog):
 * the first submit carries no grant, and only a `403 step_up_required` reveals
 * the factor step. The grant is minted for the exact {siteId, action, subjectId}
 * and the arm is re-submitted with it, so a 2FA-off deployment arms on the first
 * click and the server stays the only enforcer. Arming is human-only; there is
 * no AI or MCP path to this prompt.
 */
export function useTopologyArmStepUp(): { arm: (pending: Pending) => Promise<void>; prompt: ReactNode } {
  const { t } = useTranslation('topology');
  const [pending, setPending] = useState<Pending | null>(null);
  const [tier, setTier] = useState<ReauthTier | null>(null);
  const [code, setCode] = useState(''), [error, setError] = useState<string>(), [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const arm = useCallback(async (next: Pending) => {
    try {
      await next.submit();
    } catch (cause) {
      if (cause instanceof ActionError && cause.status === 403 && cause.code === 'step_up_required') {
        try {
          const discovered = await discoverTier();
          if (!live.current) return;
          setTier(discovered); setPending(next); setCode(''); setError(undefined);
        } catch { if (live.current) setError(t('operations.stepUp.unavailable')); }
        return;
      }
      handleActionError(cause, next.fallback);
    }
  }, [t]);

  const confirm = async () => {
    if (!pending || !tier || busy) return;
    setBusy(true); setError(undefined);
    try {
      let grantId: string;
      try {
        grantId = await mintStepUpGrant({ operation: 'topology_arm', resource: pending.resource, reauth: tier === 'passkey' ? { method: 'passkey' } : { method: 'totp', code } });
      } catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : t('operations.stepUp.failed')); return; }
      if (!live.current) return;
      try { await pending.submit(grantId); if (live.current) setPending(null); }
      catch (cause) { handleActionError(cause, pending.fallback); }
    } finally { if (live.current) setBusy(false); }
  };

  const prompt = pending && tier ? <div data-testid="topology-arm-stepup" role="group" aria-labelledby="topology-arm-stepup-heading" className="space-y-2 rounded border border-primary/40 p-3">
    <p id="topology-arm-stepup-heading" className="text-sm font-medium">{t('operations.stepUp.heading')}</p>
    <p className="text-xs text-muted-foreground">{t('operations.stepUp.intro')}</p>
    {tier === 'password' ? <p role="alert" className="text-sm text-destructive">{t('operations.stepUp.noFactor')}</p>
      : tier === 'totp' ? <label className="block text-sm">{t('operations.stepUp.code')}
        <input data-testid="topology-arm-stepup-code" className="mt-1 h-10 w-full rounded border bg-background px-3" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
          value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} disabled={busy} /></label>
      : <p className="text-xs text-muted-foreground">{t('operations.stepUp.passkey')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex gap-2">
      <button data-testid="topology-arm-stepup-confirm" className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
        disabled={busy || tier === 'password' || (tier === 'totp' && code.length !== 6)} onClick={() => void confirm()}>{t('operations.stepUp.confirm')}</button>
      <button data-testid="topology-arm-stepup-cancel" className="rounded border px-3 py-2 text-sm" disabled={busy} onClick={() => setPending(null)}>{t('operations.cancel')}</button>
    </div>
  </div> : error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null;
  return { arm, prompt };
}
