import '@fontsource-variable/inter';
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App';
import { ConsentWindow } from './windows/ConsentWindow';
import { CallerVerifyWindow, type Branding, type CallerRequest } from './windows/CallerVerifyWindow';
import { loadCallerBranding } from './windows/callerVerifyBranding';
import { SessionBanner } from './windows/SessionBanner';
import { MessageCardWindow } from './components/MessageCard';
import { EndpointChatWindow } from './components/EndpointChat';
import { initTheme } from './lib/theme';

// Initialize theme before rendering
initTheme();

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

// ── Caller verification window ───────────────────────────────────────────────

type CallerView = { request: CallerRequest; deadlineMs: number };

function CallerVerifyHost({ verificationId }: { verificationId: string }) {
  const [view, setView] = useState<CallerView | null>(null);
  const [branding, setBranding] = useState<Branding>(null);

  useEffect(() => {
    let live = true;
    invoke<CallerView>('get_caller_verify_request', { verificationId })
      .then((v) => { if (live) setView(v); })
      .catch(() => { void getCurrentWindow().close(); });
    // Branding never delays or hides the challenge.
    loadCallerBranding().then((b) => { if (live) setBranding(b); }).catch(() => {});
    return () => { live = false; };
  }, [verificationId]);

  if (!view) return null;
  return (
    <CallerVerifyWindow
      req={view.request}
      deadlineMs={view.deadlineMs}
      branding={branding}
      locale={navigator.language}
      onDecision={(choice) => invoke<void>('submit_caller_verify', { verificationId, choice })}
    />
  );
}

// ── Entry point — branch on window.location.hash ─────────────────────────────

const hash = window.location.hash;

let root: React.ReactNode;
if (hash.startsWith('#caller-verify/')) {
  root = <CallerVerifyHost verificationId={hash.slice('#caller-verify/'.length)} />;
} else if (hash.startsWith('#message/')) {
  // Endpoint message card (#8293): its own small window, never the main one.
  root = <MessageCardWindow messageId={hash.slice('#message/'.length)} />;
} else if (hash.startsWith('#chat/')) {
  // Endpoint live chat (#8743): its own window, not the AI chat and never the main one.
  root = <EndpointChatWindow conversationId={hash.slice('#chat/'.length)} />;
} else if (hash === '#consent') {
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
