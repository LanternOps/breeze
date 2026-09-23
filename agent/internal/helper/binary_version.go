package helper

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"strings"

	"github.com/breeze-rmm/agent/internal/versionpolicy"
)

// errBinaryVersionUnsupported is returned by readBinaryVersion on platforms
// where the installed helper binary carries no readable version metadata
// (Linux). Callers fall back to the running helper's status file.
var errBinaryVersionUnsupported = errors.New("helper binary version not readable on this platform")

// errHelperInstallNotApplied marks an install whose package manager reported
// success but whose on-disk helper binary is still not the target version
// (#6252: msiexec exit 0 with the old breeze-helper.exe left in place).
var errHelperInstallNotApplied = errors.New("helper install reported success but the on-disk version did not change")

// formatFixedFileVersion renders a Windows VS_FIXEDFILEINFO file version as
// major.minor.patch. The fourth (build) component is dropped: release builds
// stamp breeze-helper.exe as X.Y.Z.0, while the control plane and the
// downgrade guard compare three-part SemVer.
func formatFixedFileVersion(ms, ls uint32) string {
	return fmt.Sprintf("%d.%d.%d", ms>>16, ms&0xffff, ls>>16)
}

// parsePlistShortVersion extracts CFBundleShortVersionString from an XML
// property list (the Info.plist Tauri writes into Breeze Helper.app). A
// binary plist, or one without the key, is an error so the caller falls back.
func parsePlistShortVersion(data []byte) (string, error) {
	if bytes.HasPrefix(data, []byte("bplist")) {
		return "", errors.New("binary plist not supported")
	}
	dec := xml.NewDecoder(bytes.NewReader(data))
	var (
		inKey      bool
		inString   bool
		lastKey    string
		wantString bool
	)
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "key":
				inKey = true
				lastKey = ""
			case "string":
				inString = true
			default:
				wantString = false
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "key":
				inKey = false
				wantString = strings.TrimSpace(lastKey) == "CFBundleShortVersionString"
			case "string":
				inString = false
			}
		case xml.CharData:
			if inKey {
				lastKey += string(t)
			} else if inString && wantString {
				if v := strings.TrimSpace(string(t)); v != "" {
					return v, nil
				}
			}
		}
	}
	return "", errors.New("CFBundleShortVersionString not found in Info.plist")
}

// helperVersionsMatch reports whether the on-disk helper version satisfies an
// install of target. Release builds strip the prerelease suffix before
// stamping the helper binary (release.yml "Inject version into helper
// config"), so only the major.minor.patch core of target is compared.
func helperVersionsMatch(onDisk, target string) bool {
	d, ok := versionpolicy.Normalize(onDisk)
	if !ok {
		return false
	}
	t, ok := versionpolicy.Normalize(target)
	if !ok {
		return false
	}
	return versionCore(d) == versionCore(t)
}

func versionCore(normalized string) string {
	if i := strings.IndexAny(normalized, "-+"); i >= 0 {
		return normalized[:i]
	}
	return normalized
}
