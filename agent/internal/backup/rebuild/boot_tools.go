package rebuild

import (
	"os"
	"strings"
)

// The restored system's own boot tools (grub-install, update-grub and the
// /etc/grub.d scripts it runs, grub2-mkconfig, update-initramfs, dracut) are
// programs from the snapshot. The boot phase never runs them: it keeps the
// restored boot configuration, which stays valid because provision recreates
// the partition and filesystem ids it refers to, and it writes the firmware
// fallback loader and the firmware boot entry with host-side code
// (boot.go).
//
// Options.RestoredBootTools (and Options.RegenerateInitramfs, which needs
// the same tools) is the explicit opt-in to run them. Run refuses the opt-in
// before doing anything when:
//   - it is not confirmed (Options.ConfirmRestoredBootTools);
//   - this host is not Breeze recovery media, i.e. it has an installed agent
//     (the server-dispatched rebuild and a CLI run on a managed machine);
//   - there is no isolated runner for the tools. A runner must give them no
//     host /dev, /proc, /sys, /run, D-Bus or systemd socket, private mount,
//     PID, IPC and network namespaces, and only the target's own block
//     devices. This build has none, so a confirmed opt-in on recovery media
//     is refused as well; the tools are never run in a plain chroot.

// Refusal codes for the restored-boot-tools opt-in.
const (
	RefusalCodeRestoredBootToolsUnconfirmed = "restored_boot_tools_unconfirmed"
	RefusalCodeRestoredBootToolsAgentHost   = "restored_boot_tools_agent_host"
	RefusalCodeRestoredBootToolsUnisolated  = "restored_boot_tools_unisolated"
)

const restoredBootToolsDefault = "without it the rebuild keeps the restored boot configuration and recreates the partition and filesystem ids it refers to"

// onRecoveryMedia reports whether this process runs on Breeze recovery media
// (breeze.media=1 on the kernel command line) rather than on a host with an
// installed agent. Anything else, including an unreadable command line and
// every non-Linux host, counts as an installed-agent host. A var so tests can
// pin it.
var onRecoveryMedia = func() bool {
	b, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		return false
	}
	return cmdlineMarksRecoveryMedia(string(b))
}

// cmdlineMarksRecoveryMedia reports whether a kernel command line carries the
// recovery media's breeze.media=1 parameter.
func cmdlineMarksRecoveryMedia(cmdline string) bool {
	for _, field := range strings.Fields(cmdline) {
		if field == "breeze.media=1" {
			return true
		}
	}
	return false
}

// restoredBootToolsRefusal is the single check for the restored-boot-tools
// opt-in: nil when the options do not ask for the restored system's tools,
// otherwise the refusal. It never returns nil for a request, because this
// build has no isolated runner for them.
func restoredBootToolsRefusal(opts Options) *RefusalError {
	if !opts.RestoredBootTools && !opts.RegenerateInitramfs {
		return nil
	}
	if !opts.ConfirmRestoredBootTools {
		return &RefusalError{Code: RefusalCodeRestoredBootToolsUnconfirmed, Reason: "running the restored system's own boot tools " +
			"(grub reinstall or initramfs regeneration) needs explicit confirmation (--confirm-restored-boot-tools); " + restoredBootToolsDefault}
	}
	if !onRecoveryMedia() {
		return &RefusalError{Code: RefusalCodeRestoredBootToolsAgentHost, Reason: "the restored system's own boot tools are not run " +
			"on a host with an installed agent; run the rebuild from Breeze recovery media, or leave the option off: " + restoredBootToolsDefault}
	}
	return &RefusalError{Code: RefusalCodeRestoredBootToolsUnisolated, Reason: "this build cannot run the restored system's own boot tools " +
		"in an isolated sandbox, so it does not run them; rebuild without --restored-boot-tools: " + restoredBootToolsDefault}
}
