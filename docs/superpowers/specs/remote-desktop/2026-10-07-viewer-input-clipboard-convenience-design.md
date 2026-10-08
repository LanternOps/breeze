# Remote Viewer: Input Correctness, Clipboard Sync v2, Convenience Features

**Date:** 2026-10-07
**Status:** Draft (design). W1 is implemented (#8237). W2 onward is approved; W2a is in progress (#8238).
**Tracking:** LanternOps/breeze#8236
**Related issues:** #966 (block local input), #1012 (clipboard audit to `audit_logs`), #3084 (in-session chat), #3595 (Caps Lock sync), #3920 (keyboard layout selector), #4089 (type_text), #5484 (UAC prompt hidden)

## Problem

The Tauri viewer (`apps/viewer`) and the Go agent (`agent/internal/remote/desktop`) have a working
input and clipboard path, but it has several ways to glitch. The worst ones leave keys or mouse
buttons stuck down on the customer's machine. Others make shortcuts misfire, drop keystrokes with
no warning, or move clipboard data across sessions in ways the technician did not intend.

Evidence labels: **[V]** verified by reading the code at the cited line, **[I]** inferred from
code and needs a lab check, **[N]** not checked.

### Gotcha inventory

`DV` = `apps/viewer/src/components/DesktopViewer.tsx`, `TB` = `ViewerToolbar.tsx`,
`IW` = `agent/internal/remote/desktop/input_windows.go`.

| # | Gotcha | Effect for the user | Where | Sev |
|---|---|---|---|---|
| K1 | No key release on window blur, `visibilitychange`, or canvas blur. `releaseAllKeys` runs only on connect, reconnect, session switch, disconnect, and unmount. | Alt-Tab / Cmd-Tab away while holding a modifier leaves it held on the remote. The remote then "types with Ctrl held" until the key is tapped again. | DV:1565, DV:1254 [V] | High |
| K2 | The `input` DataChannel is `ordered:true, maxRetransmits:0`. Every `key_up` / `mouse_up` rides it. | Any dropped packet that carries a release leaves a key or button latched. More likely on Wi-Fi and LTE. | `lib/webrtc.ts:205` [V] | High |
| K3 | The agent tracks no held keys or buttons and releases nothing on channel close, peer disconnect, session end, monitor switch, or desktop switch (UAC/lock). The 20 s ICE grace period keeps keys held. | Viewer crash or network drop mid-chord leaves Shift/Ctrl/a mouse button stuck on the customer's PC after the session ends. | `session.go:585`, `session_webrtc.go:466` [V via audit] | High |
| K4 | `releaseAllKeys` sends over a channel that may be closed (`sendInputFn` drops silently when not `open`) and then clears local state. | The release never arrives; nothing re-sends it on the new channel. | DV:1550-1573 [V] | High |
| K5 | Modifier double-send. A held Shift is sent as `key_down shift`; Shift+A is then sent as `key_press a [shift]`. The Windows agent presses **and releases** Shift around the chord. | After the first chord the remote Shift is up while the physical key is still down. Shift+click multi-select fails after typing a capital letter. | DV:1848, `IW:337-358` [V] | Med |
| K6 | Cmd↔Ctrl remap defaults to **on** for every viewer/remote pair (`useState(true)`). On a Windows viewer → Windows remote, pressing Ctrl alone sends `key_down meta`, which the Windows agent maps to `VK_LWIN`. | Holding Ctrl holds the Windows key; releasing it can open the Start menu. Ctrl+click becomes Win+click. | DV:222, `IW:767` [V]; Start-menu effect [I] | High |
| K7 | Autorepeat dropped for plain keys (`if (e.repeat) return`). SendInput / CGEvent injected key-downs do not autorepeat on the remote. | Holding Backspace, an arrow, or Space produces one keystroke. | DV:1855 [V]; no remote repeat [I] | Med |
| K8 | Viewer-reserved shortcuts collide with common app shortcuts: Ctrl/Cmd+Shift+V (paste-as-plain-text in Chrome, Slack, Office) and Ctrl/Cmd+Shift+F (Find in Files in VS Code, many IDEs). | Those shortcuts can never reach the remote. | DV:1775, DV:1784 [V] | Med |
| K9 | OS-intercepted combos (Alt-Tab, Win, Cmd-Tab, Cmd-Space) never reach the webview. No Keyboard Lock API, no Tauri-level hook. On macOS the default app menu owns Cmd+Q/W/H/M. | Cmd+Q on a Mac viewer quits the viewer instead of the remote app. Workaround is the toolbar Send Keys menu. | grep [V]; macOS menu [I] | Med |
| K10 | No IME / composition / dead-key support: `preventDefault` on every keydown blocks composition. | CJK input and dead-key accents (´ + e) cannot be typed. Paste Text is the only route. | DV:1735 [V] | Low-Med |
| K11 | Left/right modifiers collapse (`ShiftLeft`/`ShiftRight` → `shift`); no right Ctrl / right Alt, no Numpad Enter (→ `return`), no F13–F24, ContextMenu, ISO `<>` key (`VK_OEM_102`), media keys. | Those keys are silently dropped or sent as the wrong key. Releasing one Shift while holding the other releases the remote Shift. | `lib/keymap.ts`, `IW:619-780` [V via audit] | Low |
| K12 | NumLock has no state sync (Caps Lock does, macOS agent only; Windows ignores `capsLock`). | Remote numpad can be inverted relative to the viewer; Windows Caps state can drift. | `input_capslock.go` [V via audit] | Low |
| M1 | Mouse buttons 3/4 (back/forward) map to `left`. | A thumb-button press clicks on the remote. | DV:1644, DV:1661 [V] | High |
| M2 | No pointer capture and no window-level `mouseup`. A drag released outside the video element never sends `mouse_up`. | Remote button stays down; the next move drags. | DV mouse handlers [V via audit] | High |
| M3 | Horizontal wheel (`deltaX`) dropped; protocol has no axis. | Shift-less horizontal scrolling (trackpads, tilt wheels) does nothing. | DV:1602 [V] | Low |
| M4 | WebRTC input path skips the WS path's normalizer: no coordinate bounds, no scroll-delta clamp. | Malformed or hostile viewer input reaches `SendInput` unclamped. | `session_control.go:114` vs `handlers_desktop.go:975` [V via audit] | Med |
| M5 | `HandleEvent` runs on whatever goroutine pion uses for `OnMessage`; `ensureInputDesktop` calls `LockOSThread` from that goroutine. | Desktop-thread pinning for secure-desktop input is not reliable; the macOS handler has unguarded fields. | `IW:545`, `input_darwin.go:431` [I] | Med |
| U1 | Input sent while the channel is reconnecting is silently dropped; no UI cue. No focus indicator (`outline-hidden`). | Keystrokes "go nowhere" with no explanation. | DV:1553, DV:2141 [V] | Med |

### Clipboard: current state

Clipboard sync **exists**, text only on the viewer side, WebRTC only:

- **Agent** (`agent/internal/remote/clipboard/sync.go`): creates a `clipboard` DataChannel when policy
  allows either direction. Polls the host clipboard every 500 ms and pushes changes
  (`{type,text,rtf,image,image_format}`); applies inbound writes and acks `{type:"ack",hash}`.
  Direction gates come from `RemoteAccessSettings.clipboardHostToViewer` / `clipboardViewerToHost`
  (config-policy `remote_access` inline settings), enforced agent-side.
- **Viewer**: writes any `text` push straight to the local clipboard (DV:596-635). Ignores RTF and
  images. Pushes the local clipboard to the remote **only** when the user presses Ctrl/Cmd+V in the
  viewer, waits up to 300 ms for the ack, then sends the V keystroke (`lib/clipboardPaste.ts`).
- **Audit**: `slog` lines only (agent diagnostic stream). `TODO(#1012)` to reach `audit_logs`.

| # | Clipboard gap | Effect | Ref | Sev |
|---|---|---|---|---|
| C1 | Background sessions write the local clipboard. Every open viewer window applies every remote clipboard change, focused or not. | Tech has sessions to customers A and B open. A's end user copies something; it lands on the tech's clipboard; the tech pastes into B. **Customer A's data reaches customer B's machine.** Also clobbers the tech's own clipboard unexpectedly. | DV:610 [V] | High |
| C2 | Message size, per direction. **Agent→viewer:** pion's outbound limit is the viewer's advertised `a=max-message-size` (65,535 bytes if unset), while the agent allows 2 MiB messages and does not chunk, so large text and real images fail to send. **Viewer→agent:** pion advertises a ~1 GiB inbound ceiling, so the limit is whatever the WebView enforces. Whenever `dc.send` throws, `handleCtrlVPaste` still dispatched the paste, so the remote pasted **stale** content with no warning. | `pion/webrtc@v4.2.22 sctptransport.go:144`, `constants.go:26`; `clipboardPaste.ts:47` [V by Codex]; practical sizes [I — lab-verify] | High |
| C3 | Local→remote happens only on the Ctrl/Cmd+V keystroke. | Right-click → Paste, Edit → Paste, Shift+Insert, and terminal paste bindings paste stale content. | DV:1798 [V] | Med |
| C4 | No visibility: the viewer cannot tell "disabled by policy" from "old agent" from "one direction off". No indicator, no transfer feedback. | "Clipboard is broken" reports with no way to self-diagnose. | `transports/types.ts:35` [V] | Med |
| C5 | Images/RTF dropped by the viewer (Tauri capability grants only `allow-read-text`/`allow-write-text`). | Copying a screenshot on the remote to paste into a ticket does nothing. | `src-tauri/capabilities/default.json` [V] | Med |
| C6 | VNC transport advertises `clipboardChannel: true`, but `transports/vnc.ts` wires no clipboard. | Clipboard silently absent on VNC. | `transports/types.ts:35` [V via audit] | Low |
| C7 | `type_text` runs synchronously inside the control channel's `OnMessage`. | A large paste blocks `send_sas`, `switch_monitor`, etc. until it finishes. | `session_control.go:224` [V via audit] | Low |
| C8 | No central audit (`#1012`). | MSPs cannot answer "what was copied off this machine during the session" — not even counts. | `sync.go:176` [V via audit] | Med |
| C10 | The agent's first poll after the channel opens pushes whatever the remote clipboard already holds (`lastSentHash` starts empty). | Connecting to a machine overwrites the technician's clipboard with the end user's clipboard (possibly a password), without anyone copying anything. | `sync.go:118-129` [V] | Med |
| C9 | Config UI defaults both toggles to on (`RemoteAccessTab.tsx:39`) while the baseline default for host→viewer is `!isHosted` (`policyBaselineDefaults.ts:45`). | Two answers for one default. | [V via audit] | Low |

## Design principles

1. **The agent is authoritative for held state.** The viewer releases what it knows about, but only
   the agent can guarantee nothing is left down when a viewer vanishes.
2. **State-changing input never rides a lossy channel.** Pointer motion may be lossy; presses,
   releases, and scroll may not.
3. **New protocol is opt-in by capability.** Extend the existing `input_capabilities` reply. An old
   agent never answers, and the viewer treats silence as "legacy" and keeps today's behaviour. An
   old viewer ignores unknown reply keys.
4. **Clipboard follows focus.** Only the focused session window exchanges clipboard data with the
   local machine.
5. **Never log content.** Audit records counts, formats, and byte sizes only.

## Design

### 1. Input transport v2 (agent + viewer)

- The viewer creates a second channel, `input-r`, `ordered:true` and **reliable**, alongside the
  existing lossy `input` channel. It always creates it; an old agent's `OnDataChannel` switch has no
  case for the label and ignores it (`session_webrtc.go:466`, no default branch) [V].
- Once the agent advertises `reliableInput: true`, the viewer sends `key_*`, `mouse_down/up`,
  `mouse_scroll`, and `input_reset` on `input-r`. `mouse_move` stays on `input`.
- Every input event carries a per-session monotonically increasing `seq`, and every `mouse_move`
  also carries `after`: the `seq` of the last discrete event the viewer sent. The agent coalesces a
  move (keeps only the latest) until the discrete event it depends on has been injected, and drops
  moves older than the last injected discrete event. Dropping only stale moves is not enough: a
  *newer* move can overtake a retransmitting `mouse_down` and execute before it, so the press then
  lands at an older position. `mouse_down/up` carry their own `x,y`.
- Key and button events share `input-r`, so Shift-down → mouse-down ordering is preserved.
- A single reliable channel for everything is the simpler fallback if this proves fiddly. It costs
  pointer latency under loss, not correctness.
- **Rejected alternative:** make the single `input` channel reliable. Under loss, head-of-line
  blocking delays every subsequent pointer move by a retransmit RTT, which is what `maxRetransmits:0`
  was added to avoid.

### 2. Agent held-state tracker (agent)

A wrapper around `InputHandler` (one per session, all platforms):

- Records keys held via `key_down` and mouse buttons held via `mouse_down`.
- `ReleaseAll(reason)` injects `key_up` / `mouse_up` for everything held, then clears. Called on:
  input or control channel close, peer-connection `disconnected` (immediately — not after the 20 s
  grace), session cleanup, before a monitor switch, before an input-desktop switch, and on an
  explicit `input_reset` message from the viewer.
- **Reset epoch.** Every `ReleaseAll` bumps an epoch and drains the input queue. Events from before
  the reset (retransmitted or queued downs) are discarded, so they cannot re-latch a key just
  released. Input stays gated until the viewer sends `input_reset{epoch}` after reconciling its own
  held state. Further triggers: transport replacement, input revocation, and view-only activation.
  Releasing on `disconnected` deliberately ends an in-progress drag; that is better than a latched
  button.
- **Geometry epoch.** A monitor switch bumps a geometry epoch that the viewer echoes on input.
  Coordinates from the old monitor are dropped rather than applied with the new offset.
- `key_press` with a modifier that is already tracked as held does not press or release that
  modifier (fixes K5 for old viewers too).
- Idle accounting counts activity on `input-r` (today it only counts `input`,
  `session_control.go:103`). Otherwise keyboard-only sessions can idle out.
- A single per-session **input worker goroutine** consumes a bounded queue. It owns
  `LockOSThread` / `SetThreadDesktop` on Windows, removing the goroutine-affinity problem (M5).
  It must own **all** injection: WebRTC and WS input, `type_text` chunks, releases, display offsets,
  and the release that precedes a desktop switch. `ensureInputDesktop` currently stores thread
  affinity per handler, although affinity belongs to the calling thread. When the queue is full it
  coalesces `mouse_move` only, never discrete events. Reset and shutdown jump the queue.
- The WS path's `normalizeDesktopInputEvent` moves into the `desktop` package and runs on the WebRTC
  path too (M4): type allowlist, coordinate bound, scroll-delta clamp, key length, modifier count.

### 3. Key and pointer coverage (agent + viewer)

- Events gain an optional `code` field (DOM `KeyboardEvent.code`). With `keyCodes: true` advertised,
  the Windows agent injects from `code` using scancodes (`KEYEVENTF_SCANCODE` plus
  `KEYEVENTF_EXTENDEDKEY` where required). This adds right Ctrl/Alt, Numpad Enter, F13–F24,
  ContextMenu, `IntlBackslash` (`VK_OEM_102`), and media keys, and keeps left/right modifiers
  distinct (K11). The `key` field remains for agents without `keyCodes` and for the macOS/Linux maps.
- Repeat: key-downs with `repeat: true` are forwarded for non-modifier keys. The agent re-injects them
  on Windows and macOS. On Linux it ignores them, because the X server autorepeats XTEST-held keys [I].
- Lock-key state: `numLock` joins `capsLock` on every key event; Windows and Linux agents apply both
  (K12).
- Mouse: `button` adds `back` / `forward` (Windows `XBUTTON1/2`, macOS other-mouse 3/4, X11 8/9).
  `mouse_scroll` adds optional `deltaX` (Windows `MOUSEEVENTF_HWHEEL`, macOS 2-axis scroll, X11
  buttons 6/7) (M1, M3).
- macOS agent: modifier `key_down`/`key_up` maintain a running flags mask (posted as
  `kCGEventFlagsChanged`), applied to subsequent key **and mouse** events. Shift/Cmd+click works.

### 4. Keyboard mode (later wave — needs a spike)

#3920 asks for a layout selector. Proposed instead: a per-session **Keyboard mode**:

- **Type what I see (default):** printable characters without Ctrl/Alt/Meta go as Unicode text
  (`KEYEVENTF_UNICODE` / `CGEventKeyboardSetUnicodeString` / keysym). Chords and non-printables go as
  physical keys. This works across mismatched layouts. A hidden composition input captures IME and
  dead-key output (`compositionend` / `beforeinput`) and sends it as text (K10).
- **Physical keys:** everything goes by scancode; the remote layout interprets it (RDP-style). For
  apps that read raw keys (games, some terminals, VMs inside the remote).

Spike first: how `VK_PACKET` Unicode input behaves with single-key app shortcuts and terminals.

### 5. Clipboard v2

- **Focus rule (C1):** a session window applies remote→local pushes only while it is the focused
  window, or within 2 s after the operator sent a copy chord (Ctrl/Cmd+C/X, Ctrl+Insert) in that
  window (copy, then Alt-Tab). A plain "lost focus a moment ago" grace was rejected in review. It
  cannot tell the operator's copy from an end-user copy made just after the operator switched to
  another customer's window. Background windows keep the latest remote item in memory and offer it
  via the toolbar ("Copy remote clipboard", W4), never silently. Shipped in W1, except the toolbar
  action.
- **Chunking (C2):** `input_capabilities` advertises `clipboard: {chunked: true, maxBytes, formats}`.
  Content is split so that each **serialized** frame `{type:"chunk", id, seq, last, data}` is at most
  48 KiB (base64 inflates raw bytes by a third, before JSON overhead). The sender applies
  `bufferedAmount` backpressure. The receiver reassembles with a hard total cap and a per-transfer
  timeout, and acks only after the content has been **applied** to the clipboard, as the agent does
  today.
- **Paste is a transaction (C2).** With an ack-capable agent, a failed send, an ack timeout, or a
  channel close cancels the paste keystroke rather than pasting stale content. The content is cached
  as synced only after a successful ack. Pastes are serialized and bound to the session generation
  they started in, so a delayed paste cannot land in a session the operator switched to. (W1 already
  cancels on a failed send. Timeouts still paste, because agents that predate the ack exist.)
- **Baseline (C10):** the agent records the clipboard's hash when `Watch` starts instead of sending
  it. W1's viewer-side skip of the first push becomes a fallback for old agents.
- **Paste triggers (C3):** push on Ctrl/Cmd+V, Ctrl/Cmd+Shift+V and Shift+Insert (shipped in W1,
  `isPasteChord`), plus a toolbar "Send clipboard to remote" action for menu-driven paste (W4). Not continuous: a technician's clipboard routinely holds
  credentials or another customer's data, so it only crosses on an explicit paste or send.
- **Status (C4):** on clipboard channel open the agent sends
  `{type:"status", hostToViewer, viewerToHost, formats, maxBytes}`. The toolbar shows a clipboard
  chip with per-direction state ("Disabled by policy" tooltip) and a transient "Copied 2.1 KB from
  remote" notice.
- **Images (C5):** PNG both directions, under the same direction toggles. Grant
  `clipboard-manager:allow-read-image` / `allow-write-image`. RTF/HTML deferred.
- **VNC (C6):** wire noVNC's `clipboard` event and `clipboardPasteFrom`, or set the capability to
  `false`. Wire it.
- **type_text (C7):** stops running inside the control channel's `OnMessage`. A job layer prepares
  and cancels it (`type_text_cancel`). The chunks are injected by the input worker (§2), so text and
  keystrokes never interleave.
- **Audit (C8):** the agent keeps per-session counters (direction × format: count, bytes, blocked).
  It checkpoints them to its durable offline queue so a crash does not lose the evidence, and reports
  them at session teardown. The API writes one
  `audit_logs` row, `remote_session.clipboard_summary`, through `logSessionAudit`. No content, no
  per-transfer rows. Closes `TODO(#1012)` for clipboard.
- **Defaults (C9):** the config UI reads the baseline default instead of hard-coding `true`.

No new policy knobs. Images ride the existing per-direction toggles, so the clipboard is still
configured in exactly one place (`remote_access` policy → Clipboard), before and after.

### 6. Viewer-reserved shortcuts and OS-intercepted keys

- **Host-key prefix (K8):** move viewer actions off app-colliding chords to one prefix:
  Ctrl+Alt+Shift (Windows/Linux viewer) and Ctrl+Opt+Cmd (macOS viewer). F = fullscreen,
  V = paste as keystrokes, R = release all keys. Tooltips show the chord for the viewer's OS.
  Ctrl/Cmd+Shift+V/F are now forwarded to the remote. Ctrl/Cmd+Shift+V counts as a paste chord, so
  the local clipboard is pushed first. **Shipped in W1** (Q1 = yes, 2026-10-08). The viewer releases
  the prefix modifiers on the remote before acting, so paste-as-keystrokes never types into a held
  Ctrl+Alt+Shift. Known edge: on an AltGr layout, AltGr+Shift+F/V/R triggers the shortcut instead of
  typing that character.
- **Keyboard Lock (K9, Windows viewer):** in fullscreen, call `navigator.keyboard.lock()` when
  available so Alt-Tab, Win, and Esc go to the remote. Spike: confirm WebView2 support. Fallback: a
  Tauri-side `WH_KEYBOARD_LL` hook active only while a session window is focused and fullscreen.
- **macOS viewer (K9):** custom app menu for session windows without Cmd+W/H/M accelerators, so those
  reach the remote. Cmd+Q keeps quitting but confirms when sessions are open.

### 7. Convenience features

| Feature | Needs agent? | Notes |
|---|---|---|
| Focus ring + "Click to control" hint when keys are pressed without focus | No | U1 |
| "Input paused — reconnecting" notice instead of silent drops | No | U1 |
| Release all keys (toolbar + host-key R) | No (sends `input_reset` when supported) | K1–K4 |
| Block local input toggle | Agent already supports `block_local_input` (`session_control.go:497`) | #966; viewer UI only |
| View-only toggle | No | Viewer-local guard against accidental input |
| Screenshot (copy to clipboard / save PNG) | No | Draws the current video frame; needs `allow-write-image` |
| Scaling: Fit / 100% (scroll) | No | WebRTC/VNC currently fit-only |
| Stats overlay (RTT, fps, bitrate, loss, encoder, transport) | No | Data already collected by `statsReporter` |
| Per-device memory of remap, keyboard mode, scaling, audio | No | `localStorage`, keyed by device id |

Out of scope: in-session chat (#3084), privacy/blank screen, file transfer (removed by SEC-127; needs
its own server-authorized design), UAC prompt visibility (#5484).

## Waves

| Wave | Scope | Ships to | Rigor |
|---|---|---|---|
| **W1** ✅ | Viewer-only fixes that work against today's agents (`apps/viewer/src/lib/inputSafety.ts`):<br>• Release keys **and mouse buttons** on window blur, hidden, or canvas blur (K1). Releases that hit a dead channel are kept and flushed first on the next live one (K4).<br>• Pointer capture for drags, with WS-canvas coordinates clamped (M2). Buttons 3/4 no longer click (M1).<br>• Cmd↔Ctrl remap defaults from viewer OS × remote OS; toggling it releases held keys (K6).<br>• Autorepeat forwarded on Windows/macOS remotes (K7).<br>• Chords whose modifiers are already held go as key_down/key_up — Windows remotes only, and not for a remapped `meta` (K5).<br>• Undelivered-input notice, focus ring, toolbar "Release stuck keys" (U1).<br>• A failed clipboard push no longer pastes stale content (C2).<br>• Clipboard focus rule plus a baseline-push skip (C1, C10).<br>• Host-key prefix for viewer shortcuts (K8). The local clipboard is pushed for Ctrl/Cmd+Shift+V and Shift+Insert too (C3). | Viewer | Standard |
| **W2** (split: W2a #8238 tracker/worker/release/validation, plan `docs/superpowers/plans/remote-desktop/2026-10-08-viewer-input-clipboard.md`; W2b #8246 protocol; W2c #8247 key/pointer coverage) | Agent: held-state tracker + `ReleaseAll` triggers, input worker, normalizer parity, `input-r` + `seq`, `input_reset`, `key_press` honours held modifiers, `code` → scancode, extended keys, back/forward, horizontal wheel, Num/Caps sync on Windows+Linux, macOS flags mask. Advertised via `input_capabilities`. | Agent (customer machines) | High |
| **W3** | Viewer adopts W2: route on `input-r`, send `seq`, `code`, `numLock`, `deltaX`, back/forward, `input_reset` on focus loss. | Viewer | Standard |
| **W4** | Clipboard v2: focus rule, chunking, status + chip, Shift+Insert / Send-clipboard, images, VNC wiring, `type_text` worker, audit summary, defaults fix. | Agent + viewer + API | High |
| **W5** | Convenience: Keyboard Lock / macOS menu, view-only, block-input UI, screenshot, scaling, stats overlay, per-device prefs. | Viewer | Standard |
| **W6** | Keyboard mode (text vs physical) + IME composition, after spike. Resolves #3920. | Agent + viewer | High |

The **C1 focus rule** is viewer-only and a data-leak fix, so it shipped in W1 rather than waiting for
W4. Known edge: if a push is skipped because the window was in the background, and the operator then
copies the *same* content again, the agent sees no change and sends nothing. W4's "Copy remote
clipboard" action covers this case.

## Testing

- Viewer: Vitest for each pure helper (remap default, button mapping, repeat policy, chord routing,
  release-on-blur, focus-gated clipboard apply, chunk framing). DesktopViewer behaviour tests follow
  `DesktopViewer.capsLock.test.ts`.
- Agent: table-driven Go tests for the tracker (every trigger releases everything exactly once),
  normalizer, chunk reassembly (caps, timeout, out-of-order, duplicate), scancode table, and
  `key_press` with held modifiers. `go test -race`.
- Lab (Windows + macOS targets, Mac + Windows viewers): stuck-key drills (Alt-Tab mid-chord, kill
  viewer mid-drag, pull network mid-chord), 500 KB text and 2 MB image paste, background-session
  clipboard isolation, Keyboard Lock in WebView2, autorepeat on each OS.

## Open questions

- ~~Q1~~ Resolved 2026-10-08: adopt the host-key prefix. Shipped in W1.
- ~~Q2~~ Resolved: the focus rule shipped in W1 (conservative, reversible).

## Review log

- 2026-10-08: W1 code review (Codex, `medium`). Fixed all five findings, each with a source guard
  that fails on the earlier commit:
  - The blur-grace clipboard leak. Replaced by copy intent.
  - The baseline counter missed image and empty pushes.
  - Stranded releases had no destination. They are now bound to the device.
  - Releases were not flushed when the input channel opened after `connected`.
  - Modifier bookkeeping desynced after a `key_press` fallback. Modifiers the agent released are now
    forgotten.

- 2026-10-07: independent design review (Codex, `xhigh`). Accepted all amendments:
  - the ordering barrier (`after`);
  - the reset and geometry epochs;
  - the input worker owning all injection;
  - idle accounting on `input-r`;
  - paste as a transaction, with ack after the content is applied;
  - serialized-frame cap and sender backpressure;
  - the corrected C2 direction analysis;
  - Linux and remapped-`meta` exclusions in W1 chord routing.
