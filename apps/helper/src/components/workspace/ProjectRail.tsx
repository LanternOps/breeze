import { useState } from 'react';
import type { WorkspaceProject } from '../../stores/workspaceStore';

export interface ProjectRailProps {
  projects: WorkspaceProject[];
  /** Called when a FilingCard's drag payload is dropped on a project entry. */
  onDropEmail: (emailId: string, projectKey: string) => void;
}

/** Drop targets for drag-to-file: one entry per project from the crosswalk. */
export function ProjectRail({ projects, onDropEmail }: ProjectRailProps) {
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  return (
    <div className="ws-project-rail">
      {projects.map((p) => (
        <div
          key={p.key}
          className={`ws-project-rail-item${dragOverKey === p.key ? ' ws-drop-target' : ''}`}
          title={p.label}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverKey(p.key);
          }}
          onDragLeave={() => setDragOverKey((cur) => (cur === p.key ? null : cur))}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverKey(null);
            const emailId = e.dataTransfer.getData('text/x-ws-email-id');
            if (emailId) onDropEmail(emailId, p.key);
          }}
        >
          {p.label}
        </div>
      ))}
      {projects.length === 0 && (
        <span className="ws-project-rail-empty">No projects yet</span>
      )}
    </div>
  );
}
