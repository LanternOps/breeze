package observe

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// vendorServer stands in for the vendor hosts. The client keeps the production
// allowlist and the real URL (host download.lenovo.com or hpia.hpcloud.hp.com);
// only the dialer is pointed at this server, so the allowlist under test is the
// one that ships.
type vendorServer struct {
	srv  *httptest.Server
	mu   sync.Mutex
	hits []string // "METHOD host path"
}

func newVendorServer(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) *vendorServer {
	t.Helper()
	v := &vendorServer{}
	v.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v.mu.Lock()
		v.hits = append(v.hits, r.Method+" "+r.Host+" "+r.URL.Path)
		v.mu.Unlock()
		handler(w, r)
	}))
	t.Cleanup(v.srv.Close)
	return v
}

func (v *vendorServer) client(t *testing.T) *Client {
	t.Helper()
	tr := v.srv.Client().Transport.(*http.Transport).Clone()
	addr := v.srv.Listener.Addr().String()
	tr.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, addr)
	}
	// The httptest certificate names example.com; the request names the vendor.
	tr.TLSClientConfig.ServerName = "example.com"
	return &Client{http: &http.Client{Transport: tr, Timeout: 5 * time.Second, CheckRedirect: noRedirect}, allow: observeHosts}
}

func (v *vendorServer) requests() []string {
	v.mu.Lock()
	defer v.mu.Unlock()
	return append([]string(nil), v.hits...)
}

func lenovoBIOS() BIOSInfo {
	return BIOSInfo{
		SystemManufacturer: "LENOVO",
		SystemProductName:  "21K5000AUS",
		SystemSKU:          "LENOVO_MT_21K5_BU_Think_FM_ThinkPad T14 Gen 5",
		SystemFamily:       "ThinkPad T14 Gen 5",
		SystemVersion:      "ThinkPad T14 Gen 5",
		BaseBoardProduct:   "21K5000AUS",
		BIOSVersion:        "N47ET21W (1.10 )",
		BIOSReleaseDate:    "05/02/2026",
	}
}

func lenovoFixture(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "lenovo", "doc-derived", "21K5_Win11.xml"))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func collectLenovo(t *testing.T, host Host) Result {
	t.Helper()
	r := Collect(t.Context(), host, Request{Lane: LaneLenovo, ObserveLevel: LevelPassive}, "0.131.0")
	mustValid(t, r)
	return r
}

func TestLenovoCatalogParseBounded(t *testing.T) {
	body := append(append([]byte{}, utf8BOM...), lenovoFixture(t)...)
	v := newVendorServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/catalog/21K5_Win11.xml" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(body)
	})
	host := healthyHost(t, lenovoBIOS(), nil)
	host.Net = v.client(t)
	r := collectLenovo(t, host)

	if got := v.requests(); len(got) != 1 || got[0] != "GET download.lenovo.com /catalog/21K5_Win11.xml" {
		t.Fatalf("requests = %v, want exactly one GET of the MTM catalog", got)
	}
	l := r.Lenovo
	if l.MachineType == nil || *l.MachineType != "21K5" || l.Family != "thinkpad" {
		t.Fatalf("machine type %v family %q", l.MachineType, l.Family)
	}
	c := l.Catalog
	if c == nil || c.Status == nil || *c.Status != 200 || c.Windows == nil || *c.Windows != "11" {
		t.Fatalf("catalog = %+v", c)
	}
	if c.PackageCount != 8 || !c.BIOSListed || c.Truncated {
		t.Fatalf("packageCount %d biosListed %v truncated %v", c.PackageCount, c.BIOSListed, c.Truncated)
	}
	want := []Category{
		{"Software and Utilities", 3},
		{"Camera and Card Reader", 2},
		{"BIOS UEFI", 1},
		{"Networking: Wireless LAN", 1},
		{"Product Firmware", 1},
	}
	if len(c.Categories) != len(want) {
		t.Fatalf("categories = %+v", c.Categories)
	}
	for i := range want {
		if c.Categories[i] != want[i] {
			t.Fatalf("categories[%d] = %+v, want %+v (count desc, then name)", i, c.Categories[i], want[i])
		}
	}
	for _, e := range r.Errors {
		if e.Step == stepLenovoCatalog {
			t.Fatalf("catalog error recorded: %+v", e)
		}
	}
}

