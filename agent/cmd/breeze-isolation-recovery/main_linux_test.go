//go:build linux

package main

import (
	"bytes"
	"testing"
)

func TestLinuxRecoveryManagerBuildsWithoutAgentDependencies(t *testing.T) {
	m, err := platformRecoveryDependencies().manager(t.TempDir())
	if err != nil {
		t.Fatalf("manager: %v", err)
	}
	if _, ok := m.(linuxRecoveryManager); !ok {
		t.Fatalf("manager = %T: boot-apply must restore rules on Linux", m)
	}
}

func TestLinuxRecoveryVersionNeedsNoEngine(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run([]string{"--version"}, &stdout, &stderr); code != 0 || stdout.Len() == 0 {
		t.Fatalf("code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}
