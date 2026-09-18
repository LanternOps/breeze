import { useTranslation } from 'react-i18next';
import type { AiAgentRunWorkspaceDto } from '@breeze/shared';
import { downloadArtifact } from '@/lib/downloadArtifact';

/**
 * What actually ran inside the sandbox (execution-plane spec §5.8).
 *
 * This is the audit trail the whole lane rests on: a technician asked to act on
 * a finding needs to see the code that produced it. Two rules here are
 * load-bearing. A null `exitCode` is rendered as "timed out" or "no exit code",
 * NEVER as blank — blank reads as zero reads as success. And a null artifact
 * handle is rendered as "expired", not as a link to nothing: artifacts have a
 * 30-day TTL and the run row outlives them.
 */
export default function RunWorkspaceSection({
  workspace,
}: {
  workspace: AiAgentRunWorkspaceDto | null | undefined;
}) {
  const { t } = useTranslation('settings');
  // `undefined` as well as `null` — see RunArtifactsSection for why a run DTO
  // can arrive without this field during a rolling deploy.
  if (!workspace) return null;

  return (
    <div data-testid="ai-agent-run-workspace" className="rounded-lg border bg-card p-4">
      <h2 className="text-sm font-semibold">{t('aiAgentsPage.runs.detail.workspace.title')}</h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">{t('aiAgentsPage.runs.detail.workspace.region')}</dt>
          <dd>{workspace.region.toUpperCase()}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('aiAgentsPage.runs.detail.workspace.status')}</dt>
          <dd>{workspace.status}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('aiAgentsPage.runs.detail.workspace.cpu')}</dt>
          <dd>{workspace.cpuMs === null ? '—' : `${(workspace.cpuMs / 1000).toFixed(1)}s`}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('aiAgentsPage.runs.detail.workspace.steps')}</dt>
          <dd>{workspace.stepCount}</dd>
        </div>
      </dl>

      <ol className="mt-4 space-y-2">
        {workspace.steps.map((step) => (
          <li
            key={step.ordinal}
            data-testid={`run-workspace-step-${step.ordinal}`}
            className="rounded border p-2 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium">#{step.ordinal}</span>
              <span className="rounded bg-muted px-1.5 py-0.5">{step.language}</span>
              <span>
                {step.timedOut
                  ? t('aiAgentsPage.runs.detail.workspace.timedOut')
                  : step.exitCode === null
                    ? t('aiAgentsPage.runs.detail.workspace.noExitCode')
                    : `${t('aiAgentsPage.runs.detail.workspace.exitCode')} ${step.exitCode}`}
              </span>
              <span className="text-muted-foreground">{(step.durationMs / 1000).toFixed(1)}s</span>
              {step.scriptArtifactHandle ? (
                <a
                  data-testid={`run-workspace-step-script-${step.ordinal}`}
                  href={`/api/v1/ai/artifacts/${step.scriptArtifactHandle}`}
                  download
                  onClick={downloadArtifact}
                  className="underline"
                >
                  {t('aiAgentsPage.runs.detail.workspace.script')}
                </a>
              ) : (
                <span className="text-muted-foreground">
                  {t('aiAgentsPage.runs.detail.workspace.artifactExpired')}
                </span>
              )}
              {step.stdoutArtifactHandle ? (
                <a
                  data-testid={`run-workspace-step-stdout-${step.ordinal}`}
                  href={`/api/v1/ai/artifacts/${step.stdoutArtifactHandle}`}
                  download
                  onClick={downloadArtifact}
                  className="underline"
                >
                  {t('aiAgentsPage.runs.detail.workspace.stdout')}
                </a>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
