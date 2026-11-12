//go:build windows

package tools

import "os"

// openInspectHandle opens p for its attributes and final path. Device
// namespaces and reserved device names are refused earlier
// (localPathFormError), and the type is checked before and after the open.
func openInspectHandle(p string, _ bool) (*os.File, error) { return os.Open(p) }

// openScanFile opens a queued scan file for reading. Windows opens follow
// reparse points; the caller compares the opened file with the walked one
// and checks the handle's final path.
func openScanFile(p string) (*os.File, error) { return os.Open(p) }
