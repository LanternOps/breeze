import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain } from 'lucide-react';
import type { CapturedInstructionDto } from '@breeze/shared';
import { ActionError } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import { useWispInstructionCaptureStore } from '@/stores/wispInstructionCaptureStore';

const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

type Action = 'keep' | 'forget' | 'keepForOrg';

const buttonClass =
  'rounded-full px-2 py-0.5 text-xs font-medium text-foreground/80 hover:bg-muted hover:text-foreground disabled:opacity-50';

/**
 * Wisp self-knowledge: "Remembered: don't reboot PC-01, PC-02 · Keep · Keep for
 * everyone at Acme · Forget" under the reply that carried a standing
 * instruction. A retracted instruction shows nothing.
 */
export default function WispInstructionChip({
  sessionId,
  instruction,
}: {
  sessionId: string;
  instruction: CapturedInstructionDto;
}) {
  const { t } = useTranslation('ai');
  const keep = useWispInstructionCaptureStore((s) => s.keep);
  const forget = useWispInstructionCaptureStore((s) => s.forget);
  const keepForOrg = useWispInstructionCaptureStore((s) => s.keepForOrg);
  const [busy, setBusy] = useState(false);

  if (instruction.status === 'retracted') return null;

  const run = async (action: Action) => {
    const fn = action === 'keep' ? keep : action === 'forget' ? forget : keepForOrg;
    setBusy(true);
    try {
      await fn(sessionId, instruction.instructionId);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('wisp.instruction.actionFailed') });
    } finally {
      setBusy(false);
    }
  };

  const verbLabels = {
    reboot: t('wisp.instruction.verb.reboot'),
    shutdown: t('wisp.instruction.verb.shutdown'),
    run_script: t('wisp.instruction.verb.run_script'),
    patch_install: t('wisp.instruction.verb.patch_install'),
    any_change: t('wisp.instruction.verb.any_change'),
  } as const;

  const enforcedForm = instruction.enforceable && instruction.verb
    ? t('wisp.instruction.enforcedForm', {
        verb: verbLabels[instruction.verb as keyof typeof verbLabels] ?? instruction.verb,
        targets: instruction.targetLabels.join(', '),
        until: instruction.until ? DATE_TIME.format(new Date(instruction.until)) : t('wisp.instruction.noEnd'),
      })
    : null;

  const org = instruction.orgName ?? '';
  const confirmed = instruction.status === 'confirmed' || instruction.keptForOrg;

  return (
    <div
      data-testid="wisp-instruction-chip"
      className="mx-3 mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground"
    >
      <Brain className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{t('wisp.instruction.remembered', { text: instruction.text })}</span>
      {enforcedForm && <span>{enforcedForm}</span>}
      {instruction.unmatched && <span>{t('wisp.instruction.unmatched')}</span>}
      {confirmed ? (
        <span className="font-medium text-foreground/80">
          {instruction.keptForOrg ? t('wisp.instruction.keptForOrg', { org }) : t('wisp.instruction.kept')}
        </span>
      ) : (
        <span className="inline-flex flex-wrap items-center gap-1">
          <button type="button" data-testid="wisp-instruction-chip-keep" disabled={busy} onClick={() => void run('keep')} className={buttonClass}>
            {t('wisp.instruction.keep')}
          </button>
          {instruction.orgId !== null && (
            <button type="button" data-testid="wisp-instruction-chip-keep-org" disabled={busy} onClick={() => void run('keepForOrg')} className={buttonClass}>
              {t('wisp.instruction.keepForOrg', { org })}
            </button>
          )}
          <button type="button" data-testid="wisp-instruction-chip-forget" disabled={busy} onClick={() => void run('forget')} className={buttonClass}>
            {t('wisp.instruction.forget')}
          </button>
        </span>
      )}
    </div>
  );
}
