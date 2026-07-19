import { useEffect, useRef, useState } from 'react';
import type { FilingRecord, WorkspaceProject } from '../../stores/workspaceStore';
import { toast } from '../ui/Toaster';
import { formatWhen } from './WorkspacePanel';

export interface FilingCardProps {
  filing: FilingRecord;
  projects: WorkspaceProject[];
  busy: boolean;
  onClassify: (fileIndexId: string) => void;
  onAssign: (fileIndexId: string, projectKey: string) => void;
}

/**
 * One unfiled email as a card in the Filing tab. Draggable onto a
 * ProjectRail entry (sets the `text/x-ws-email-id` payload DnD reads);
 * also files via the inline "Sort"/"File it"/reassign-select controls,
 * same as before the card restyle. Whichever path lands the decision,
 * the card settles (fade/collapse) and a toast confirms it.
 */
export function FilingCard({ filing, projects, busy, onClassify, onAssign }: FilingCardProps) {
  const subject = filing.emailMeta?.subject ?? filing.name;
  const decided = filing.status === 'confirmed' || filing.status === 'reassigned';
  const decidedLabel = filing.decidedProjectKey
    ? projects.find((p) => p.key === filing.decidedProjectKey)?.label ?? filing.decidedProjectKey
    : null;

  const wasDecided = useRef(decided);
  const [settling, setSettling] = useState(false);

  useEffect(() => {
    if (decided && !wasDecided.current) {
      setSettling(true);
      toast(`Filed to ${decidedLabel ?? 'project'}`);
    }
    wasDecided.current = decided;
  }, [decided, decidedLabel]);

  return (
    <div
      className={`ws-filing-card${settling ? ' ws-filing-card-settling' : ''}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/x-ws-email-id', filing.fileIndexId)}
    >
      <span className="ws-filing-card-subject">{subject}</span>
      <span className="ws-filing-card-meta">
        {[filing.emailMeta?.from, formatWhen(filing.emailMeta?.date)].filter(Boolean).join(' · ')}
      </span>

      {decided && (
        <span className="ws-chip ws-chip-success">Filed to: {decidedLabel}</span>
      )}
      {!decided && filing.status === 'suggested' && filing.confidence === 'high' && (
        <span className="ws-chip ws-chip-success">
          Filed to: {filing.suggestedProjectLabel} — {filing.rationale}
        </span>
      )}
      {!decided && filing.status === 'suggested' && filing.confidence !== 'high' && (
        <>
          <span className="ws-chip ws-chip-warning">
            {filing.suggestedProjectLabel
              ? `Possibly ${filing.suggestedProjectLabel} — ${filing.rationale}`
              : 'No clear match — pick a project below.'}
          </span>
          <select
            className="ws-filing-card-select"
            value=""
            onChange={(e) => {
              const key = e.target.value;
              if (key) onAssign(filing.fileIndexId, key);
            }}
            title="File to a different project"
          >
            <option value="">Move to…</option>
            {projects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.key} {p.label}
              </option>
            ))}
          </select>
        </>
      )}

      <div className="ws-filing-card-actions">
        {busy && <span className="helper-spinner" />}
        {!busy && filing.status === null && (
          <button
            className="helper-btn helper-btn-sm"
            onClick={() => onClassify(filing.fileIndexId)}
            title="Suggest where this email belongs"
          >
            Sort
          </button>
        )}
        {!busy && filing.status === 'suggested' && filing.suggestedProjectKey && (
          <button
            className="ws-btn-accent"
            onClick={() => onAssign(filing.fileIndexId, filing.suggestedProjectKey!)}
            title="File to the suggested project"
          >
            File it
          </button>
        )}
      </div>
    </div>
  );
}
