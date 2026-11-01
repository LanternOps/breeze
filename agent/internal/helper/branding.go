package helper

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"unicode"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

// Runtime Helper branding (Phase 2, OD3). The server sends a decision on the
// heartbeat; the Agent persists the effective branding in each session's
// helper_config.yaml so it survives restarts and works offline. The section is
// plain YAML data the Helper reads; an older Helper ignores the extra key.

// Branding decision states sent by the server.
const (
	brandingStateSet     = "set"
	brandingStateCleared = "cleared"
	// brandingStateInvalid marks a block that could not be decoded; it is
	// rejected and never alters the stored branding.
	brandingStateInvalid = "invalid"
)

// Text limits in code points, mirroring apps/api/src/services/helperBranding.ts.
const (
	maxDisplayName    = 60
	maxCompanyName    = 60
	maxWelcomeTitle   = 120
	maxWelcomeMessage = 500
	maxSupportLabel   = 40
	maxPortalLabel    = 40
)

var hexColor = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

// BrandingValues are the closed set of branding fields. Empty means "use the
// Breeze default". No URL, image, CSS or HTML field exists by design.
type BrandingValues struct {
	DisplayName    string `json:"displayName,omitempty" yaml:"display_name,omitempty"`
	CompanyName    string `json:"companyName,omitempty" yaml:"company_name,omitempty"`
	WelcomeTitle   string `json:"welcomeTitle,omitempty" yaml:"welcome_title,omitempty"`
	WelcomeMessage string `json:"welcomeMessage,omitempty" yaml:"welcome_message,omitempty"`
	SupportLabel   string `json:"supportLabel,omitempty" yaml:"support_label,omitempty"`
	PortalLabel    string `json:"portalLabel,omitempty" yaml:"portal_label,omitempty"`
	PrimaryColor   string `json:"primaryColor,omitempty" yaml:"primary_color,omitempty"`
	AccentColor    string `json:"accentColor,omitempty" yaml:"accent_color,omitempty"`
}

// BrandingDecision is the heartbeat block. A nil decision means "not sent":
// the Agent keeps its last-known branding. ScopeID is opaque; the Agent only
// compares it.
type BrandingDecision struct {
	State   string         `json:"state"`
	ScopeID string         `json:"scopeId,omitempty"`
	Values  BrandingValues `json:"values,omitempty"`
}

// UnmarshalJSON tolerates a malformed block so it cannot fail the whole
// heartbeat response; the block is then rejected by resolveBranding.
func (d *BrandingDecision) UnmarshalJSON(b []byte) error {
	type plain BrandingDecision
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		*d = BrandingDecision{State: brandingStateInvalid}
		return nil
	}
	*d = BrandingDecision(p)
	return nil
}

// Branding is the persisted section of helper_config.yaml.
type Branding struct {
	ScopeID        string `yaml:"scope_id"`
	BrandingValues `yaml:",inline"`
}

func validText(s string, max int) bool {
	if !utf8.ValidString(s) || utf8.RuneCountInString(s) > max {
		return false
	}
	for _, r := range s {
		if r == '‌' || r == '‍' { // ZWNJ/ZWJ: needed by some scripts and emoji
			continue
		}
		if unicode.In(r, unicode.Cc, unicode.Cf, unicode.Cs, unicode.Co, unicode.Zl, unicode.Zp) {
			return false
		}
	}
	return true
}

// validate reports whether every present field is within its limits and at
// least one field is present. It never rewrites a value.
func (v BrandingValues) validate() error {
	texts := []struct {
		name  string
		value string
		max   int
	}{
		{"displayName", v.DisplayName, maxDisplayName},
		{"companyName", v.CompanyName, maxCompanyName},
		{"welcomeTitle", v.WelcomeTitle, maxWelcomeTitle},
		{"welcomeMessage", v.WelcomeMessage, maxWelcomeMessage},
		{"supportLabel", v.SupportLabel, maxSupportLabel},
		{"portalLabel", v.PortalLabel, maxPortalLabel},
	}
	for _, t := range texts {
		if t.value != "" && !validText(t.value, t.max) {
			return fmt.Errorf("invalid branding field %s", t.name)
		}
	}
	for name, c := range map[string]string{"primaryColor": v.PrimaryColor, "accentColor": v.AccentColor} {
		if c != "" && !hexColor.MatchString(c) {
			return fmt.Errorf("invalid branding field %s", name)
		}
	}
	if v == (BrandingValues{}) {
		return errors.New("branding set without any field")
	}
	return nil
}

// resolveBranding applies a heartbeat decision to the stored branding and
// returns the branding to persist. Absence never clears. An invalid decision
// is rejected: the last valid branding is kept, unless the decision names a
// different scope, in which case the old tenant's branding is dropped.
func resolveBranding(current *Branding, d *BrandingDecision) (*Branding, error) {
	if d == nil {
		return current, nil
	}
	switch d.State {
	case brandingStateCleared:
		return nil, nil
	case brandingStateSet:
		err := d.Values.validate()
		if err == nil && d.ScopeID == "" {
			err = errors.New("branding set without scope")
		}
		if err != nil {
			if current != nil && d.ScopeID != "" && current.ScopeID != d.ScopeID {
				return nil, err
			}
			return current, err
		}
		return &Branding{ScopeID: d.ScopeID, BrandingValues: d.Values}, nil
	default:
		return current, fmt.Errorf("unknown branding state %q", d.State)
	}
}

func brandingEqual(a, b *Branding) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// readBranding loads the branding section from a helper_config.yaml. A missing
// file or a file without the section is (nil, nil). An unreadable file, bad
// YAML or an invalid section is (nil, err) so callers can keep the last known
// branding instead of treating a transient failure as "no branding".
func readBranding(path string) (*Branding, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var doc struct {
		Branding *Branding `yaml:"branding"`
	}
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if doc.Branding == nil {
		return nil, nil
	}
	if doc.Branding.ScopeID == "" {
		return nil, fmt.Errorf("invalid branding in %s: missing scope", path)
	}
	if err := doc.Branding.validate(); err != nil {
		return nil, fmt.Errorf("invalid branding in %s: %w", path, err)
	}
	return doc.Branding, nil
}

// ClearBranding removes the branding section from the legacy and every
// per-session helper_config.yaml under baseDir, keeping all other keys. It is
// local and does not need the control plane (re-enrollment, OD3).
func ClearBranding(baseDir string) error {
	paths := []string{filepath.Join(baseDir, "helper_config.yaml")}
	if matches, err := filepath.Glob(filepath.Join(baseDir, "sessions", "*", "helper_config.yaml")); err == nil {
		paths = append(paths, matches...)
	}
	var errs []error
	for _, p := range paths {
		if err := stripBranding(p); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func stripBranding(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read %s: %w", path, err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	if _, ok := doc["branding"]; !ok {
		return nil
	}
	delete(doc, "branding")
	out, err := yaml.Marshal(doc)
	if err != nil {
		return fmt.Errorf("marshal %s: %w", path, err)
	}
	// Unique temp name: re-enrollment runs in a separate CLI process, so it must
	// not share a temp file with the service's own writes. CreateTemp is 0600.
	f, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return fmt.Errorf("create temp for %s: %w", path, err)
	}
	tmp := f.Name()
	if _, err := f.Write(out); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("close %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename %s: %w", path, err)
	}
	return nil
}