func TestLenovoCatalogBOMHandled(t *testing.T) {
	withBOM := append(append([]byte{}, utf8BOM...), lenovoFixture(t)...)
	counts, err := parseLenovoCatalog(withBOM)
	if err != nil || counts.packages != 8 {
		t.Fatalf("with BOM: %d packages, err %v", counts.packages, err)
	}
}

func TestLenovoCatalogBoundsCategoryNamesAndCount(t *testing.T) {
	// 40 distinct long names, distinct within their first 96 characters, plus
	// one package with a blank category and one with a tab (a character
	// reference) in its name. Each name is cut to 96 and the list to 32.
	var b strings.Builder
	b.WriteString(`<packages>`)
	for i := range 40 {
		b.WriteString(`<package><category>` + string(rune('A'+i%26)) + string(rune('a'+i/26)) + strings.Repeat("n", 150) + `</category></package>`)
	}
	b.WriteString(`<package><category>  </category></package><package><category>BIOS&#9;Update</category></package></packages>`)
	counts, err := parseLenovoCatalog([]byte(b.String()))
	if err != nil {
		t.Fatal(err)
	}
	if counts.packages != 42 {
		t.Fatalf("packages = %d, want 42 (a blank category still counts as a package)", counts.packages)
	}
	if !counts.biosListed {
		t.Fatal("a category naming BIOS is listed")
	}
	for _, c := range counts.categories {
		if strings.ContainsAny(c.Name, "\t\n") || len([]rune(c.Name)) > maxCategoryName {
			t.Fatalf("category name not cleaned: %q", c.Name)
		}
	}
	r := newResult(LaneLenovo, "0.131.0")
	r.Lenovo.Catalog = &LenovoCatalog{Status: new(200), Windows: new("11"), PackageCount: counts.packages, Categories: counts.categories}
	Bound(&r)
	mustValid(t, r)
	if len(r.Lenovo.Catalog.Categories) != maxCategories || !r.Truncated {
		t.Fatalf("categories %d truncated %v", len(r.Lenovo.Catalog.Categories), r.Truncated)
	}
}

