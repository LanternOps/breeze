package observe

import (
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
)

// Lenovo observe (O4c). Passive: tool and app presence from the file system,
// then one GET of Lenovo's per-MTM catalog, parsed here, in Go, bounded. No
// package descriptor (<location>) and no installer is ever fetched or run.

const (
	lenovoCatalogBase = "https://download.lenovo.com/catalog/"
	// maxLenovoCatalog bounds the catalog read. A real per-MTM catalog is tens of
	// KiB; past this the counts cover what was read and truncated is set.
	maxLenovoCatalog = 512 << 10
	// maxCategoryText bounds one <category>'s text while it is read.
	maxCategoryText = 1 << 10

	stepLenovoCatalog   = "lenovo_catalog"
	stepLenovoConflicts = "lenovo_conflicts"

	// Commercial Vantage and Lenovo Vantage are Appx packages under WindowsApps.
	vantagePrefix           = "E046963F.LenovoCompanion_"
	commercialVantagePrefix = "E046963F.LenovoSettingsforEnterprise_"
)

var (
	lenovoMaker = regexp.MustCompile(`(?i)^lenovo$`)
	utf8BOM     = []byte{0xEF, 0xBB, 0xBF}
)

func (c *collector) lenovo() {
	l := c.r.Lenovo
	l.MachineType = lenovoMachineType(c.bios.SystemProductName)
	l.Family = lenovoFamily(c.bios.SystemFamily, c.bios.SystemVersion, c.biosOK)

	c.lenovoTools()
	c.lenovoConflicts()
	l.Catalog = c.lenovoCatalog(l.MachineType)
}

// lenovoMachineType is the MTM: the model's first four characters, upper case.
// It is validated here, before any URL is built from it.
func lenovoMachineType(model string) *string {
	m := strings.TrimSpace(model)
	if len(m) < 4 {
		return nil
	}
	mtm := strings.ToUpper(m[:4])
	if !machineTypeRe.MatchString(mtm) {
		return nil
	}
	return &mtm
}

func lenovoFamily(family, version string, read bool) string {
	if !read {
		return "unknown"
	}
	text := strings.ToLower(family + " " + version)
	for _, f := range []string{"thinkpad", "thinkcentre", "thinkstation", "ideapad"} {
		if strings.Contains(text, f) {
			return f
		}
	}
	if strings.TrimSpace(family) == "" && strings.TrimSpace(version) == "" {
		return "unknown"
	}
	return "other"
}

func (c *collector) lenovoTools() {
	r := c.r
	if x86 := c.programFilesX86(); x86 != "" {
		if t, ok := c.exeTool(ToolLenovoSystemUpdate, winJoin(x86, "Lenovo", "System Update", "tvsu.exe")); ok {
			r.Tools = append(r.Tools, t)
			// System Update is also a resident app that schedules its own runs.
			r.Conflicts = append(r.Conflicts, Conflict{Name: ConflictLenovoSystemUpdate, Version: t.Version})
		}
		if t, ok := c.exeTool(ToolLenovoThinInstaller, winJoin(x86, "Lenovo", "ThinInstaller", "ThinInstaller.exe")); ok {
			r.Tools = append(r.Tools, t)
		}
	}
	modules := c.psModules()
	for _, m := range []struct{ tool, module string }{
		{ToolLenovoLSUClient, "LSUClient"},
		{ToolLenovoClientUpdate, "Lenovo.Client.Update"},
	} {
		if t, ok := c.moduleTool(m.tool, modules, m.module); ok {
			r.Tools = append(r.Tools, t)
		}
	}
}

// lenovoConflicts looks for the Vantage Appx packages by directory name only.
func (c *collector) lenovoConflicts() {
	r := c.r
	pf := c.programFiles()
	if pf == "" || c.host.ListDirs == nil {
		r.addError(stepLenovoConflicts, codeUnavailable)
		return
	}
	names, err := c.host.ListDirs(winJoin(pf, "WindowsApps"))
	if err != nil {
		r.addError(stepLenovoConflicts, "windows_apps_unreadable")
		return
	}
	for _, app := range []struct{ name, prefix string }{
		{ConflictLenovoVantage, vantagePrefix},
		{ConflictLenovoCommercialVantage, commercialVantagePrefix},
	} {
		found, version := appxVersion(names, app.prefix)
		if found {
			r.Conflicts = append(r.Conflicts, Conflict{Name: app.name, Version: version})
		}
	}
}

