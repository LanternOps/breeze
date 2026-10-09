export interface CtrlVPasteDeps {
  dc: RTCDataChannel | null;
  readText: () => Promise<string | null>;
  lastHash: { current: string };
  dispatchPaste: () => void;
  waitForAck: (hash: string, timeoutMs: number) => Promise<void>;
}

// SHA-256 fingerprint of a UTF-8 string, returned as a hex string.
// Must match the agent's fingerprint scheme (sha256 over type + text fields
// for a text-only clipboard payload).
async function textFingerprint(text: string): Promise<string> {
  const encoded = new TextEncoder().encode('text' + text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 'pasted'      — the paste keystroke was dispatched.
 * 'push-failed' — the local clipboard could not be sent, so no keystroke was
 *                 dispatched: the remote would have pasted whatever its
 *                 clipboard held before, and the operator would not know.
 */
export type CtrlVPasteResult = 'pasted' | 'push-failed';

export async function handleCtrlVPaste(deps: CtrlVPasteDeps): Promise<CtrlVPasteResult> {
  const { dc, readText, lastHash, dispatchPaste, waitForAck } = deps;

  if (!dc || dc.readyState !== 'open') {
    dispatchPaste();
    return 'pasted';
  }

  let text: string | null = null;
  try {
    text = await readText();
  } catch (err) {
    console.warn('[clipboard] readText failed, dispatching paste without push:', err);
    dispatchPaste();
    return 'pasted';
  }

  if (!text) {
    dispatchPaste();
    return 'pasted';
  }

  if (text === lastHash.current) {
    dispatchPaste();
    return 'pasted';
  }

  const hash = await textFingerprint(text);
  try {
    // Throws when the channel is closing, or when the payload exceeds the
    // SCTP max message size (large text).
    dc.send(JSON.stringify({ type: 'text', text }));
  } catch (err) {
    console.warn('[clipboard] dc.send failed:', err);
    return 'push-failed';
  }
  // Cached only once sent, so a failed push is retried on the next Ctrl+V.
  lastHash.current = text;

  await waitForAck(hash, 300);

  if (dc.readyState !== 'open') {
    console.warn('[clipboard] DataChannel closed after clipboard push');
  }

  dispatchPaste();
  return 'pasted';
}
