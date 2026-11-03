package updater

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

type isolationInstallHook struct {
	prepare func(staged, target string) error
}

var currentIsolationInstallHook atomic.Pointer[isolationInstallHook]

// SetIsolationInstallHook wires the manager without importing isolation into the
// updater. It runs only after the staged executable's signature/hash/size checks.
func SetIsolationInstallHook(prepare func(staged, target string) error) {
	if prepare == nil {
		currentIsolationInstallHook.Store(nil)
		return
	}
	currentIsolationInstallHook.Store(&isolationInstallHook{prepare: prepare})
}

// StagedIsolationSchema asks the verified staged agent which journal it can
// safely read. Older agents lacking this command fail closed. No journal writes
// or configuration loading are performed by containment journal-schema.
func StagedIsolationSchema(ctx context.Context, staged string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, staged, "containment", "journal-schema").Output()
	if err != nil {
		return 0, fmt.Errorf("query staged isolation journal schema: %w", err)
	}
	return parseIsolationSchema(output)
}

func parseIsolationSchema(output []byte) (int, error) {
	schema, err := strconv.Atoi(strings.TrimSpace(string(output)))
	if err != nil || schema < 1 {
		return 0, errors.New("invalid staged isolation journal schema")
	}
	return schema, nil
}
