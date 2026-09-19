package userhelper

import (
	"crypto/rand"
	"encoding/hex"
)

// sessionIDRandomBytes is the entropy behind an opaque helper session id.
// 8 bytes (16 hex chars) keeps the value short enough to read in a log line
// while making a collision with a concurrently-connected helper — which the
// broker rejects outright, see below — a non-event.
const sessionIDRandomBytes = 8

// newSessionID returns an opaque, per-connection helper session identifier of
// the form "helper-<16 hex chars>".
//
// It deliberately embeds NO host identity. The previous form was
//
//	fmt.Sprintf("helper-%s-%d", username, os.Getpid())
//
// which baked the OS login name into the id — `DOMAIN\user`, or `DOMAIN\HOST$`
// for a machine account, on Windows; the login name on macOS/Linux. That id is
// interpolated into free-text error strings (e.g. sessionbroker's
// `%w: %q (session %q)`) and those strings are shipped to the API's
// /agents/logs endpoint, where redaction is key-name based: it blanked the
// `session` key while the identical username survived verbatim inside the
// sibling `error` string of the very same row (#3109). Removing the identity at
// the source closes every one of the ~20 log sites in one change, instead of
// requiring a scrubbing pattern to be re-proven at each new call site.
//
// Nothing reverse-parses this string. The broker admits, quota-limits and
// evicts sessions by IdentityKey() / HelperKey — kernel-verified process
// credentials and the Windows session number — never by this id's grammar
// (sessionbroker/broker.go admission steps 3-9). The id is only ever used as an
// opaque token: as a map key in Broker.sessions, for the in-agent
// desktopOwners -> SessionByID round trip, and as a log attribute. The
// "helper-" prefix is kept purely so the value stays greppable.
//
// A per-connection random value is also strictly safer than the old one for
// reconnects: the broker rejects an auth whose SessionID is already registered
// ("session ID already in use"), and the old id was a pure function of username
// and PID, so a helper re-authenticating while the broker still held its
// previous session collided with itself. A random id cannot.
func newSessionID() string {
	buf := make([]byte, sessionIDRandomBytes)
	// crypto/rand.Read is documented never to return an error: it fills buf
	// entirely or panics on an unrecoverable OS-entropy failure. There is no
	// error branch to take, and falling back to anything host-derived is
	// exactly what this function exists to avoid.
	_, _ = rand.Read(buf)
	return "helper-" + hex.EncodeToString(buf)
}
