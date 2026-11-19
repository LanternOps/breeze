package observe

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// dottedVersionRe is a module or package version directory name: 2 to 4 dotted
// numbers. Anything else is not a version and is ignored.
var dottedVersionRe = regexp.MustCompile(`^\d{1,9}(\.\d{1,9}){1,3}$`)

// winJoin joins Windows path parts with a backslash, on every OS, so the paths
// built here are the same in a macOS test and on the device.
func winJoin(parts ...string) string {
	out := ""
	for _, p := range parts {
		p = strings.Trim(p, `\/`)
		if p == "" {
			continue
		}
		if out == "" {
			out = p
			continue
		}
		out += `\` + p
	}
	return out
}

// classifyLocation reduces a path to a location class, because a path can
// carry a user name. Only the class ever leaves this package.
func (c *collector) classifyLocation(path string) string {
	p := normPath(path)
	under := func(base string) bool {
		b := normPath(base)
		return b != "" && strings.HasPrefix(p, b+`\`)
	}
	h := c.host
	if h.AgentDataDir != nil && under(h.AgentDataDir()) {
		return LocationAgentDir
	}
	if h.ProgramFiles != nil {
		if under(winJoin(h.ProgramFiles(), "WindowsApps")) {
			return LocationWindowsApps
		}
		if under(h.ProgramFiles()) {
			return LocationProgramFiles
		}
	}
	if h.ProgramFilesX86 != nil && under(h.ProgramFilesX86()) {
		return LocationProgramFiles
	}
	return LocationOther
}

func normPath(p string) string {
	p = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(p), "/", `\`))
	return strings.TrimRight(p, `\`)
}

// highestVersion is the highest dotted version among names, or "".
func highestVersion(names []string) string {
	best := ""
	for _, n := range names {
		if !dottedVersionRe.MatchString(n) {
			continue
		}
		if best == "" || versionLess(best, n) {
			best = n
		}
	}
	return best
}

func versionLess(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := range max(len(pa), len(pb)) {
		var x, y uint64
		if i < len(pa) {
			x, _ = strconv.ParseUint(pa[i], 10, 64)
		}
		if i < len(pb) {
			y, _ = strconv.ParseUint(pb[i], 10, 64)
		}
		if x != y {
			return x < y
		}
	}
	return false
}

// exeTool reads one tool executable: presence, version, signature, location.
// Nothing is run. ok is false when the file is absent.
func (c *collector) exeTool(name, path string) (Tool, bool) {
	h := c.host
	if h.RegularFile == nil || !h.RegularFile(path) {
		return Tool{}, false
	}
	t := Tool{Name: name, Location: c.classifyLocation(path)}
	if h.FileVersion != nil {
		if v, err := h.FileVersion(path); err == nil {
			t.Version = optText(v, maxToolVersion)
		}
	}
	if h.Signer != nil {
		publisher, err := h.Signer(path)
		switch {
		case err == nil:
			t.SignatureValid = new(true)
			t.Publisher = optText(publisher, maxPublisher)
		case errors.Is(err, ErrSignatureNotChecked):
		default:
			t.SignatureValid = new(false)
		}
	}
	return t, true
}

// moduleTool reads a PowerShell module directory: present when the module
// directory lists, with the highest version directory as its version. The
// signature is not checked (null): a module is many files, not one.
func (c *collector) moduleTool(name, modules, module string) (Tool, bool) {
	h := c.host
	if h.ListDirs == nil || modules == "" {
		return Tool{}, false
	}
	dir := winJoin(modules, module)
	versions, err := h.ListDirs(dir)
	if err != nil {
		return Tool{}, false
	}
	t := Tool{Name: name, Location: c.classifyLocation(winJoin(dir, "x"))}
	if v := highestVersion(versions); v != "" {
		t.Version = new(v)
	}
	return t, true
}

func (c *collector) programFiles() string {
	if c.host.ProgramFiles == nil {
		return ""
	}
	return strings.TrimSpace(c.host.ProgramFiles())
}

func (c *collector) programFilesX86() string {
	if c.host.ProgramFilesX86 == nil {
		return ""
	}
	return strings.TrimSpace(c.host.ProgramFilesX86())
}

func (c *collector) psModules() string {
	pf := c.programFiles()
	if pf == "" {
		return ""
	}
	return winJoin(pf, "WindowsPowerShell", "Modules")
}
