import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, bootAddin } from '@breeze/office-addin-core';
import { outlookHostAdapter } from './host/outlook';
import { TechPane } from './tech/TechPane';
import { OutlookAuthExtras } from './tech/OutlookAuthExtras';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('taskpane.html is missing #root');
const root = createRoot(rootEl);

/**
 * `bootId` remounts `App` (via `key`) once BindFlow + the post-bind exchange
 * succeed — App's own boot effect re-reads the now-stored tech session and
 * "re-enters the normal flow" as Task 25's brief requires, with zero new App
 * surface beyond `signInExtra` itself.
 */
function Root(): React.ReactElement {
  const [bootId, setBootId] = useState(0);
  return (
    <App
      key={bootId}
      host={outlookHostAdapter}
      clientHost="outlook"
      exchangePath="/office-addin/auth/exchange"
      techPane={TechPane}
      signInExtra={<OutlookAuthExtras onSessionReady={() => setBootId((n) => n + 1)} />}
    />
  );
}

function render(): void {
  root.render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
}

// bootAddin loads runtime config (/config.json) BEFORE the first render — App's
// mount effect kicks off a silent sign-in that needs the API origin + Entra
// client ID. (Ordering is enforced + tested in office-addin-core/src/boot.ts.)
const boot = (): void => {
  // boot() is the one path with no ErrorBoundary above it — surface a
  // render-time throw instead of leaving a silent blank pane on a dropped
  // promise rejection. (loadRuntimeConfig itself never throws.)
  void bootAddin(render).catch((err: unknown) => {
    console.error('[breeze] add-in failed to start', err);
  });
};

// Inside Outlook, wait for the host handshake; in a plain browser tab (dev
// convenience, ADDIN_NO_HTTPS debugging) Office is undefined — boot anyway.
if (typeof Office !== 'undefined' && typeof Office.onReady === 'function') {
  void Office.onReady(() => boot());
} else {
  boot();
}
