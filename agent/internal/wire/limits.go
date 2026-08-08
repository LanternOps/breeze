// Package wire holds the size limits the SERVER enforces on agent→server
// messages.
//
// They live in their own leaf package, with no dependencies, because the two
// places that must respect them sit on opposite sides of the agent: the backup
// helper (cmd/breeze-backup) which BUILDS an oversize-capable result, and the
// websocket client (internal/websocket) which SENDS it. Importing
// internal/websocket from the helper just to read a number would drag gorilla
// and the whole connection machinery into a helper binary that never opens a
// socket.
//
// Everything here mirrors a server-side constant. A value that drifts from its
// mirror silently re-opens the class of bug described below, so each one is
// pinned by a test that asserts the literal.
package wire

// MaxCommandResultBytes is the server's cap on the encoded `result` field of a
// command_result message.
//
// MIRRORS apps/api/src/routes/agents/schemas.ts `MAX_COMMAND_RESULT_BYTES`.
// Pinned by TestMaxCommandResultBytesMatchesServerSchema; the server side is
// pinned by schemas.commandResult.test.ts. Both assert the literal, so raising
// one alone reddens CI rather than quietly reintroducing #3001.
//
// WHY THIS IS THE LIMIT THAT MATTERS. It is the tightest bound anywhere on the
// result path, and by a wide margin:
//
//	  1 MiB  this — server-side Zod refine on `result`
//	 16 MiB  ipc.MaxMessageSize (helper→agent frame)
//	 16 MiB  websocket.maxMessageSize (agent's INBOUND read limit)
//	100 MiB  the `ws` server's default maxPayload
//
// #3001: the backup helper's tiered degradation bounded against the 16 MiB IPC
// frame — the next hop, not the binding one — so it stayed inert while every
// backup over ~2,000 files was rejected by the server 16x below that budget.
// The rejection logged as a generic invalid-message server-side and as nothing
// at all agent-side, so a backup that had SUCCEEDED was reported to the user as
// stalled by the stale-backup reaper. Bound against the tightest limit in the
// whole chain, never merely the next one.
const MaxCommandResultBytes = 1024 * 1024

// CommandResultHeadroom is subtracted from MaxCommandResultBytes to get the
// budget agent-side code should actually target.
//
// It exists because NOBODY on this side measures the same bytes the server
// does. The server re-encodes with JSON.stringify AFTER JSON.parse and checks
// the length of that, so every agent-side measurement is a proxy:
//
//   - The backup helper measures the RAW JSON TEXT it produced (len(Stdout)),
//     before that text is even parsed. When the text is not an object it
//     reaches the wire as a JSON *string*, and the quoting and escaping make
//     the server's measurement LARGER than the text — the one direction where
//     the proxy under-reports.
//   - The websocket client measures Go's encoding of the value. Go's
//     encoding/json is the more verbose of the two in every direction that
//     matters — it HTML-escapes `<`, `>` and `&` to six-byte </>/
//     & sequences and escapes U+2028/U+2029, none of which JSON.stringify
//     does — so this proxy is conservative except for number re-formatting.
//
// Rather than reason about which proxy is safe where, every producer targets
// the budget. Overshooting the margin costs a degraded body in a narrow band
// below the cap; undershooting it costs the whole message, which is the failure
// this package exists to prevent.
const CommandResultHeadroom = 64 * 1024

// CommandResultBudget is the size agent-side code should keep its encoded
// result body under so the server accepts it. Prefer this over
// MaxCommandResultBytes at every comparison site; the bare cap is for reporting
// the server's contract in logs and markers, not for deciding whether to send.
const CommandResultBudget = MaxCommandResultBytes - CommandResultHeadroom
