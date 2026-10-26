/**
 * "Offboard a person" launcher for a ticket and a contact (Operator Recipe
 * Library W06 R1b, Task 20).
 *
 * Renders nothing unless BOTH hold:
 *  - the server's `features.aiOperatorTasks` flag is on (default closed), and
 *  - this org's Library lists `identity_offboarding` with readiness other than
 *    `unavailable` — which is what the recipe's own flag being off produces.
 * A launcher that opens a form which cannot submit is worse than none.
 *
 * Launching from a ticket carries the requester into the form (a contact when
 * the ticket has one, else the submitter's email as a hint) and NO source
 * citation: the task opens its own checklist ticket.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserMinus } from 'lucide-react';
import '@/lib/i18n';
import { useAiOperatorTasksGate } from '../../stores/featuresStore';
import { useOperatorWorkflows } from '@/lib/api/aiOperatorWorkflows';
import { Dialog } from '../shared/Dialog';
import StartRecipeForm, { type StartRecipeLaunch } from './StartRecipeForm';

export interface OffboardPersonLauncherProps {
  orgId: string;
  source: 'ticket' | 'contact';
  /** The contact, when one is known (always, from a contact). */
  contactId: string | null;
  /** From a ticket with no requester contact: the submitter's email, resolved by the draft. */
  personHint?: string | null;
  /** Display label for the person. */
  label: string | null;
  className?: string;
  /** Defaults to `offboard-launcher-<source>`; a table passes one per row. */
  testId?: string;
}

export default function OffboardPersonLauncher({ orgId, source, contactId, personHint = null, label, className, testId }: OffboardPersonLauncherProps) {
  const { t } = useTranslation('aiOperator');
  const gate = useAiOperatorTasksGate();
  const library = useOperatorWorkflows(orgId, gate.loaded && gate.enabled);
  const [open, setOpen] = useState(false);

  if (!gate.loaded || !gate.enabled || library.status !== 'ready') return null;
  const workflow = library.workflows.find((w) => w.recipeKey === 'identity_offboarding');
  if (!workflow || workflow.readiness === 'unavailable') return null;
  if (source === 'contact' && !contactId) return null;

  const launch: StartRecipeLaunch = source === 'contact'
    ? { kind: 'contact', contactId: contactId!, label: label ?? '' }
    : { kind: 'ticket', contactId, personHint, label };

  return (
    <>
      <button
        type="button"
        data-testid={testId ?? `offboard-launcher-${source}`}
        onClick={() => setOpen(true)}
        className={className ?? 'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs underline hover:bg-muted'}
      >
        <UserMinus className="h-3.5 w-3.5" aria-hidden="true" />
        {t('recipeLibrary.start.offboard')}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('startRecipe.title')} maxWidth="3xl" alignTop className="p-0">
        {open && (
          <StartRecipeForm workflow={workflow} orgId={orgId} launch={launch} onClose={() => setOpen(false)} />
        )}
      </Dialog>
    </>
  );
}
