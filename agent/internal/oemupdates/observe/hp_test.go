package observe

import (
	"net/http"
	"slices"
	"testing"
)

func hpBIOS() BIOSInfo {
	return BIOSInfo{
		SystemManufacturer: "HP",
		SystemProductName:  "HP Laptop 15-fd0xxx",
		SystemSKU:          "8F2X1UA#ABA",
		SystemFamily:       "103C_5335KV HP Laptop",
		BaseBoardProduct:   "8C9F",
		BIOSVersion:        "F.12",
		BIOSReleaseDate:    "03/10/2025",
	}
}

func collectHP(t *testing.T, host Host) Result {
	t.Helper()
	r := Collect(t.Context(), host, Request{Lane: LaneHP, ObserveLevel: LevelPassive}, "0.131.0")
	mustValid(t, r)
	return r
}

var hpiaAgentPath = fakeDataDir + `\oemupdates\hp-image-assistant\HPImageAssistant.exe`

// TestHpObserveNeverRunsHpia: HPIA in the agent-owned directory is reported by
// presence, version and signature, all reads. The Host has no seam that could
// run it (observe_structure_test.go), so this pins which paths the reads touch:
// only the agent-owned copy, never one elsewhere.
func TestHpObserveNeverRunsHpia(t *testing.T) {
	elsewhere := fakeProgramFiles + `\HP\HPIA\HPImageAssistant.exe`
	files := &fakeFS{
		files:  map[string]string{hpiaAgentPath: "5.3.3.0", elsewhere: "5.2.0.0"},
		signed: map[string]string{hpiaAgentPath: "HP Inc."},
	}
	var touched []string
	host := healthyHost(t, hpBIOS(), files)
	read := host.FileVersion
	host.FileVersion = func(p string) (string, error) { touched = append(touched, p); return read(p) }
	sign := host.Signer
	host.Signer = func(p string) (string, error) { touched = append(touched, p); return sign(p) }

	r := collectHP(t, host)
	var hpia *Tool
	for i := range r.Tools {
		if r.Tools[i].Name == ToolHPIA {
			if hpia != nil {
				t.Fatal("HPIA reported twice; a copy outside the agent directory must be ignored")
			}
			hpia = &r.Tools[i]
		}
	}
	if hpia == nil || hpia.Location != LocationAgentDir || hpia.Version == nil || *hpia.Version != "5.3.3.0" ||
		hpia.SignatureValid == nil || !*hpia.SignatureValid || *hpia.Publisher != "HP Inc." {
		t.Fatalf("hpia = %+v", hpia)
	}
	for _, p := range touched {
		if p != hpiaAgentPath {
			t.Fatalf("observe read %q; only the agent-owned HPIA is looked at", p)
		}
	}
}

func TestHpCMSLVersionFromModuleDirectory(t *testing.T) {
	files := &fakeFS{dirs: map[string][]string{fakeProgramFiles + `\WindowsPowerShell\Modules\HPCMSL`: {"1.7.2", "1.8.1", "1.10.0", "bad.dir"}}}
	r := collectHP(t, healthyHost(t, hpBIOS(), files))
	i := slices.IndexFunc(r.Tools, func(tl Tool) bool { return tl.Name == ToolHPCMSL })
	if i < 0 {
		t.Fatalf("tools = %+v", r.Tools)
	}
	cmsl := r.Tools[i]
	if cmsl.Version == nil || *cmsl.Version != "1.10.0" || cmsl.Location != LocationProgramFiles || cmsl.SignatureValid != nil {
		t.Fatalf("cmsl = %+v", cmsl)
	}
}

func TestHpCatalogHeadOnly(t *testing.T) {
	v := newVendorServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead {
			t.Errorf("method = %s, want HEAD", r.Method)
		}
		if r.URL.Path != "/ref/8c9f/8c9f_64_11.0.23h2.cab" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusNotFound)
	})
	host := healthyHost(t, hpBIOS(), nil)
	host.Net = v.client(t)
	r := collectHP(t, host)
	if got := v.requests(); len(got) != 1 || got[0] != "HEAD hpia.hpcloud.hp.com /ref/8c9f/8c9f_64_11.0.23h2.cab" {
		t.Fatalf("requests = %v", got)
	}
	pc := r.HP.PlatformCatalog
	if pc == nil || pc.Status == nil || *pc.Status != 404 {
		t.Fatalf("platformCatalog = %+v", pc)
	}
}

func TestHpCatalogURL(t *testing.T) {
	win10 := OSVersion{CurrentBuild: "19045", DisplayVersion: "22H2", ReleaseID: "2009"}
	old10 := OSVersion{CurrentBuild: "19041", ReleaseID: "2004"}
	win11 := OSVersion{CurrentBuild: "26100", DisplayVersion: "24H2"}
	cases := []struct {
		board string
		os    OSVersion
		url   string
		code  string
	}{
		{"83B2", win10, "https://hpia.hpcloud.hp.com/ref/83b2/83b2_64_10.0.22h2.cab", ""},
		{"83b2", old10, "https://hpia.hpcloud.hp.com/ref/83b2/83b2_64_10.0.2004.cab", ""},
		{"8C9F", win11, "https://hpia.hpcloud.hp.com/ref/8c9f/8c9f_64_11.0.24h2.cab", ""},
		{"8C9", win11, "", "platform_id_invalid"},
		{"8C9G", win11, "", "platform_id_invalid"},
		{"../x", win11, "", "platform_id_invalid"},
		{"8C9F", OSVersion{CurrentBuild: "26100", DisplayVersion: "24H2/../x"}, "", "os_release_invalid"},
		{"8C9F", OSVersion{CurrentBuild: "abc"}, "", "os_build_unknown"},
	}
	for _, c := range cases {
		url, code := hpCatalogURL(c.board, c.os, true)
		if url != c.url || code != c.code {
			t.Errorf("hpCatalogURL(%q, %+v) = %q %q, want %q %q", c.board, c.os, url, code, c.url, c.code)
		}
	}
}

