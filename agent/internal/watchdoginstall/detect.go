package watchdoginstall

import (
	"errors"
	"io/fs"
	"os"
)

// Status is the registration-level answer to "is the watchdog installed as a
// service on this host?". Ongoing liveness is the service manager's job; this
// only asks whether the binary AND the service definition exist.
type Status int

const (
	// StatusUnknown: a probe failed for a reason other than "absent". The
	// caller must NOT install (and must not count an attempt).
	StatusUnknown Status = iota
	// StatusRegistered: binary and service definition both present.
	StatusRegistered
	// StatusMissing: the binary or the service definition is absent.
	StatusMissing
	// StatusUnsupported: no watchdog service exists for this OS / init system.
	StatusUnsupported
)

func (s Status) String() string {
	switch s {
	case StatusRegistered:
		return "registered"
	case StatusMissing:
		return "missing"
	case StatusUnsupported:
		return "unsupported"
	}
	return "unknown"
}

// StatFunc is os.Stat's signature, injectable for tests.
type StatFunc func(string) (fs.FileInfo, error)

// presence is the outcome of probing one path.
type presence int

const (
	absent presence = iota
	present
	probeFailed
)

func probe(stat StatFunc, path string) presence {
	fi, err := stat(path)
	switch {
	case err == nil:
		if fi.IsDir() {
			return probeFailed // a directory where a file belongs is not "installed"
		}
		return present
	case errors.Is(err, fs.ErrNotExist):
		return absent
	default:
		return probeFailed
	}
}

// detectFiles is the shared Unix decision: initMarker (when non-empty) must
// exist or the host is Unsupported; any one of binaries must exist; definition
// must exist.
func detectFiles(stat StatFunc, initMarker string, binaries []string, definition string) Status {
	if stat == nil {
		stat = os.Stat
	}
	if initMarker != "" {
		fi, err := stat(initMarker)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			return StatusUnsupported
		case err != nil:
			return StatusUnknown
		case !fi.IsDir():
			return StatusUnsupported
		}
	}
	bin := absent
	for _, b := range binaries {
		switch probe(stat, b) {
		case present:
			bin = present
		case probeFailed:
			if bin != present {
				bin = probeFailed
			}
		}
		if bin == present {
			break
		}
	}
	def := probe(stat, definition)
	return combine(bin, def)
}

// ServiceProbe reports whether a named service registration exists (Windows
// SCM). err != nil means the answer is unknown.
type ServiceProbe func() (exists bool, err error)

// detectService is the Windows decision: protected binary + SCM entry.
func detectService(stat StatFunc, binary string, svc ServiceProbe) Status {
	if stat == nil {
		stat = os.Stat
	}
	bin := probe(stat, binary)
	def := probeFailed
	if svc != nil {
		exists, err := svc()
		switch {
		case err != nil:
			def = probeFailed
		case exists:
			def = present
		default:
			def = absent
		}
	}
	return combine(bin, def)
}

func combine(bin, def presence) Status {
	// A definite absence of either half is Missing even if the other half
	// could not be probed: the install is idempotent, so completing it is safe.
	if bin == absent || def == absent {
		return StatusMissing
	}
	if bin == present && def == present {
		return StatusRegistered
	}
	return StatusUnknown
}
