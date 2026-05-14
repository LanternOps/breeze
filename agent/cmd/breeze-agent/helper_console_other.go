//go:build !windows

package main

// detachHelperConsole is a no-op outside Windows. macOS and Linux do not
// have the "console window flashes when a console-subsystem binary is
// launched in an interactive session" problem the Windows version is solving.
func detachHelperConsole() {}
