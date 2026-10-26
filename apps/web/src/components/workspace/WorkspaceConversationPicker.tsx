import { useTranslation } from 'react-i18next';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { Dialog } from '../shared/Dialog';
import AiConversationList from '../ai/AiConversationList';
import { useAiConversationSource, type ConversationRow } from '../ai/useAiConversationSource';

interface WorkspaceConversationPickerProps {
  open: boolean;
  onClose: () => void;
  /** The page decides what a pick means (open, or move from the side panel). */
  onPick: (row: ConversationRow) => void;
}

const TITLE_ID = 'workspace-conversation-picker-title';

/**
 * #9840 W4 (spec §3.7, D7): "Open a past conversation" — the shared list on
 * the workspace surface, which drops topology investigations and closed
 * sessions (D4). Its source mounts only while the dialog is open (Dialog
 * renders nothing when closed), so the query resets on close.
 */
export default function WorkspaceConversationPicker({ open, onClose, onPick }: WorkspaceConversationPickerProps) {
  const { t } = useTranslation('ai');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('aiConversationMove.openPastConversation')}
      labelledBy={TITLE_ID}
      maxWidth="lg"
      alignTop
      className="flex max-h-[80vh] flex-col overflow-hidden"
    >
      <PickerBody onPick={onPick} />
    </Dialog>
  );
}

function PickerBody({ onPick }: { onPick: (row: ConversationRow) => void }) {
  const { t } = useTranslation('ai');
  const { items, query, setQuery, isLoading, isSearching, error } = useAiConversationSource({ surface: 'workspace' });
  const currentSessionId = useWorkspaceStore(
    (s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.sessionId ?? null,
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace-conversation-picker">
      <h2 id={TITLE_ID} className="border-b px-4 py-3 text-sm font-semibold text-foreground">
        {t('aiConversationMove.openPastConversation')}
      </h2>
      <AiConversationList
        rows={items}
        currentSessionId={currentSessionId}
        onPick={onPick}
        surface="workspace"
        query={query}
        onQueryChange={setQuery}
        isLoading={isLoading}
        isSearching={isSearching}
        error={error}
      />
    </div>
  );
}
