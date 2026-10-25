/**
 * "Onboard a person" launcher for a ticket and an org's contacts page
 * (Operator Recipe Library W07 R2b, Task 18). It only opens
 * `StartRecipeForm`; the form owns every request.
 *
 * Renders nothing unless BOTH hold:
 *  - the server's `features.aiOperatorTasks` flag is on (default closed), and
 *  - this org's Library lists `identity_onboarding` with readiness other than
 *    `unavailable` (what the recipe's own flag being off produces). It IS
 *    shown on `setup_required`: the recipe runs degraded (spec §4.1).
 *
 * From a ticket, the requester is usually the new hire's MANAGER, so the
 * requester's contact pre-fills the manager field — never the new hire's
 * name. No source citation is sent (R1b G3). From the org's contacts page
 * the action is page-level (there is no row for a person who does not exist
 * yet) and every field starts empty.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserPlus } from 'lucide-react';
import '@/lib/i18n';
import { useAiOperatorTasksGate } from '../../stores/featuresStore';
import { useOperatorWorkflows } from '@/lib/api/aiOperatorWorkflows';
import { Dialog } from '../shared/Dialog';
import StartRecipeForm, { type StartRecipeLaunch } from './StartRecipeForm';
import { ONBOARDING_RECIPE_KEY } from './onboardingForm';

export type OnboardPersonLauncherProps =
  | { orgId: string; source: 'org'; className?: string }
  | {
    orgId: string;
    source: 'ticket';
    /** The ticket's requester contact, pre-filled as the MANAGER. Null: no manager is guessed. */
    requesterContactId: string | null;
    /** Display label for the requester, named in the pre-fill note. */
    requesterLabel: string | null;
    className?: string;
  };

export default function OnboardPersonLauncher(props: OnboardPersonLauncherProps) {
  const { orgId, source, className } = props;
  const { t } = useTranslation('aiOperator');
  const gate = useAiOperatorTasksGate();
  const library = useOperatorWorkflows(orgId, gate.loaded && gate.enabled);
  const [open, setOpen] = useState(false);

  if (!gate.loaded || !gate.enabled || library.status !== 'ready') return null;
  const workflow = library.workflows.find((w) => w.recipeKey === ONBOARDING_RECIPE_KEY);
  if (!workflow || workflow.readiness === 'unavailable') return null;

  const launch: StartRecipeLaunch = props.source === 'ticket'
    ? { kind: 'ticket', contactId: props.requesterContactId, personHint: null, label: props.requesterLabel }
    : { kind: 'library' };

  return (
    <>
      <button
        type="button"
        data-testid={`launch-onboard-person-${source}`}
        onClick={() => setOpen(true)}
        className={className ?? 'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs underline hover:bg-muted'}
      >
        <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
        {t('recipeLibrary.start.onboard')}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('startRecipe.onboarding.title')} maxWidth="3xl" alignTop className="p-0">
        {open && (
          <StartRecipeForm workflow={workflow} orgId={orgId} launch={launch} onClose={() => setOpen(false)} />
        )}
      </Dialog>
    </>
  );
}
