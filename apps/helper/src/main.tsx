import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App';
import { ConsentDialog } from './windows/ConsentDialog';
import type { ConsentRequest } from './windows/ConsentDialog';
import { SessionBanner } from './windows/SessionBanner';

// ── Consent window ──────────────────────────────────────────────────────────

function ConsentWindow() {
  const [req, setReq] = useState<ConsentRequest | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<ConsentRequest>('consent-request', (e) => {
      setReq(e.payload);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  const handleDecision = (allow: boolean, reason: 'user' | 'timeout') => {
    if (!req) return;
    if (reason === 'user') {
      invoke('submit_consent', {
        sessionId: req.sessionId,
        decision: allow ? 'allow' : 'deny',
      }).catch(() => {});
    }
    // On timeout: do NOT call submit_consent — the Go agent runs its own
    // authoritative timeout and applies the policy fallback with the correct
    // audit reason. Submitting here would mis-audit as a user decision.
    getCurrentWindow().close().catch(() => {});
  };

  if (!req) return null;
  return <ConsentDialog req={req} onDecision={handleDecision} />;
}

// ── Banner window ────────────────────────────────────────────────────────────

type BannerPayload = { label: string; startedAt: number };

function BannerWindow() {
  const [data, setData] = useState<BannerPayload | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<BannerPayload>('banner-show', (e) => {
      setData(e.payload);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  if (!data) return null;
  return <SessionBanner label={data.label} startedAt={data.startedAt} />;
}

// ── Entry point — branch on window.location.hash ─────────────────────────────

const hash = window.location.hash;

let root: React.ReactNode;
if (hash === '#consent') {
  root = <ConsentWindow />;
} else if (hash === '#banner') {
  // banner-root class on the mount element so transparent-window CSS applies
  document.getElementById('root')!.className = 'banner-root';
  root = <BannerWindow />;
} else {
  root = <App />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {root}
  </React.StrictMode>,
);
