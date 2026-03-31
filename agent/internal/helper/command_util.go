package helper

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const (
	helperCommandTimeout    = 5 * time.Second
	maxHelperFieldBytes     = 4096
	maxHelperScannerBytes   = 1024 * 1024
	maxHelperSessionTargets = 256
	maxHelperSessionKeyLen  = 32
)

func runHelperCommand(name string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), helperCommandTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	err := cmd.Run()
	if ctx.Err() != nil {
		return fmt.Errorf("%s timed out: %w", name, ctx.Err())
	}
	return err
}

func outputHelperCommand(name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), helperCommandTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	out, err := cmd.Output()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("%s timed out: %w", name, ctx.Err())
	}
	return out, err
}

func parseConsoleUIDOutput(out []byte) (string, error) {
	uid := strings.TrimSpace(string(out))
	if uid == "" {
		return "", fmt.Errorf("empty uid")
	}
	if len(uid) > maxHelperSessionKeyLen {
		return "", fmt.Errorf("uid too long")
	}
	for _, r := range uid {
		if r < '0' || r > '9' {
			return "", fmt.Errorf("uid must be numeric")
		}
	}
	return uid, nil
}

func parseProcessPathOutput(out []byte) (string, error) {
	path := strings.TrimSpace(string(out))
	if path == "" {
		return "", fmt.Errorf("empty process path")
	}
	if len(path) > maxHelperFieldBytes {
		return "", fmt.Errorf("process path too long")
	}
	return path, nil
}

func parseMigrationTargetsOutput(out []byte) []string {
	scanner := bufio.NewScanner(bytes.NewReader(out))
	scanner.Buffer(make([]byte, 0, 64*1024), maxHelperScannerBytes)

	targets := make([]string, 0)
	seen := make(map[string]struct{})
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		uid, err := parseConsoleUIDOutput([]byte(fields[1]))
		if err != nil || uid == "0" {
			continue
		}
		if _, ok := seen[uid]; ok {
			continue
		}
		seen[uid] = struct{}{}
		targets = append(targets, uid)
		if len(targets) >= maxHelperSessionTargets {
			break
		}
	}
	return targets
}
