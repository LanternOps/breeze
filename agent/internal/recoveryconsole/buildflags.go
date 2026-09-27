package recoveryconsole

// unattendedCmdlineEnabled gates whether Console.Run ever honors
// breeze.ci=1 (and the cmdline "answers" that are only meaningful in that
// mode — breeze.server, breeze.insecure, breeze.code, breeze.target,
// breeze.confirm, breeze.after) from the kernel cmdline at all. Empty
// (disabled) is the zero value and what every production recovery-media
// build ships with. Set to "1" only on CI/test recovery-media builds, via
// `-ldflags "-X github.com/breeze-rmm/agent/internal/recoveryconsole.unattendedCmdlineEnabled=1"`
// — see .github/workflows/ci.yml's recovery-media E2E job. This package's
// own tests stand in for a CI/test build too: TestMain sets it directly.
//
// Why this exists: the kernel cmdline is boot-time-editable by anyone with
// physical or console access before the recovery console process ever
// starts — the same unauthenticated surface breeze.server= and
// breeze.insecure=1 come from, and both of those are already scoped so
// they can only ever matter once breeze.ci=1 itself is in effect. Without
// a gate on breeze.ci=1 independent of the cmdline that also sets it, an
// actor in that boot-position position could set breeze.ci=1 themselves
// and get a FULLY unattended run — no server-URL confirmation, no
// disk-erase confirmation — regardless of how tightly every other
// individual token is gated, because they control the token that
// activates ci mode in the first place.
var unattendedCmdlineEnabled string

func unattendedCmdlineAllowed() bool {
	return unattendedCmdlineEnabled == "1"
}
