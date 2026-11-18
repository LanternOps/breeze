import { useEffect, useState } from 'react';
import { useChatStore } from './stores/chatStore';
import { useWorkspaceStore } from './stores/workspaceStore';
import AppShell from './components/shell/AppShell';
import { productName, useT, useUiContext } from './i18n/uiContext';

function UsernamePrompt({ osUsername }: { osUsername?: string }) {
  const setUsername = useChatStore((s) => s.setUsername);
  const t = useT();
  const ctx = useUiContext();
  const { welcomeTitle, welcomeMessage, companyName } = ctx.branding;
  const [name, setName] = useState(osUsername ?? '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed) setUsername(trimmed);
  };

  return (
    <div className="helper-container helper-center">
      <div className="helper-username-prompt">
        <p className="helper-username-title">
          {welcomeTitle ?? t('onboarding.welcome', { name: productName(ctx) })}
        </p>
        {welcomeMessage && <p className="helper-username-subtitle">{welcomeMessage}</p>}
        {companyName && <p className="helper-username-subtitle">{t('onboarding.providedBy', { company: companyName })}</p>}
        <p className="helper-username-subtitle">{t('onboarding.namePrompt')}</p>
        <form onSubmit={handleSubmit} className="helper-username-form">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('onboarding.namePlaceholder')}
            className="helper-username-input"
            autoFocus
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="helper-btn helper-btn-send"
          >
            {t('onboarding.continue')}
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

  const t = useT();
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
        <p>{t('connection.connecting')}</p>
      </div>
    );
  }

  if (connectionState === 'waiting-for-token') {
    return (
      <div className="helper-container helper-center">
        <span className="helper-spinner" />
        <p>{t('connection.waitingForAgent')}</p>
      </div>
    );
  }

  if (connectionState === 'error') {
    return (
      <div className="helper-container helper-center">
        <div className="helper-error-banner">
          <p>{connectionError || t('connection.failed')}</p>
          <button onClick={initialize} className="helper-btn">
            {t('connection.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (connectionState === 'disconnected') {
    return (
      <div className="helper-container helper-center">
        <p>{t('connection.notConnected')}</p>
        <button onClick={initialize} className="helper-btn">
          {t('connection.connect')}
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
