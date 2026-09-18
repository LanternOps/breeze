import { useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isTextArtifactContentType, type AiRunArtifactDto } from '@breeze/shared';
import AttachArtifactToTicket from './AttachArtifactToTicket';
import { downloadArtifact } from '@/lib/downloadArtifact';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Files this run captured or produced (execution-plane spec §5.8, §7 step 7).
 *
 * The previews are RAW customer bytes off a device or a log. They are rendered
 * as React text children ONLY — never `dangerouslySetInnerHTML`, never a
 * content-type-driven renderer — because "anything a staged log says is data"
 * (spec §8) has to stay true on the way back out too. Downloads fetch through
 * the authenticated API and save a Blob instead of navigating to raw bytes.
 *
 * Previews are collapsed by default: a run can produce dozens of artifacts and
 * expanding them all by default would put kilobytes of unread log on screen
 * ahead of the finding the technician came for.
 */
export default function RunArtifactsSection({ artifacts }: { artifacts: AiRunArtifactDto[] | undefined }) {
  const { t } = useTranslation('settings');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // `undefined`, not just empty: during a rolling deploy the web can be ahead of
  // the API and the run DTO arrives without this field at all. Reading
  // `.length` off that blanks the ENTIRE run page, which is a far worse
  // outcome than showing no artifact list for a few minutes.
  if (!artifacts || artifacts.length === 0) return null;

  return (
    <div data-testid="ai-agent-run-artifacts" className="rounded-lg border bg-card p-4">
      <h2 className="text-sm font-semibold">{t('aiAgentsPage.runs.detail.artifacts.title')}</h2>
      <ul className="mt-3 space-y-2">
        {artifacts.map((a) => (
          <li key={a.id} data-testid={`run-artifact-row-${a.id}`} className="rounded border p-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{a.name}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{a.kind}</span>
              <span className="text-xs text-muted-foreground">{formatBytes(a.bytes)}</span>
              <span className="text-xs text-muted-foreground">{a.createdByTool}</span>
              <a
                data-testid={`run-artifact-download-${a.id}`}
                href={a.downloadPath}
                download={a.name}
                onClick={downloadArtifact}
                className="ml-auto inline-flex items-center gap-1 text-xs underline"
              >
                <Download className="h-3 w-3" />
                {t('aiAgentsPage.runs.detail.artifacts.download')}
              </a>
              {isTextArtifactContentType(a.contentType) && (a.headPreview || a.tailPreview) && (
                <button
                  type="button"
                  data-testid={`run-artifact-preview-toggle-${a.id}`}
                  onClick={() => setExpanded((e) => ({ ...e, [a.id]: !e[a.id] }))}
                  className="text-xs underline"
                >
                  {t('aiAgentsPage.runs.detail.artifacts.preview')}
                </button>
              )}
              <AttachArtifactToTicket artifactId={a.id} artifactName={a.name} />
            </div>
            {isTextArtifactContentType(a.contentType) && expanded[a.id] && (
              <pre
                data-testid={`run-artifact-preview-${a.id}`}
                className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs"
              >
                {a.headPreview}
                {a.tailPreview ? `\n…\n${a.tailPreview}` : ''}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
