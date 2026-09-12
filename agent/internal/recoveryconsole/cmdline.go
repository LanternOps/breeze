// Package recoveryconsole implements the guided bare-metal recovery
// console (spec §7.3): the line-oriented flow that runs on Breeze recovery
// media (breeze-backup recovery-console) — code → plan → confirm →
// rebuild → reboot.
package recoveryconsole

import "strings"

// Answers holds the CI-only unattended answers parsed from the kernel
// cmdline (breeze.ci=1 …). Used only when ci is true — see
// ParseKernelCmdline.
type Answers struct {
	Server, Code, Target, Confirm, After string
	Insecure                             bool
}

// ParseKernelCmdline parses a Linux kernel cmdline string (typically the
// contents of /proc/cmdline) for the breeze.* tokens the recovery console
// understands: breeze.media=1 (required to run at all, unless
// --allow-host), breeze.ci=1 (CI-only unattended answer mode), and — only
// meaningful when ci is true — breeze.server=, breeze.code=,
// breeze.target=, breeze.confirm=, breeze.after=, breeze.insecure=1.
func ParseKernelCmdline(s string) (media bool, ci bool, a Answers) {
	for _, tok := range strings.Fields(s) {
		key, value, hasValue := strings.Cut(tok, "=")
		switch key {
		case "breeze.media":
			media = hasValue && value == "1"
		case "breeze.ci":
			ci = hasValue && value == "1"
		case "breeze.server":
			a.Server = value
		case "breeze.code":
			a.Code = value
		case "breeze.target":
			a.Target = value
		case "breeze.confirm":
			a.Confirm = value
		case "breeze.after":
			a.After = value
		case "breeze.insecure":
			a.Insecure = hasValue && value == "1"
		}
	}
	return media, ci, a
}