// TestHpInvalidBaseboardNoRequest: no valid platform id, or not an HP, means
// no probe and a null platformCatalog.
func TestHpInvalidBaseboardNoRequest(t *testing.T) {
	for name, mutate := range map[string]func(*BIOSInfo){
		"baseboard not hex4": func(b *BIOSInfo) { b.BaseBoardProduct = "Surface Laptop" },
		"not hp":             func(b *BIOSInfo) { b.SystemManufacturer = "HPE" },
	} {
		t.Run(name, func(t *testing.T) {
			v := newVendorServer(t, func(w http.ResponseWriter, r *http.Request) { t.Errorf("unexpected %s %s", r.Method, r.URL.Path) })
			bios := hpBIOS()
			mutate(&bios)
			host := healthyHost(t, bios, nil)
			host.Net = v.client(t)
			r := collectHP(t, host)
			if len(v.requests()) != 0 || r.HP.PlatformCatalog != nil {
				t.Fatalf("requests %v platformCatalog %+v", v.requests(), r.HP.PlatformCatalog)
			}
		})
	}
}

func TestHpCatalogNetworkErrorIsNullStatus(t *testing.T) {
	v := newVendorServer(t, func(http.ResponseWriter, *http.Request) {})
	host := healthyHost(t, hpBIOS(), nil)
	host.Net = v.client(t)
	v.srv.Close()
	r := collectHP(t, host)
	if pc := r.HP.PlatformCatalog; pc == nil || pc.Status != nil || !hasError(r, stepHPCatalog, "network_error") {
		t.Fatalf("platformCatalog %+v errors %+v", pc, r.Errors)
	}
}

func TestHpInstrumentedBiosAbsentRecorded(t *testing.T) {
	type answer struct {
		exists bool
		err    error
	}
	cases := map[string]struct {
		hp, ib answer
		want   *bool
		code   bool
	}{
		"consumer: no root\\HP":     {hp: answer{false, nil}, want: new(false)},
		"root\\HP without the BIOS": {hp: answer{true, nil}, ib: answer{false, nil}, want: new(false)},
		"business BIOS":             {hp: answer{true, nil}, ib: answer{true, nil}, want: new(true)},
		"wmi fails":                 {hp: answer{false, errFake}, want: nil, code: true},
		"wmi fails on the child":    {hp: answer{true, nil}, ib: answer{false, errFake}, want: nil, code: true},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			host := healthyHost(t, hpBIOS(), nil)
			host.WMINamespaceExists = func(parent, name string) (bool, error) {
				switch {
				case parent == "root" && name == "HP":
					return c.hp.exists, c.hp.err
				case parent == `root\HP` && name == "InstrumentedBIOS":
					return c.ib.exists, c.ib.err
				}
				t.Fatalf("unexpected namespace query %s %s", parent, name)
				return false, nil
			}
			r := collectHP(t, host)
			got := r.HP.InstrumentedBIOSNamespace
			if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
				t.Fatalf("instrumentedBiosNamespace = %v, want %v", got, c.want)
			}
			if hasError(r, stepHPWMI, "wmi_unavailable") != c.code {
				t.Fatalf("errors = %+v", r.Errors)
			}
		})
	}
}

func TestHpSupportAssistantConflict(t *testing.T) {
	host := healthyHost(t, hpBIOS(), nil)
	host.ProgramEntries = func() ([]ProgramEntry, error) {
		return []ProgramEntry{
			{DisplayName: "HP Support Assistant Notifications", DisplayVersion: "1.0"},
			{DisplayName: "Contoso HP Support Assistant Helper", DisplayVersion: "2.0"},
			{DisplayName: "HP Support Assistant", DisplayVersion: "9.40.48.0"},
		}, nil
	}
	r := collectHP(t, host)
	if len(r.Conflicts) != 1 || r.Conflicts[0].Name != ConflictHPSupportAssistant ||
		r.Conflicts[0].Version == nil || *r.Conflicts[0].Version != "9.40.48.0" {
		t.Fatalf("conflicts = %+v, want HP Support Assistant 9.40.48.0 by exact name", r.Conflicts)
	}
	host.ProgramEntries = func() ([]ProgramEntry, error) { return nil, errFake }
	r = collectHP(t, host)
	if len(r.Conflicts) != 0 || !hasError(r, stepHPConflicts, "programs_unreadable") {
		t.Fatalf("conflicts %+v errors %+v", r.Conflicts, r.Errors)
	}
}
