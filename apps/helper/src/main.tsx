import '@fontsource-variable/inter';
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { listen } from '@tauri-apps/api/event';
import App from './App';
import { ConsentWindow } from './windows/ConsentWindow';
import { SessionBanner } from './windows/SessionBanner';
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
