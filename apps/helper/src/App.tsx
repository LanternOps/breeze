import { useEffect, useState } from 'react';
import { useChatStore } from './stores/chatStore';
import { useWorkspaceStore } from './stores/workspaceStore';
import AppShell from './components/shell/AppShell';

function UsernamePrompt({ osUsername }: { osUsername?: string }) {
  const setUsername = useChatStore((s) => s.setUsername);
  const [name, setName] = useState(osUsername ?? '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed) setUsername(trimmed);
  };

  return (
    <div className="helper-container helper-center">
      <div className="helper-username-prompt">
        <p className="helper-username-title">Welcome to Breeze Helper</p>
        <p className="helper-username-subtitle">What's your name?</p>
        <form onSubmit={handleSubmit} className="helper-username-form">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter your name"
            className="helper-username-input"
            autoFocus
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="helper-btn helper-btn-send"
          >
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const {
    connectionState,
    connectionError,
    agentConfig,
    username,
    initialize,
  } = useChatStore();

  const workspaceAvailable = useWorkspaceStore((s) => s.available);
  const probeWorkspace = useWorkspaceStore((s) => s.probe);

  useEffect(() => {
    initialize();
  }, [initialize]);

  // Probe the workspace files capability once the connection is ready.
  // 404/401 leaves available=false and the Files affordance hidden.
  useEffect(() => {
    if (connectionState === 'connected' && workspaceAvailable === null) {
      probeWorkspace();
    }
  }, [connectionState, workspaceAvailable, probeWorkspace]);

  // Connection states — full-screen gates above the shell.
  if (connectionState === 'connecting') {
    return (
      <div className="helper-container helper-center">
        <span className="helper-spinner" />
        <p>Connecting to Breeze…</p>
      </div>
    );
  }

  if (connectionState === 'waiting-for-token') {
    return (
      <div className="helper-container helper-center">
        <span className="helper-spinner" />
        <p>Connecting to the Breeze agent…</p>
      </div>
    );
  }

  if (connectionState === 'error') {
    return (
      <div className="helper-container helper-center">
        <div className="helper-error-banner">
          <p>{connectionError || 'Failed to connect'}</p>
          <button onClick={initialize} className="helper-btn">
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (connectionState === 'disconnected') {
    return (
      <div className="helper-container helper-center">
        <p>Not connected</p>
        <button onClick={initialize} className="helper-btn">
          Connect
        </button>
      </div>
    );
  }

  // Username prompt (shown once before first use) — full-screen gate.
  if (!username) {
    return <UsernamePrompt osUsername={agentConfig?.os_username} />;
  }

  // Post-auth: the persistent files-first shell owns the header and all
  // navigation (Files / Chat / History / Device Info).
  return <AppShell />;
}
