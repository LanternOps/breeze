//go:build linux

package securefs

// trustedIntermediateLinksAllowed is false on Linux: the paths that motivate
// the darwin relaxation (/var, /tmp, /etc) are ordinary directories here, so
// following ANY symlink in the absolute prefix would widen an already-reviewed
// boundary for nothing. Linux keeps the accepted behaviour exactly — no link is
// followed at any depth of the absolute prefix.
const trustedIntermediateLinksAllowed = false
