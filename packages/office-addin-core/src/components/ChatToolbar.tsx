import type { WriteApproval } from '../api/types';

/**
 * Thin governance toolbar above the thread.
 *  - Auto/Ask toggle (Feature 1): only rendered when the ORG policy is
 *    writeApproval='allow_auto'. When the org is 'ask', the toggle is hidden
 *    entirely and auto-apply is impossible (the server is the real gate; the
 *    controller also refuses setAutoApply(true) under 'ask').
 *  - "Flag this conversation" (Feature 2): hands the session to the MSP admin
 *    review queue. Disabled until a conversation exists; reads "Flagged" once done.
 *
 * Behaviour lives in ChatController (setAutoApply / flagConversation), which is
 * unit-tested; this component is presentational.
 */
export function ChatToolbar({
  writeApproval,
  autoApply,
  flagged,
  canFlag,
  onToggleAuto,
  onFlag,
}: {
  writeApproval: WriteApproval;
  autoApply: boolean;
  flagged: boolean;
  canFlag: boolean;
  onToggleAuto: (value: boolean) => void;
  onFlag: () => void;
}) {
  const showAutoToggle = writeApproval === 'allow_auto';

  // Nothing to show until the conversation starts or auto is available.
  if (!showAutoToggle && !canFlag) return null;

  return (
    <div
      className="flex items-center justify-between gap-2 border-b border-gray-200 px-3 py-1.5 text-xs"
      data-testid="chat-toolbar"
    >
      {showAutoToggle ? (
        <label className="flex items-center gap-2 text-gray-600" data-testid="auto-apply-toggle">
          <input
            type="checkbox"
            checked={autoApply}
            onChange={(e) => onToggleAuto(e.target.checked)}
            className="rounded border-gray-300"
            data-testid="auto-apply-checkbox"
          />
          <span>
            {autoApply ? 'Auto-apply writes' : 'Ask before each write'}
          </span>
        </label>
      ) : (
        <span />
      )}

      {canFlag &&
        (flagged ? (
          <span
            className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-amber-800"
            data-testid="flag-conversation-done"
          >
            Flagged for review
          </span>
        ) : (
          <button
            type="button"
            onClick={onFlag}
            className="inline-flex items-center gap-1 rounded border border-amber-300 px-2 py-0.5 text-amber-700 hover:bg-amber-50"
            data-testid="flag-conversation"
            title="Flag this conversation for your IT provider to review"
          >
            Flag this conversation
          </button>
        ))}
    </div>
  );
}