func TestLenovoCatalogOver512KiBTruncated(t *testing.T) {
	pkg := `<package><location>https://download.lenovo.com/pccbbs/mobiles/x_2_.xml</location><category>Software and Utilities</category><oslangs/><checksum type="sha256">` +
		strings.Repeat("0", 64) + `</checksum></package>`
	var b bytes.Buffer
	b.Write(utf8BOM)
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?><packages>`)
	// Literal sizes, not the constant: the bound itself is what is under test.
	for b.Len() < (512+64)<<10 {
		b.WriteString(pkg)
	}
	b.WriteString(`</packages>`)
	body := b.Bytes()
	v := newVendorServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	})
	host := healthyHost(t, lenovoBIOS(), nil)
	host.Net = v.client(t)
	r := collectLenovo(t, host)
	c := r.Lenovo.Catalog
	if c == nil || !c.Truncated {
		t.Fatalf("catalog = %+v, want truncated", c)
	}
	whole := (512 << 10) / len(pkg)
	if c.PackageCount < whole-2 || c.PackageCount > whole+1 {
		t.Fatalf("packageCount = %d, want about %d (what fits in 512 KiB)", c.PackageCount, whole)
	}
	if hasError(r, stepLenovoCatalog, "catalog_parse_failed") {
		t.Fatal("a cut body must not be reported as a parse failure")
	}
}

// TestLenovoNeverFetchesPackageXml: the catalog names every package's own
// descriptor; none of them is requested, and a redirect is not followed.
func TestLenovoNeverFetchesPackageXml(t *testing.T) {
	fixture := lenovoFixture(t)
	for _, redirect := range []bool{false, true} {
		v := newVendorServer(t, func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.URL.Path == "/catalog/21K5_Win11.xml" && redirect:
				http.Redirect(w, r, "https://download.lenovo.com/pccbbs/mobiles/x0000aa01_2_.xml", http.StatusFound)
			case r.URL.Path == "/catalog/21K5_Win11.xml":
				_, _ = w.Write(fixture)
			default:
				t.Errorf("observe fetched %s %s", r.Method, r.URL.Path)
				http.NotFound(w, r)
			}
		})
		host := healthyHost(t, lenovoBIOS(), nil)
		host.Net = v.client(t)
		r := collectLenovo(t, host)
		if got := v.requests(); len(got) != 1 {
			t.Fatalf("redirect=%v: requests = %v, want one", redirect, got)
		}
		if redirect {
			c := r.Lenovo.Catalog
			if c == nil || c.Status == nil || *c.Status != http.StatusFound || c.PackageCount != 0 {
				t.Fatalf("redirect: catalog = %+v, want status 302 and no counts", c)
			}
		}
	}
}

func TestIdeaPadCatalog404Recorded(t *testing.T) {
	v := newVendorServer(t, func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	bios := lenovoBIOS()
	bios.SystemProductName, bios.SystemFamily, bios.SystemVersion = "82XQ00ABUS", "IdeaPad Slim 5 16IRL8", "IdeaPad Slim 5 16IRL8"
	host := healthyHost(t, bios, nil)
	host.OSVersion = func() (OSVersion, error) {
		return OSVersion{Major: 10, Minor: 0, HasMajorMinor: true, CurrentBuild: "19045", DisplayVersion: "22H2"}, nil
	}
	host.Net = v.client(t)
	r := collectLenovo(t, host)
	if got := v.requests(); len(got) != 1 || got[0] != "GET download.lenovo.com /catalog/82XQ_Win10.xml" {
		t.Fatalf("requests = %v", got)
	}
	l := r.Lenovo
	if l.Family != "ideapad" {
		t.Fatalf("family = %q", l.Family)
	}
	c := l.Catalog
	if c == nil || c.Status == nil || *c.Status != 404 || *c.Windows != "10" || c.PackageCount != 0 || len(c.Categories) != 0 || c.BIOSListed {
		t.Fatalf("catalog = %+v, want 404 with zero counts", c)
	}
}

// TestLenovoMachineTypeValidatedBeforeURL: a model that does not give a clean
// MTM, or a machine that is not Lenovo's, makes no request at all.
func TestLenovoMachineTypeValidatedBeforeURL(t *testing.T) {
	for name, mutate := range map[string]func(*BIOSInfo){
		"path in model": func(b *BIOSInfo) { b.SystemProductName = "../x" },
		"short model":   func(b *BIOSInfo) { b.SystemProductName = "21K" },
		"query in mtm":  func(b *BIOSInfo) { b.SystemProductName = "21?5000AUS" },
		"not lenovo":    func(b *BIOSInfo) { b.SystemManufacturer = "LENOVO-ISH" },
	} {
		t.Run(name, func(t *testing.T) {
			v := newVendorServer(t, func(w http.ResponseWriter, r *http.Request) { t.Errorf("unexpected request %s", r.URL.Path) })
			bios := lenovoBIOS()
			mutate(&bios)
			host := healthyHost(t, bios, nil)
			host.Net = v.client(t)
			r := collectLenovo(t, host)
			if len(v.requests()) != 0 || r.Lenovo.Catalog != nil {
				t.Fatalf("requests %v catalog %+v", v.requests(), r.Lenovo.Catalog)
			}
		})
	}
}

func TestLenovoNetworkErrorRecordsNullStatus(t *testing.T) {
	v := newVendorServer(t, func(w http.ResponseWriter, r *http.Request) {})
	host := healthyHost(t, lenovoBIOS(), nil)
	host.Net = v.client(t)
	v.srv.Close()
	r := collectLenovo(t, host)
	c := r.Lenovo.Catalog
	if c == nil || c.Status != nil || !hasError(r, stepLenovoCatalog, "network_error") {
		t.Fatalf("catalog %+v errors %+v", c, r.Errors)
	}
}

func TestOffAllowlistHostRefused(t *testing.T) {
	v := newVendorServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("request reached the server: %s %s", r.Method, r.URL)
	})
	c := v.client(t)
	ctx := t.Context()
	refused := map[string]struct {
		method string
		url    string
		want   error
	}{
		"other host":              {http.MethodGet, "https://evil.example/catalog/21K5_Win11.xml", ErrHostNotAllowed},
		"suffix host":             {http.MethodGet, "https://download.lenovo.com.evil.example/catalog/x.xml", ErrHostNotAllowed},
		"http":                    {http.MethodGet, "http://download.lenovo.com/catalog/21K5_Win11.xml", ErrHostNotAllowed},
		"userinfo":                {http.MethodGet, "https://u:p@download.lenovo.com/catalog/21K5_Win11.xml", ErrHostNotAllowed},
		"other port":              {http.MethodGet, "https://download.lenovo.com:8443/catalog/21K5_Win11.xml", ErrHostNotAllowed},
		"GET on the HP host":      {http.MethodGet, "https://hpia.hpcloud.hp.com/ref/83b2/83b2_64_10.0.2009.cab", ErrMethodNotAllowed},
		"HEAD on the Lenovo host": {http.MethodHead, "https://download.lenovo.com/catalog/21K5_Win11.xml", ErrMethodNotAllowed},
	}
	for name, tc := range refused {
		t.Run(name, func(t *testing.T) {
			var err error
			if tc.method == http.MethodHead {
				_, err = c.Head(ctx, tc.url)
			} else {
				_, _, _, err = c.Get(ctx, tc.url, 1024)
			}
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
	if got := v.requests(); len(got) != 0 {
		t.Fatalf("refused requests reached the network: %v", got)
	}
}

func TestLenovoToolsAndVantageConflicts(t *testing.T) {
	files := &fakeFS{
		files: map[string]string{
			fakeProgramFilesX86 + `\Lenovo\System Update\tvsu.exe`:          "5.08.03.59",
			fakeProgramFilesX86 + `\Lenovo\ThinInstaller\ThinInstaller.exe`: "1.04.02.00024",
		},
		dirs: map[string][]string{
			fakeProgramFiles + `\WindowsPowerShell\Modules\LSUClient`:            {"1.6.2", "1.7.1", "notes"},
			fakeProgramFiles + `\WindowsPowerShell\Modules\Lenovo.Client.Update`: {"1.0.7"},
			fakeProgramFiles + `\WindowsApps`: {
				"Microsoft.WindowsCalculator_11.2401.0.0_x64__8wekyb3d8bbwe",
				"E046963F.LenovoSettingsforEnterprise_10.2401.29.0_x64__k1h2ywk1493x8",
				"E046963F.LenovoSettingsforEnterprise_10.2312.1.0_x64__k1h2ywk1493x8",
			},
		},
		signed: map[string]string{fakeProgramFilesX86 + `\Lenovo\System Update\tvsu.exe`: "Lenovo"},
	}
	host := healthyHost(t, lenovoBIOS(), files)
	r := collectLenovo(t, host)

	tools := map[string]Tool{}
	for _, tl := range r.Tools {
		tools[tl.Name] = tl
	}
	su := tools[ToolLenovoSystemUpdate]
	if su.Version == nil || *su.Version != "5.08.03.59" || su.SignatureValid == nil || !*su.SignatureValid || su.Publisher == nil || *su.Publisher != "Lenovo" || su.Location != LocationProgramFiles {
		t.Fatalf("system update = %+v", su)
	}
	ti := tools[ToolLenovoThinInstaller]
	if ti.SignatureValid == nil || *ti.SignatureValid || ti.Publisher != nil {
		t.Fatalf("thin installer with a bad signature = %+v", ti)
	}
	if v := tools[ToolLenovoLSUClient].Version; v == nil || *v != "1.7.1" {
		t.Fatalf("lsuclient version %v", v)
	}
	if lcu := tools[ToolLenovoClientUpdate]; lcu.Version == nil || *lcu.Version != "1.0.7" || lcu.SignatureValid != nil {
		t.Fatalf("lcu = %+v", lcu)
	}
	conflicts := map[string]*string{}
	for _, c := range r.Conflicts {
		conflicts[c.Name] = c.Version
	}
	if v, ok := conflicts[ConflictLenovoCommercialVantage]; !ok || v == nil || *v != "10.2401.29.0" {
		t.Fatalf("commercial vantage = %v (present %v)", v, ok)
	}
	if _, ok := conflicts[ConflictLenovoVantage]; ok {
		t.Fatal("consumer Vantage reported though absent")
	}
	if v, ok := conflicts[ConflictLenovoSystemUpdate]; !ok || v == nil {
		t.Fatal("System Update must also be reported as a resident conflict")
	}
}

func TestLenovoWindowsAppsUnreadableRecorded(t *testing.T) {
	host := healthyHost(t, lenovoBIOS(), &fakeFS{})
	r := collectLenovo(t, host)
	if !hasError(r, stepLenovoConflicts, "windows_apps_unreadable") {
		t.Fatalf("errors = %+v", r.Errors)
	}
}
