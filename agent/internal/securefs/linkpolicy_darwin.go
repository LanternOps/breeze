//go:build darwin

package securefs

// trustedIntermediateLinksAllowed is true only on darwin. A real macOS root
// filesystem ships privileged firmlink-style symlinks that any genuine
// installation path must traverse (/var -> private/var, /tmp -> private/tmp,
// /etc -> private/etc), all root:wheel on a read-only signed system volume. A
// strictly link-free absolute walk makes every macOS path under those prefixes
// unusable.
const trustedIntermediateLinksAllowed = true
