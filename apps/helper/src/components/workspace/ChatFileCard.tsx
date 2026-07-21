import { useState } from 'react';
import { getTauriInvoke } from '../../lib/helperFetch';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useChatStore } from '../../stores/chatStore';

/**
 * A `search_workspace_files` tool-result row: the fields ChatFileCard and
 * ChatView's citation chips need to display and open a file. Matches the
 * shape `executeWorkspaceChatTool('search_workspace_files', ...)` returns
 * (see lib/workspaceChatTools.ts) — `project`/`docType` may be absent from a
 * `get_file_passages` row, which is fine: ChatFileCard never renders those.
 */
export interface WorkspaceFileSummary {
  fileIndexId: string;
  relPath: string;
  project?: string | null;
  docType?: string | null;
  openPath: string | null;
}

function fileBaseName(relPath: string): string {
  const parts = relPath.split('/');
  return parts[parts.length - 1] || relPath;
}

/**
 * Opens a workspace file exactly the way WorkspacePanel's row "Open" action
 * does (WorkspacePanel.tsx `handleOpen`): record the activity, invoke the
 * Tauri `open_workspace_path` command, and fall back to copying the path to
 * the clipboard when opening fails (no Tauri bridge, e.g. dev-browser mode).
 * Shared by ChatFileCard's Open button and ChatView's citation chips so both
 * paths behave identically. Returns whether the file was actually opened.
 */
export async function openWorkspaceFile(
  fileIndexId: string,
  openPath: string | null,
  username: string | null,
): Promise<boolean> {
  if (!openPath) return false;
  await useWorkspaceStore.getState().recordActivity(fileIndexId, 'open', username);
  try {
    const invoke = await getTauriInvoke();
    if (!invoke) {
      throw new Error('Opening files requires the desktop app');
    }
    await invoke('open_workspace_path', { input: { path: openPath } });
    return true;
  } catch {
    navigator.clipboard.writeText(openPath).catch(() => {});
    return false;
  }
}

/**
 * Result cards for a `search_workspace_files` tool result, rendered inline in
 * chat (ChatView). Styled on the same `--ws-*` tokens and typography scale as
 * FileTable's rows (13px name / 12px secondary meta) so a card reads as the
 * same "file row" language wherever it appears — including the 340px side
 * panel, so the layout stays fluid with no fixed widths.
 */
export default function ChatFileCard({ files }: { files: WorkspaceFileSummary[] }) {
  const username = useChatStore((s) => s.username);
  const [errorId, setErrorId] = useState<string | null>(null);

  if (files.length === 0) return null;

  const handleOpen = async (file: WorkspaceFileSummary) => {
    setErrorId((cur) => (cur === file.fileIndexId ? null : cur));
    const opened = await openWorkspaceFile(file.fileIndexId, file.openPath, username);
    if (!opened) setErrorId(file.fileIndexId);
  };

  return (
    <div className="helper-file-card-list" data-testid="chat-file-card-list">
      {files.map((file) => {
        const meta = [file.project, file.docType].filter(Boolean).join(' — ');
        return (
          <div
            key={file.fileIndexId}
            className="helper-file-card-row bg-ws-surface rounded-surface shadow-[var(--ws-shadow-1)]"
          >

            <div className="helper-file-card-info">
              <span className="helper-file-card-name" title={file.relPath}>
                {fileBaseName(file.relPath)}
              </span>
              {meta && <span className="helper-file-card-meta">{meta}</span>}
              {errorId === file.fileIndexId && (
                <span className="helper-file-card-error">Couldn't open — path copied instead</span>
              )}
            </div>
            <button
              type="button"
              className="helper-file-card-open"
              onClick={() => handleOpen(file)}
              disabled={!file.openPath}
            >
              Open
            </button>
          </div>
        );
      })}
    </div>
  );
}
