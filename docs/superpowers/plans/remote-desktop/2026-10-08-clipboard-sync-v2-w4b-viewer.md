---
tracking_issue: LanternOps/breeze#8236
---


W4a and W4c plans: `2026-10-08-clipboard-sync-v2.md` (on the W4a/W4c branches).

# W4b — Viewer clipboard v2 (#8260)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. TDD for every task: write
> the test, watch it fail, implement, watch it pass, commit.

**Goal:** the viewer speaks the W4a protocol. Large text and PNG/JPEG images cross in both
directions. The toolbar shows what the agent allows. A paste never lands stale content on an agent
that acks. VNC sessions get text clipboard under the same per-direction policy.

**Base:** the W1 branch (#8244). W1's clipboard code in `DesktopViewer.tsx` (ack map, baseline
counter, `handleCtrlVPaste`) moves into one controller and is replaced, not duplicated.

**Agent contract (from W4a, `agent/internal/remote/clipboard/{chunk,sync}.go`):**
- Frames: `{type:"chunk", id, seq, total, data}`. `data` is base64 of a ≤32 KiB slice of the inner
  message's UTF-8 JSON. Each frame ≤48 KiB. The reassembled message is ≤12 MiB. The timeout is
  30 s of inactivity (reset on every frame). Ids are ≤64 bytes. A `seq:0` frame replaces any
  partial transfer.
- Status (sent on open): `{type:"status", hostToViewer, viewerToHost, chunked:true,
  suppressesBaseline:true, maxTextBytes, maxImageBytes}`.
- Ack, sent after the content has been applied: `{type:"ack", hash, id?}`. `hash` = hex
  sha256(type ‖ text ‖ rtf ‖ image ‖ image_format).
- Content: `{type:"text", text}`, or `{type:"image", image:<b64>, image_format:"png"|"jpeg"}`.

**Contract decision — `hello` is sent only in reply to `status`, not on open.** This departs from
the outline above for the following reason:
- An agent that predates W4a has no `hello` branch. Its `Receive` feeds every non-ack message to
  `applyInbound`, so `hello` arrives as a clipboard write of type `"hello"`.
- On Windows, `SystemClipboard.SetContent` runs `EmptyClipboard()` *before* rejecting the unknown
  type (`clipboard_windows.go:159-187`). A `hello` sent on open would therefore wipe the end user's
  clipboard on every old Windows agent that allows viewer→host.
- Only W4a agents send `status`, and they advertise `chunked:true`. So the viewer answers that status
  with `hello`.
- This costs nothing. W4a's baseline means no host→viewer push goes out before the first poll
  (500 ms). A push that fails unchunked in that window is retried, because the agent does not
  cache a hash for a failed send.

**Paste transaction (with an agent that sent `status`):**
1. viewer→host is disabled by policy → do not push. Dispatch the keystroke, which pastes the remote's
   own clipboard.
2. Read the local clipboard. Text comes first; if there is none, read an image as PNG. If nothing is
   readable, dispatch.
3. The content's fingerprint equals the last synced one **and** host→viewer is on → dispatch without
   pushing. When host→viewer is off, the viewer cannot see the remote's clipboard change, so it
   always pushes.
4. Over the cap (status max, or 2 MiB serialized for a legacy agent) → no keystroke, `too-large`.
5. Send, chunked when the agent is chunk-capable and the payload is over one frame. A throw → no
   keystroke, `send-failed`.
6. Wait for the buffer to drain, then for the ack (3 s). Ack → cache the fingerprint, then dispatch.
   Timeout → `no-ack`, no keystroke. Channel closed → `closed`, no keystroke.
7. Pastes are serialized. A controller closed mid-paste never dispatches, so a paste cannot land in
   a later session.

**Legacy (no status):**
- W1 behaviour: send unchunked, cache on send, wait 300 ms for the ack, then dispatch regardless.
  Any mismatch with W1 is a regression.
- The baseline-skip rule from W1 applies. With `status.suppressesBaseline` it does not.

**VNC policy gate:**
- The RFB stream is raw through the tunnel, so the agent cannot enforce the clipboard policy on VNC.
- The stock viewer must not become a bypass of `clipboardHostToViewer` / `clipboardViewerToHost`.
  It wires VNC clipboard behind a `clipboard: {hostToViewer, viewerToHost}` policy on the tunnel
  info, and treats a missing policy as **off**.
- No API returns that field yet. A follow-up wave adds it to `vnc-exchange`, `downgrade-to-vnc` and
  the tunnel ws-ticket path, using `resolveDesktopSessionPolicy`. Until then the chip reads "Clipboard
  off on VNC (no policy reported)".

### Task 1: Chunk codec — `src/lib/clipboardChunk.ts`
- Test `src/lib/clipboardChunk.test.ts` (ported from `chunk_test.go`):
  - the constants are identical;
  - round-trip of 0 B, 1 B, one piece exactly, piece+1, and 9 MiB, with every frame ≤ 48 KiB;
  - a frame decodes into the Go struct's key set;
  - `seq:0` replaces a partial transfer;
  - an unknown id or an out-of-order frame is rejected;
  - an oversized total or piece is rejected;
  - an id over 64 bytes is rejected;
  - inactivity timeout, and a slow steady transfer is allowed;
  - bad base64 is rejected;
  - the base64 helpers are binary-safe.
