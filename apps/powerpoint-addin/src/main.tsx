import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@breeze/office-addin-core';
import { powerpointHostAdapter } from './host/powerpoint';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('taskpane.html is missing #root');
const root = createRoot(rootEl);

function render(): void {
  root.render(
    <React.StrictMode>
      <App host={powerpointHostAdapter} clientHost="powerpoint" />
    </React.StrictMode>,
  );
}

// Inside PowerPoint, wait for the host handshake; in a plain browser tab (dev
// convenience, ADDIN_NO_HTTPS debugging) Office is undefined — render anyway.
if (typeof Office !== 'undefined' && typeof Office.onReady === 'function') {
  void Office.onReady(() => render());
} else {
  render();
}
