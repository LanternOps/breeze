//go:build !windows

package sessionbroker

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
)

func (b *Broker) setupSocket() (net.Listener, error) {
	// Remove stale socket file
	os.Remove(b.socketPath)

	// Ensure directory exists
	dir := filepath.Dir(b.socketPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", dir, err)
	}
	if err := os.Chmod(dir, 0755); err != nil {
		return nil, fmt.Errorf("chmod %s: %w", dir, err)
	}

	// The breeze group must exist before the socket can be group-owned by it.
	// Ensuring it here — on every daemon start — is what makes the socket come
	// back correctly after a reboot or `launchctl kickstart -k
	// system/com.breeze.agent`, not just at first install (#3133/#3134/#3137).
	if err := EnsureIPCGroup(); err != nil {
		log.Warn("could not ensure IPC socket group; non-admin user helpers may be denied",
			"group", IPCGroupName, "error", err.Error())
	}

	listener, err := net.Listen("unix", b.socketPath)
	if err != nil {
		return nil, fmt.Errorf("listen %s: %w", b.socketPath, err)
	}

	// Allow normal user helpers to traverse the directory and connect to the
	// socket. Peer credential verification and binary checks remain the gate.
	//
	// The mode alone is not enough: a root-created socket inherits a group the
	// console user is not in (`admin` on macOS, where BSD semantics take the
	// parent directory's group), so 0660 silently locked out every Standard
	// user's helper. Group-own it explicitly.
	owner, resolveErr := resolveSocketOwner(ipcGroupIDLookup)
	if resolveErr != nil {
		// Deliberately not fatal. Aborting here would leave the agent with no
		// IPC socket at all, killing remote desktop, backup IPC and the
		// watchdog link — strictly worse than a socket only root can reach,
		// which is the pre-fix status quo. Warn loudly with the remedy instead.
		log.Warn("IPC socket group could not be resolved; user-session helpers will be denied until it exists",
			"group", IPCGroupName,
			"socket", b.socketPath,
			"remedy", "reinstall the agent, or create the group manually, to restore user-helper IPC",
			"error", resolveErr.Error())
	}
	if err := applySocketOwner(b.socketPath, owner, os.Chown, os.Chmod); err != nil {
		listener.Close()
		return nil, err
	}
	if owner.GID >= 0 {
		log.Info("IPC socket permissions applied",
			"socket", b.socketPath, "group", IPCGroupName, "gid", owner.GID, "mode", fmt.Sprintf("%#o", owner.Mode))
	}
	return listener, nil
}

// peerWinSessionID is a no-op on non-Windows platforms.
func peerWinSessionID(pid int) uint32 {
	return 0
}