- Implement `encodeChunks`, `newTransferId`, `ChunkAssembler`, `bytesToBase64`, `base64ToBytes`.

### Task 2: Baseline input — `src/lib/inputSafety.ts`
- Test: `remoteClipboardDecision({...firstPush, suppressesBaseline:true})` → `apply`. The legacy
  case is unchanged.
- Implement: an optional `suppressesBaseline` field on `RemoteClipboardState`.

### Task 3: Controller — `src/lib/clipboardSync.ts`
- Test `src/lib/clipboardSync.test.ts`, using a fake channel (an EventTarget with `send`,
  `readyState` and `bufferedAmount`) and a fake local IO:
  - status → hello; no status → no hello ever; status without `chunked` → no hello;
  - remote text, image and chunked content are applied under the focus rule. A background item is
    buffered, and `copyRemoteClipboard` writes it. Acks interleaved between chunk frames are
    handled;
  - the baseline is skipped with no status and not skipped with `suppressesBaseline`;
  - the paste transaction: every branch above (policy-off dispatch, dedupe only with host→viewer
    on, too-large, send-failed, no-ack, closed mid-wait, ack → dispatch then cache, serialized
    order);
  - chunked send respects `bufferedAmount` (no frame while over the high-water mark), gives up at
    the deadline, and stops on close;
  - legacy: identical to the W1 `clipboardPaste.test.ts` cases (send before dispatch, dedupe, no
    channel, read error, 300 ms timeout still dispatches);
  - an image push sends `{type:"image", image_format:"png"}` with a fingerprint matching the agent
    scheme;
  - state for the chip: status, last transfer (direction, type, bytes), and whether a remote item
    is available.
- Implement. Delete `src/lib/clipboardPaste.ts` and its test, which the legacy cases replace.

### Task 4: Local clipboard IO — `src/lib/clipboardIO.ts`
- Test (mocks `@tauri-apps/plugin-clipboard-manager` and `@tauri-apps/api/image`):
  - `readImagePng` returns null when there is no image;
  - `writeImage` passes the decoded RGBA to `Image.new` and `writeImage`.
- Implement it with canvas. An injectable `encodePng` / `decodeToRgba` keeps it testable in jsdom.
- `src-tauri/capabilities/default.json` (+ `gen/schemas/capabilities.json`): add
  `clipboard-manager:allow-read-image` and `allow-write-image`. `core:image:default` comes with
  `core:default`. No Rust change, so `cargo check` is run only to regenerate the schema.

### Task 5: Chip view model + component — `src/lib/clipboardChip.ts`, `src/components/ClipboardChip.tsx`
- Test `clipboardChip.test.ts`. One entry per input, with the label, tooltip lines and enabled
  actions it produces:
  - no channel → hidden;
  - legacy → "Text only — agent did not report clipboard status";
  - both on;
  - one direction "Disabled by policy";
  - both off;
  - a recent transfer shows "Copied 2.1 KB from remote" / "Sent 2.1 KB to remote" for 4 s;
  - VNC with a policy, and VNC without one;
  - `formatBytes`.
- Implement it, and render the chip in `ViewerToolbar` next to Paste Text. Its menu has "Copy remote
  clipboard" and "Send clipboard to remote".

### Task 6: VNC clipboard — `src/lib/vncClipboard.ts`, `transports/vnc.ts`
- Test `vncClipboard.test.ts` (fake RFB EventTarget plus a fake container):
  - a `clipboard` event is applied under the focus rule and buffered;
  - host→viewer off → ignored;
  - a capture-phase paste chord stops propagation, then `clipboardPasteFrom(text)` runs strictly
    before `sendKey(keysym, code)`;
  - viewer→host off → the key is sent with no push;
  - pastes are serialized;
  - a copy chord records intent;
  - `detach` removes the listeners.
- Implement it. `connectVnc` takes an optional `clipboard` deps object, and its wrapper exposes the
  handle.

### Task 7: Wire `DesktopViewer.tsx`
- Source guards in `DesktopViewer.inputSafety.test.ts`:
  - the controller is created in `onClipboardChannel` and closed on unmount and on channel
    replacement;
  - the paste chord goes through `pasteTransaction`;
  - the W1 ack map and `handleCtrlVPaste` are gone;
  - the focus-rule guard now points at `clipboardSync.ts`.
- Implement it: notices for each failure reason, the chip props, and the toolbar actions.

### Task 8: Verify
- `cd apps/viewer && npx tsc --noEmit` → exit 0.
- `npx vitest run` → all pass.
- `cd src-tauri && cargo check` → exit 0.

**Lab checks owed (PR):**
- Old agent: text both ways, no clipboard wipe, and the legacy chip.
- 500 KB text and a 2 MB image both ways, on Windows and macOS.
- A policy-disabled direction shows on the chip, and a paste still works inside the remote.
- Pull the network mid-paste: no stale paste.
- VNC, once the API policy field ships.
