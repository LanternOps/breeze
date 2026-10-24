import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FeatureLock } from '@/components/shared/FeatureLock';
import { useEntitlement } from '@/hooks/useEntitlement';
import { useJwtClaims } from '@/lib/authScope';
import { useWispEnabled } from '@/lib/wispVisibility';
import { useAiStore, type WispState } from '@/stores/aiStore';
import { useOrgStore } from '@/stores/orgStore';
import WispGrantStepUpModal from './WispGrantStepUpModal';

/**
 * "Turn on Wisp" in the chat panel header (W04, spec §5/§10).
 *
 * Hidden entirely while the server has Wisp off (`wispEnabled` on
 * /orgs/partners/me) and for org-scoped tokens (grants are partner-staff
 * only, W02 `requireScope('partner')`) — flag off is no change to the panel.
 * Otherwise the entitlement decides: loading → disabled (never enabled on a
 * failed load, D10), locked → FeatureLock upsell, enabled → step-up modal.
 */
export default function WispToggle({ className }: { className?: string }) {
  const { t } = useTranslation('ai');
  const serverOn = useWispEnabled();
  const claims = useJwtClaims();
  const entitlement = useEntitlement('wisp');
  const selectedOrgId = useOrgStore((s) => s.currentOrgId);
  const enterWispMode = useAiStore((s) => s.enterWispMode);
  const [open, setOpen] = useState(false);

  if (!serverOn) return null;
  if (claims.status !== 'resolved' || claims.claims.scope !== 'partner') return null;

  const button = (
    <button
      type="button"
      data-testid="wisp-toggle"
      disabled={entitlement.state !== 'enabled'}
      onClick={() => setOpen(true)}
      className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 ${className ?? ''}`}
      title={t('wisp.toggle.turnOn')}
    >
      <Sparkles className="h-3.5 w-3.5" />
      {t('wisp.toggle.turnOn')}
    </button>
  );

  if (entitlement.state === 'locked') {
    return (
      <FeatureLock locked why={t('wisp.locked.why')} upgradeHref="/settings/plan" testId="wisp-toggle-locked">
        {button}
      </FeatureLock>
    );
  }

  return (
    <>
      {button}
      <WispGrantStepUpModal
        open={open}
        defaultOrgId={selectedOrgId ?? null}
        onClose={() => setOpen(false)}
        onGranted={async (w: NonNullable<WispState>) => {
          setOpen(false);
          await enterWispMode(w);
        }}
      />
    </>
  );
}
