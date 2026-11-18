import { captureException } from '@sentry/astro';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import type { WispEntityKind } from '@breeze/shared';
import { usePermissions } from '@/lib/permissions';
import { WispTalkError } from '@/lib/wispTalkError';
import { useEntitlement } from '@/hooks/useEntitlement';
import { useJwtClaims } from '@/lib/authScope';
import { useWispEnabled } from '@/lib/wispVisibility';
import { activeThreadFor } from '@/lib/wispTalk';
import { ActionError } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import { useAiStore } from '@/stores/aiStore';

const SIZE_CLASSES = {
  md: 'h-9 gap-1.5 px-3 text-sm',
  sm: 'gap-1 px-2 py-1 text-xs',
} as const;

/** Opens a draft about this record. Grant eligibility is only an affordance;
 * pinning and customer focus remain authorized by the server. */
export default function WispTalkButton({ kind, id, orgId, label, size = 'md' }: {
  kind: WispEntityKind;
  id: string;
  orgId: string | null;
  label: string;
  size?: keyof typeof SIZE_CLASSES;
}) {
  const { t } = useTranslation('ai');
  const { can } = usePermissions();
  const canUseAi = can('ai_sessions', 'use');
  const claims = useJwtClaims();
  const partnerToken = claims.status === 'resolved' && claims.claims.scope === 'partner';
  const serverOn = useWispEnabled({ enabled: partnerToken && canUseAi });
  const entitlement = useEntitlement('wisp');
  const wisp = useAiStore((s) => s.wisp);
  const talk = useAiStore((s) => s.talkToWispAbout);
  const plain = useAiStore((s) => s.openPlainChatAbout);
  const request = useAiStore((s) => s.wispTalkFocusRequest);
  const resolveFocus = useAiStore((s) => s.resolveWispTalkFocus);
  const [grant, setGrant] = useState<boolean | null | 'failed'>(null);
  const [busy, setBusy] = useState(false);
  const ownedRequest = useRef<typeof request>(null);
  const mounted = useRef(true);
  const eligible = canUseAi && serverOn && partnerToken && entitlement.state === 'enabled';
  const active = wisp?.status === 'active' && (!wisp.scopeOrgId || wisp.scopeOrgId === orgId);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ownedRequest.current?.resolve(false); };
  }, []);

  useEffect(() => {
    if (!eligible || active) { setGrant(!!active && eligible); return; }
    let live = true;
    setGrant(null);
    void activeThreadFor(orgId).then((thread) => {
      if (live) setGrant(thread !== null);
    }).catch((err: unknown) => {
      captureException(err, { extra: { orgId, kind, id } });
      if (live) setGrant('failed');
    });
    return () => { live = false; };
  }, [eligible, active, orgId, kind, id]);

  const ownsRequest = busy && request?.target.kind === kind && request.target.id === id;
  ownedRequest.current = ownsRequest ? request : null;
  if (!canUseAi || claims.status !== 'resolved' || (eligible && !active && grant === null)) return null;
  const hasGrant = eligible && (active || grant === true);
  const click = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const target = { kind, id, orgId, label };
      if (hasGrant) await talk(target);
      else await plain(target);
    } catch (err) {
      if ((err instanceof ActionError || err instanceof WispTalkError) && err.status === 401) return;
      if (err instanceof ActionError || (err instanceof WispTalkError && err.alreadyToasted)) return;
      showToast({ type: 'error', message: err instanceof WispTalkError && err.code === 'pin_failed'
        ? t('wisp.links.addFailed')
        : t('wisp.talk.openFailed', { message: err instanceof Error ? err.message : '' }) });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div className="relative inline-flex shrink-0">
      <button type="button" data-testid="wisp-talk-button" disabled={busy}
        aria-expanded={ownsRequest ? true : undefined} aria-controls={ownsRequest ? `wisp-talk-focus-${kind}-${id}` : undefined}
        onClick={() => void click()}
        className={`inline-flex items-center whitespace-nowrap rounded-md border font-medium transition hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-default disabled:opacity-70 ${SIZE_CLASSES[size]}`}>
        <Sparkles className={size === 'sm' ? 'h-3.5 w-3.5 text-primary' : 'h-4 w-4 text-primary'} aria-hidden="true" />
        {hasGrant ? t('wisp.talk.button') : t('wisp.talk.buttonPlain')}
      </button>
      {ownsRequest && <div id={`wisp-talk-focus-${kind}-${id}`} role="group" aria-label={t('wisp.talk.switchFocus', { from: request.from, to: request.to })}
        data-testid="wisp-talk-focus-popover" onKeyDown={(event) => { if (event.key === 'Escape') resolveFocus(false); }}
        className="absolute right-0 top-full z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-md border bg-popover p-3 text-sm text-popover-foreground">
        <p>{t('wisp.talk.switchFocus', { from: request.from, to: request.to })}</p>
        <div className="mt-3 flex justify-end gap-2">
          <button autoFocus type="button" data-testid="wisp-talk-focus-no" onClick={() => resolveFocus(false)} className="rounded border px-3 py-1.5 hover:bg-muted">{t('common:labels.no')}</button>
          <button type="button" data-testid="wisp-talk-focus-yes" onClick={() => resolveFocus(true)} className="rounded bg-primary px-3 py-1.5 text-primary-foreground hover:bg-primary/90">{t('common:labels.yes')}</button>
        </div>
      </div>}
    </div>
  );
}
