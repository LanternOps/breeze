package installer

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The six display strings an operator can brand, with today's text as the
// default. A build with no override must produce exactly today's package.
var brandingDefaults = []struct{ name, value string }{
	{"Manufacturer", "Breeze RMM"},
	{"PackageDescription", "Breeze RMM endpoint agent"},
	{"AgentServiceDisplayName", "Breeze Agent"},
	{"AgentServiceDescription", "Breeze RMM endpoint agent"},
	{"WatchdogServiceDisplayName", "Breeze RMM Watchdog"},
	{"WatchdogServiceDescription", "Monitors and recovers the Breeze RMM Agent"},
}

func readBuildMsi(t *testing.T) string {
	t.Helper()
	path := os.Getenv("BREEZE_BUILD_MSI_PATH")
	if path == "" {
		path = "build-msi.ps1"
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// serviceInstall returns the <ServiceInstall .../> element with the given Id.
func serviceInstall(t *testing.T, wxs, id string) string {
	t.Helper()
	re := regexp.MustCompile(`(?s)<ServiceInstall\s+Id="` + regexp.QuoteMeta(id) + `".*?/>`)
	el := re.FindString(wxs)
	if el == "" {
		t.Fatalf("no <ServiceInstall> with Id %q in breeze.wxs", id)
	}
	return el
}

func TestBrandingDefinesKeepTodaysText(t *testing.T) {
	wxs := readWxs(t)
	for _, d := range brandingDefaults {
		re := regexp.MustCompile(`<\?ifndef ` + d.name + `\?>\s*<\?define ` + d.name + `=` + regexp.QuoteMeta(d.value) + `\?>\s*<\?endif\?>`)
		if !re.MatchString(wxs) {
			t.Errorf("breeze.wxs must default %s to %q through ifndef/define/endif", d.name, d.value)
		}
	}
}

func TestBrandingVariablesAreUsed(t *testing.T) {
	wxs := readWxs(t)
	for _, want := range []string{
		`Manufacturer="$(var.Manufacturer)"`,
		`<SummaryInformation Description="$(var.PackageDescription)"`,
	} {
		if !strings.Contains(wxs, want) {
			t.Errorf("breeze.wxs is missing %s", want)
		}
	}
	agent := serviceInstall(t, wxs, "svcInstallBreezeAgent")
	for _, want := range []string{`DisplayName="$(var.AgentServiceDisplayName)"`, `Description="$(var.AgentServiceDescription)"`} {
		if !strings.Contains(agent, want) {
			t.Errorf("the agent <ServiceInstall> is missing %s", want)
		}
	}
	watchdog := serviceInstall(t, wxs, "svcInstallWatchdog")
	for _, want := range []string{`DisplayName="$(var.WatchdogServiceDisplayName)"`, `Description="$(var.WatchdogServiceDescription)"`} {
		if !strings.Contains(watchdog, want) {
			t.Errorf("the watchdog <ServiceInstall> is missing %s", want)
		}
	}
}

// With the defines removed, no brandable literal may be left in the package.
func TestNoBrandableLiteralLeftOutsideTheDefines(t *testing.T) {
	wxs := withoutDefines(readWxs(t))
	for _, lit := range []string{
		`Manufacturer="Breeze RMM"`,
		`Description="Breeze RMM endpoint agent"`,
		`DisplayName="Breeze Agent"`,
		`DisplayName="Breeze RMM Watchdog"`,
		`Description="Monitors and recovers the Breeze RMM Agent"`,
	} {
		if strings.Contains(wxs, lit) {
			t.Errorf("breeze.wxs still carries the literal %s outside the defines", lit)
		}
	}
}

// The service names, the product identity and the install folder are
// identifiers the updater, the API and MSI upgrades key on: branding must
// never reach them.
func TestBrandingNeverReachesTheIdentifiers(t *testing.T) {
	wxs := readWxs(t)
	if !strings.Contains(serviceInstall(t, wxs, "svcInstallBreezeAgent"), `Name="BreezeAgent"`) {
		t.Error(`the agent <ServiceInstall> must keep Name="BreezeAgent"`)
	}
	if !strings.Contains(serviceInstall(t, wxs, "svcInstallWatchdog"), `Name="BreezeWatchdog"`) {
		t.Error(`the watchdog <ServiceInstall> must keep Name="BreezeWatchdog"`)
	}
	for _, want := range []string{
		`Name="$(var.ProductName)"`,
		`UpgradeCode="$(var.UpgradeCode)"`,
		`<Directory Id="INSTALLFOLDER" Name="Breeze">`,
	} {
		if !strings.Contains(wxs, want) {
			t.Errorf("breeze.wxs must keep %s", want)
		}
	}
}

func TestBuildMsiTakesTheBrandingParameters(t *testing.T) {
	ps1 := readBuildMsi(t)
	for _, d := range brandingDefaults {
		re := regexp.MustCompile(`\[string\]\$` + d.name + `\s*=\s*""`)
		if !re.MatchString(ps1) {
			t.Errorf("build-msi.ps1 must take an optional [string]$%s parameter that defaults to empty", d.name)
		}
	}
}

func TestBuildMsiPassesNonBlankBrandingToWix(t *testing.T) {
	ps1 := readBuildMsi(t)
	for _, d := range brandingDefaults {
		re := regexp.MustCompile(`(?m)^\s+` + d.name + `\s*=\s*\$` + d.name + `\s*$`)
		if !re.MatchString(ps1) {
			t.Errorf("build-msi.ps1 must map %s into the branding defines", d.name)
		}
	}
	if !strings.Contains(ps1, `"-d", "$name=$value"`) {
		t.Error(`build-msi.ps1 must pass each non-blank brand value to wix as -d "Name=value"`)
	}
}

func TestBuildMsiValidatesBrandingValues(t *testing.T) {
	ps1 := readBuildMsi(t)
	for _, want := range []string{"Assert-BrandingValue", "256"} {
		if !strings.Contains(ps1, want) {
			t.Errorf("build-msi.ps1 must validate brand values (missing %q)", want)
		}
	}
}

// withoutDefines drops every <?define ...?> line, so only the package itself is
// left to check.
func withoutDefines(wxs string) string {
	var kept []string
	for _, line := range strings.Split(wxs, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "<?define ") {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

// A double quote is dropped silently when PowerShell passes the value on to
// wix.exe, so the validation must refuse it.
func TestBuildMsiRefusesDoubleQuotes(t *testing.T) {
	ps1 := readBuildMsi(t)
	re := regexp.MustCompile(`-match '\[[^\]]*"[^\]]*\]'`)
	if !re.MatchString(ps1) {
		t.Error(`the build-msi.ps1 validation must refuse a double quote`)
	}
}
