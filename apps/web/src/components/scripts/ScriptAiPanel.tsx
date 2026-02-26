import { useEffect } from 'react';
import { X, Undo2 } from 'lucide-react';
import { useScriptAiStore } from '@/stores/scriptAiStore';
import ScriptAiMessages from './ScriptAiMessages';
import ScriptAiInput from './ScriptAiInput';
import type { ScriptFormBridge } from '@/stores/scriptAiStore';

interface ScriptAiPanelProps {
  bridge: ScriptFormBridge;
}

export default function ScriptAiPanel({ bridge }: ScriptAiPanelProps) {
  const {
    panelOpen,
    closePanel,
    sessionId,
    createSession,
    closeSession,
    interruptResponse,
    setBridge,
    hasApplied,
    revert,
    error,
    clearError,
  } = useScriptAiStore();

  // Register the form bridge
  useEffect(() => {
    setBridge(bridge);
    return () => setBridge(null);
  }, [bridge, setBridge]);

  // Create session when panel opens for the first time
  useEffect(() => {
    if (panelOpen && !sessionId) {
      const formValues = bridge.getFormValues();
      createSession({
        language: formValues.language,
        osTypes: formValues.osTypes,
        editorSnapshot: formValues,
      });
    }
  }, [panelOpen, sessionId, createSession, bridge]);

  // Cleanup session on unmount — interrupt first if streaming
  useEffect(() => {
    return () => {
      const { isStreaming } = useScriptAiStore.getState();
      if (isStreaming) {
        interruptResponse().then(() => closeSession());
      } else {
        closeSession();
      }
    };
  }, [closeSession, interruptResponse]);

  if (!panelOpen) return null;

  return (
    <div className="flex w-96 shrink-0 flex-col border-l bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">AI Script Assistant</span>
        <div className="flex items-center gap-1">
          {hasApplied && (
            <button
              onClick={revert}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
              title="Revert last AI change"
            >
              <Undo2 className="h-3 w-3" />
              Revert
            </button>
          )}
          <button
            onClick={closePanel}
            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="border-b bg-destructive/10 px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs text-destructive">{error}</p>
            <button onClick={clearError} className="text-xs text-destructive hover:underline">
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Messages */}
      <ScriptAiMessages />

      {/* Input */}
      <ScriptAiInput />
    </div>
  );
}