// appxVersion finds <prefix><version>_<arch>__<publisherId> package directories
// and returns the highest version among them.
func appxVersion(names []string, prefix string) (bool, *string) {
	found := false
	var versions []string
	for _, n := range names {
		if !strings.HasPrefix(strings.ToLower(n), strings.ToLower(prefix)) {
			continue
		}
		found = true
		rest := n[len(prefix):]
		if i := strings.IndexByte(rest, '_'); i > 0 {
			versions = append(versions, rest[:i])
		}
	}
	if v := highestVersion(versions); v != "" {
		return found, &v
	}
	return found, nil
}

// lenovoCatalog makes the one catalog read. No machine type, a machine that is
// not Lenovo's, or no Windows build: no request at all.
func (c *collector) lenovoCatalog(mtm *string) *LenovoCatalog {
	r := c.r
	if mtm == nil {
		r.addError(stepLenovoCatalog, "machine_type_invalid")
		return nil
	}
	if !lenovoMaker.MatchString(strings.TrimSpace(c.bios.SystemManufacturer)) {
		r.addError(stepLenovoCatalog, "not_lenovo")
		return nil
	}
	build, ok := c.buildNumber()
	if !ok {
		r.addError(stepLenovoCatalog, "os_build_unknown")
		return nil
	}
	windows := "10"
	if build >= 22000 {
		windows = "11"
	}
	cat := &LenovoCatalog{Windows: new(windows), Categories: []Category{}}
	if c.host.Net == nil {
		r.addError(stepLenovoCatalog, codeUnavailable)
		return cat
	}
	url := lenovoCatalogBase + *mtm + "_Win" + windows + ".xml"
	status, body, truncated, err := c.host.Net.Get(c.ctx, url, maxLenovoCatalog)
	if err != nil {
		r.addError(stepLenovoCatalog, netCode(err))
		return cat
	}
	cat.Status = new(status)
	if status != http.StatusOK {
		return cat
	}
	counts, parseErr := parseLenovoCatalog(body)
	cat.PackageCount, cat.Categories, cat.BIOSListed = counts.packages, counts.categories, counts.biosListed
	cat.Truncated = truncated
	// A body cut at the bound ends mid-element; that parse error is expected.
	if parseErr != nil && !truncated {
		r.addError(stepLenovoCatalog, "catalog_parse_failed")
	}
	return cat
}

type lenovoCounts struct {
	packages   int
	categories []Category
	biosListed bool
}

// parseLenovoCatalog streams <packages><package><category>…</category></package>.
// Only category text is read; <location> and <checksum> are skipped. The
// encoding/xml decoder resolves no external entity. Counts cover every package
// whose end tag was read, so a cut body still reports what it holds.
func parseLenovoCatalog(body []byte) (lenovoCounts, error) {
	// Real catalogs start with a BOM. encoding/xml currently passes it through as
	// leading character data, which this parser ignores; it is stripped anyway so
	// the parse does not rest on that.
	body = bytes.TrimPrefix(body, utf8BOM)
	dec := xml.NewDecoder(bytes.NewReader(body))
	dec.Strict = true
	byName := map[string]int{}
	out := lenovoCounts{}
	var (
		depth, packageDepth int
		inCategory          bool
		category            strings.Builder
		pkgCategory         string
		parseErr            error
	)
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			parseErr = err
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			depth++
			switch {
			case t.Name.Local == "package" && packageDepth == 0:
				packageDepth, pkgCategory = depth, ""
			case t.Name.Local == "category" && packageDepth != 0 && depth == packageDepth+1:
				inCategory = true
				category.Reset()
			}
		case xml.CharData:
			if inCategory && category.Len()+len(t) <= maxCategoryText {
				category.Write(t)
			}
		case xml.EndElement:
			switch {
			case inCategory && t.Name.Local == "category":
				inCategory = false
				pkgCategory = category.String()
			case packageDepth != 0 && depth == packageDepth:
				packageDepth = 0
				out.packages++
				name := cleanText(pkgCategory, maxCategoryName)
				if name != "" {
					byName[name]++
					if strings.Contains(strings.ToLower(name), "bios") {
						out.biosListed = true
					}
				}
			}
			depth--
		}
	}
	out.categories = make([]Category, 0, len(byName))
	for name, n := range byName {
		out.categories = append(out.categories, Category{Name: name, Count: n})
	}
	sort.Slice(out.categories, func(i, j int) bool {
		a, b := out.categories[i], out.categories[j]
		if a.Count != b.Count {
			return a.Count > b.Count
		}
		return a.Name < b.Name
	})
	if parseErr != nil {
		return out, errors.New("lenovo catalog: malformed xml")
	}
	return out, nil
}
