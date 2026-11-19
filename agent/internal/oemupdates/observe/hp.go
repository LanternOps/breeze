package observe

import (
	"regexp"
	"strconv"
	"strings"
)

// HP observe (O4b). Passive: HPIA in the agent-owned directory only (the HP
// lane's own availability rule), CMSL's module directory, the business-BIOS WMI
// namespace, HP Support Assistant in the Uninstall keys, and one HEAD to HP's
// HPIA reference catalog. HPIA is never run and a copy anywhere else is never
// looked for, as the lane itself ignores one.

// The HP lane's HPIA location under the agent data directory. These equal the
// root package's storeDirName, hpToolDirName and hpToolExe; observe cannot
// import that package, so observe_parity_test.go in it pins them.
const (
	HPIAStoreDir = "oemupdates"
	HPIAToolDir  = "hp-image-assistant"
	HPIAExe      = "HPImageAssistant.exe"
)

const (
	hpCatalogBase   = "https://hpia.hpcloud.hp.com/ref/"
	hpCMSLModule    = "HPCMSL"
	hpWMIParent     = `root\HP`
	hpWMINamespace  = "InstrumentedBIOS"
	stepHPCatalog   = "hp_catalog"
	stepHPWMI       = "hp_wmi"
	stepHPConflicts = "hp_conflicts"
)

var (
	// hpMaker is the HP lane's rule on the whole trimmed string: HPE is not HP.
	hpMaker           = regexp.MustCompile(`(?i)^(?:hp(?: inc\.?)?|hewlett-packard)$`)
	hpPlatformIDRe    = regexp.MustCompile(`^[0-9a-fA-F]{4}$`)
	displayVersionRe  = regexp.MustCompile(`^\d{2}h[12]$`)
	releaseIDRe       = regexp.MustCompile(`^\d{4}$`)
	hpSupportAssistRe = regexp.MustCompile(`(?i)^hp support assistant$`)
)

// IsHPManufacturer is the HP lane's manufacturer rule, for other read-only
// HP observers (HP warranty, #5511): HP, HP Inc. and Hewlett-Packard are HP;
// HPE and Hewlett Packard Enterprise are not.
func IsHPManufacturer(manufacturer string) bool {
	return hpMaker.MatchString(strings.TrimSpace(manufacturer))
}

func (c *collector) hp() {
	b := c.r.HP
	c.hpTools()
	b.InstrumentedBIOSNamespace = c.hpInstrumentedBIOS()
	c.hpConflicts()
	b.PlatformCatalog = c.hpCatalog()
}

func (c *collector) hpTools() {
	r := c.r
	if dir := c.agentDataDir(); dir != "" {
		if t, ok := c.exeTool(ToolHPIA, winJoin(dir, HPIAStoreDir, HPIAToolDir, HPIAExe)); ok {
			r.Tools = append(r.Tools, t)
		}
	}
	if t, ok := c.moduleTool(ToolHPCMSL, c.psModules(), hpCMSLModule); ok {
		r.Tools = append(r.Tools, t)
	}
}

func (c *collector) agentDataDir() string {
	if c.host.AgentDataDir == nil {
		return ""
	}
	return strings.TrimSpace(c.host.AgentDataDir())
}

// hpInstrumentedBIOS checks root\HP for an InstrumentedBIOS namespace. A
// consumer HP has no root\HP at all; that is false, not unknown.
func (c *collector) hpInstrumentedBIOS() *bool {
	if c.host.WMINamespaceExists == nil {
		c.r.addError(stepHPWMI, "wmi_unavailable")
		return nil
	}
	hp, err := c.host.WMINamespaceExists("root", "HP")
	if err != nil {
		c.r.addError(stepHPWMI, "wmi_unavailable")
		return nil
	}
	if !hp {
		return new(false)
	}
	ib, err := c.host.WMINamespaceExists(hpWMIParent, hpWMINamespace)
	if err != nil {
		c.r.addError(stepHPWMI, "wmi_unavailable")
		return nil
	}
	return new(ib)
}

func (c *collector) hpConflicts() {
	if c.host.ProgramEntries == nil {
		c.r.addError(stepHPConflicts, codeUnavailable)
		return
	}
	entries, err := c.host.ProgramEntries()
	if err != nil {
		c.r.addError(stepHPConflicts, "programs_unreadable")
		return
	}
	for _, e := range entries {
		if hpSupportAssistRe.MatchString(strings.TrimSpace(e.DisplayName)) {
			c.r.Conflicts = append(c.r.Conflicts, Conflict{Name: ConflictHPSupportAssistant, Version: optText(e.DisplayVersion, maxToolVersion)})
			return
		}
	}
}

// hpCatalog makes the one HEAD, only for an HP machine whose platform id and
// Windows release are both valid. The status is all that is kept.
func (c *collector) hpCatalog() *PlatformCatalog {
	r := c.r
	if !hpMaker.MatchString(strings.TrimSpace(c.bios.SystemManufacturer)) {
		r.addError(stepHPCatalog, "not_hp")
		return nil
	}
	url, code := hpCatalogURL(c.bios.BaseBoardProduct, c.os, c.osOK)
	if code != "" {
		r.addError(stepHPCatalog, code)
		return nil
	}
	if c.host.Net == nil {
		r.addError(stepHPCatalog, codeUnavailable)
		return nil
	}
	status, err := c.host.Net.Head(c.ctx, url)
	if err != nil {
		r.addError(stepHPCatalog, netCode(err))
		return &PlatformCatalog{}
	}
	return &PlatformCatalog{Status: new(status)}
}

// hpCatalogURL is HP's HPIA reference file for this platform and release, as
// HP CMSL names it: ref/<id>/<id>_64_<10|11>.0.<release>.cab. Every part is
// validated before the URL is built; code says which one was not.
func hpCatalogURL(baseboard string, v OSVersion, osOK bool) (string, string) {
	id := strings.TrimSpace(baseboard)
	if !hpPlatformIDRe.MatchString(id) {
		return "", "platform_id_invalid"
	}
	id = strings.ToLower(id)
	build := strings.TrimSpace(v.CurrentBuild)
	n, err := strconv.Atoi(build)
	if !osOK || !buildDigitsRe.MatchString(build) || err != nil {
		return "", "os_build_unknown"
	}
	major := "10"
	if n >= 22000 {
		major = "11"
	}
	release := strings.ToLower(strings.TrimSpace(v.DisplayVersion))
	if !displayVersionRe.MatchString(release) {
		release = strings.TrimSpace(v.ReleaseID)
		if !releaseIDRe.MatchString(release) {
			return "", "os_release_invalid"
		}
	}
	return hpCatalogBase + id + "/" + id + "_64_" + major + ".0." + release + ".cab", ""
}
