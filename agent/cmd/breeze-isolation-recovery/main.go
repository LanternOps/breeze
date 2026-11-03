// breeze-isolation-recovery is the independently runnable containment recovery
// executable. It must not link the main agent's configuration or update stack.
//
// Exit codes: 0 = success or an attempt-fenced no-op; 1 = unsupported platform,
// unavailable engine, or unconfirmed cleanup/persistence/task removal;
// 2 = invalid command or arguments. A cleanup error leaves recovery armed.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// Overridden by the release build with -ldflags '-X main.version=...'.
var version = "dev"

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

func run(args []string, stdout, stderr io.Writer) int {
	return runWithDependencies(args, stdout, stderr, platformRecoveryDependencies())
}

func runWithDependencies(args []string, stdout, stderr io.Writer, deps recoveryDependencies) int {
	invalid := func(message string) int { _, _ = fmt.Fprintln(stderr, message); return 2 }
	if len(args) == 0 {
		return invalid("a recovery subcommand is required")
	}
	name := args[0]
	switch name {
	case "--journal-schema":
		if len(args) != 1 {
			return invalid("--journal-schema accepts no arguments")
		}
		_, _ = fmt.Fprintln(stdout, journal.SchemaVersion)
		return 0
	case "--version":
		if len(args) != 1 {
			return invalid("--version accepts no arguments")
		}
		_, _ = fmt.Fprintln(stdout, version)
		return 0
	case "self-test":
		if len(args) != 1 {
			return invalid("self-test accepts no arguments")
		}
		if err := deps.selfTest(context.Background()); err != nil {
			_, _ = fmt.Fprintln(stderr, err)
			return 1
		}
		return 0
	case "expire-check", "boot-apply", "rollback-if-uncommitted", "release-all":
	default:
		return invalid("unknown recovery subcommand")
	}

	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	// Do not echo arbitrary input values from the flag parser into logs.
	flags.SetOutput(io.Discard)
	dataDir := flags.String("data-dir", "", "Agent state directory")
	var attempt, reason string
	if name == "rollback-if-uncommitted" {
		flags.StringVar(&attempt, "attempt", "", "Provisional attempt ID")
	}
	if name == "release-all" {
		flags.StringVar(&reason, "reason", "", "Release reason")
	}
	if err := flags.Parse(args[1:]); err != nil {
		return invalid("invalid recovery arguments")
	}
	if flags.NArg() != 0 {
		return invalid("unexpected positional arguments")
	}
	if strings.TrimSpace(*dataDir) == "" {
		return invalid("--data-dir is required")
	}
	if name == "rollback-if-uncommitted" && strings.TrimSpace(attempt) == "" {
		return invalid("--attempt is required")
	}
	if name == "release-all" && strings.TrimSpace(reason) == "" {
		return invalid("--reason is required")
	}

	manager, err := deps.manager(*dataDir)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 1
	}
	ctx := context.Background()
	switch name {
	case "boot-apply":
		err = manager.BootApply(ctx)
	case "expire-check":
		err = manager.RecoveryExpireCheck(ctx)
	case "rollback-if-uncommitted":
		err = manager.RollbackIfUncommitted(ctx, attempt)
	case "release-all":
		err = manager.ReleaseAll(ctx, reason)
	}
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}
