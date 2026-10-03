// win_build_check.go — W07a: a Windows PE older than the backed-up Windows
// cannot reliably restore it (the WinPE inbox NTFS/BCD/servicing stack must
// be at least the guest's), so a disk: rebuild refuses in preflight, before
// anything is written.
package rebuild

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

// enablementPackageBases maps a Windows build delivered as an enablement
// package (a feature update that only switches on features already present in
// an existing servicing branch) to the servicing base build it runs on. Those
// builds share the base's NTFS/BCD/servicing stack and no Windows ADK/WinPE is
// released for them, so the newest WinPE that can exist for such a guest is
// the base build's.
var enablementPackageBases = map[uint32]uint32{
	19042: 19041, // Windows 10 20H2
	19043: 19041, // Windows 10 21H1
	19044: 19041, // Windows 10 21H2
	19045: 19041, // Windows 10 22H2
	22631: 22621, // Windows 11 23H2
	26200: 26100, // Windows 11 25H2
}

// servicingBaseBuild returns the servicing base build of an enablement-package
// build, and any other build unchanged.
func servicingBaseBuild(build uint32) uint32 {
	if base, ok := enablementPackageBases[build]; ok {
		return base
	}
	return build
}

// checkWinPEBuild refuses when the WinPE host build is older than the guest's
// servicing base build (see servicingBaseBuild). A guest build of 0 means
// unknown and never refuses.
func checkWinPEBuild(host, guest uint32) *RefusalError {
	if guest == 0 {
		return nil
	}
	base := servicingBaseBuild(guest)
	if host >= base {
		return nil
	}
	guestDesc := strconv.FormatUint(uint64(guest), 10)
	if base != guest {
		guestDesc = fmt.Sprintf("%d (compared as its servicing base build %d)", guest, base)
	}
	return &RefusalError{Code: RefusalCodeWinPETooOld, Reason: fmt.Sprintf(
		"this recovery media runs Windows PE build %d, older than the backed-up Windows build %s; rebuild the media with a current Windows ADK", host, guestDesc)}
}

// checkGuestBuild refuses a disk: rebuild whose WinPE is older than the
// backed-up Windows. Inconclusive reads (HostBuild failed or unknown, SOFTWARE
// artifact absent, value missing or malformed) warn; real errors are returned.
func (r *run) checkGuestBuild() (*RefusalError, error) {
	host, herr := r.opts.WinSystem.HostBuild()
	if herr != nil {
		r.warn("could not read the WinPE build: %v; WinPE/guest build compatibility not checked", herr)
		return nil, nil
	}
	if host == 0 {
		r.warn("could not read the WinPE build; WinPE/guest build compatibility not checked")
		return nil, nil
	}
	guest, ok, err := r.guestBuild()
	if err != nil {
		return nil, err
	}
	if !ok {
		r.warn("could not read the guest Windows build from the system-state SOFTWARE artifact; WinPE/guest build compatibility not checked")
		return nil, nil
	}
	return checkWinPEBuild(host, guest), nil
}

// guestBuild reads CurrentBuildNumber from the STAGED system-state
// registry/SOFTWARE artifact (read-only load, mount BRZ_<targetKey>_PREB),
// mirroring isDomainController. ok=false with a nil error means "cannot tell"
// (artifact absent, or the value is missing / not a decimal number — the
// latter also adds a run warning); anything else that goes wrong, including a
// hive that will not unload, is an error (fail closed).
func (r *run) guestBuild() (build uint32, ok bool, err error) {
	if r.stateStaging == "" {
		return 0, false, errors.New("guest build check: no system-state staging directory")
	}
	hivePath := filepath.Join(r.stateStaging, "registry", "SOFTWARE")
	if _, err := os.Stat(hivePath); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("guest build check: %w", err)
	}
	h, err := r.opts.WinSystem.LoadHiveReadOnly(hivePath, "BRZ_"+targetKey(r.opts.Target)+"_PREB")
	if err != nil {
		return 0, false, fmt.Errorf("load SOFTWARE hive for guest build check: %w", err)
	}
	defer func() {
		if cerr := h.Close(); cerr != nil {
			build, ok = 0, false
			err = errors.Join(err, fmt.Errorf("unload SOFTWARE hive after guest build check: %w", cerr))
		}
	}()
	k, err := h.Root().OpenKey(`Microsoft\Windows NT\CurrentVersion`)
	if err != nil {
		if errors.Is(err, winhive.ErrNotExist) {
			r.warn("guest Windows build check: the SOFTWARE hive has no CurrentVersion key")
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("open CurrentVersion: %w", err)
	}
	s, err := k.GetString("CurrentBuildNumber")
	if err != nil {
		if errors.Is(err, winhive.ErrNotExist) {
			r.warn("guest Windows build check: CurrentBuildNumber is missing from the SOFTWARE hive")
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("read CurrentBuildNumber: %w", err)
	}
	n, perr := strconv.ParseUint(strings.TrimSpace(s), 10, 32)
	if perr != nil || n == 0 {
		r.warn("guest Windows build check: CurrentBuildNumber %q is not a valid build number", s)
		return 0, false, nil
	}
	return uint32(n), true, nil
}
