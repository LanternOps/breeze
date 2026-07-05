import { useMemo, useState } from 'react';

import type { GroupFinding } from '../../lib/api/vulnerabilities';

const BTN =
  'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
type Priority = (typeof PRIORITIES)[number];

function buildDescription(findings: GroupFinding[]): string {
  const cves = [...new Set(findings.map((f) => f.cveId))].sort();
  const devices = [...new Set(findings.map((f) => f.deviceName))].sort();
  return [
    `CVEs (${cves.length}): ${cves.join(', ')}`,
    `Devices (${devices.length}): ${devices.join(', ')}`,
    '',
    'Created from the Breeze vulnerabilities triage queue.',
  ].join('\n');
}

export function CreateVulnTicketModal({
  findings,
  defaultTitle,
  busy,
  onCancel,
  onSubmit,
}: {
  findings: GroupFinding[];
  defaultTitle: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: { title: string; description: string; priority: Priority }) => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState(() => buildDescription(findings));
  const [priority, setPriority] = useState<Priority>('normal');

  const orgCount = useMemo(() => new Set(findings.map((f) => f.orgId)).size, [findings]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-lg border bg-card p-5 shadow-lg" data-testid="vuln-ticket-modal">
        <h3 className="text-base font-semibold">Create ticket — {findings.length} finding{findings.length === 1 ? '' : 's'}</h3>
        {orgCount > 1 && (
          <p data-testid="vuln-ticket-cross-org-note" className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            Selection spans {orgCount} organizations — one ticket per organization will be created.
          </p>
        )}
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-muted-foreground">Title</span>
            <input
              data-testid="vuln-ticket-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={255}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Description</span>
            <textarea
              data-testid="vuln-ticket-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Priority</span>
            <select
              data-testid="vuln-ticket-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{p[0]!.toUpperCase() + p.slice(1)}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={BTN} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="vuln-ticket-submit"
            className={`${BTN} bg-primary text-primary-foreground hover:bg-primary/90`}
            disabled={busy || title.trim().length === 0}
            onClick={() => onSubmit({ title: title.trim(), description, priority })}
          >
            Create ticket
          </button>
        </div>
      </div>
    </div>
  );
}

export default CreateVulnTicketModal;
