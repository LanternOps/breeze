// Package workspaceindex provides server-driven configuration and wire types
// for indexing files in configured workspaces.
package workspaceindex

import (
	"encoding/json"
	"fmt"
	"time"
)

// CrawlConfig is the server-provided configuration for workspace indexing.
type CrawlConfig struct {
	Enabled             bool           `json:"enabled"`
	PollIntervalSeconds int            `json:"pollIntervalSeconds"`
	Limits              ConfigLimits   `json:"limits"`
	Sources             []SourceConfig `json:"sources"`
}

// ConfigLimits contains server-provided crawl and upload limits.
type ConfigLimits struct {
	MaxBatchBytes    int `json:"maxBatchBytes"`
	MaxBatchEntries  int `json:"maxBatchEntries"`
	WalkOpsPerSecond int `json:"walkOpsPerSecond"`
}

// SourceConfig describes one server-configured indexing source.
type SourceConfig struct {
	ID                string     `json:"id"`
	Kind              string     `json:"kind"`
	RootPath          string     `json:"rootPath"`
	CadenceMinutes    int        `json:"cadenceMinutes"`
	ExcludeGlobs      []string   `json:"excludeGlobs"`
	HasCredential     bool       `json:"hasCredential"`
	LastCompleteRunAt *time.Time `json:"lastCompleteRunAt"`
	ActiveRun         *ActiveRun `json:"activeRun"`
	Watch             bool       `json:"watch"`
}

// ActiveRun describes a crawl run that can be started or resumed.
type ActiveRun struct {
	RunID     string    `json:"runId"`
	StartedAt time.Time `json:"startedAt"`
	Cursor    string    `json:"cursor"`
}

// Entry is the wire representation of an indexed file or directory.
type Entry struct {
	RelPath    string         `json:"relPath"`
	ParentPath string         `json:"parentPath"`
	Name       string         `json:"name"`
	IsDir      bool           `json:"isDir"`
	Size       int64          `json:"size"`
	Mtime      time.Time      `json:"mtime"`
	Ctime      *time.Time     `json:"ctime"`
	Ext        *string        `json:"ext"`
	Attrs      map[string]any `json:"attrs"`
}

// Stats summarizes one crawl run.
type Stats struct {
	Seen   int `json:"seen"`
	Errors int `json:"errors"`
}

// Credential contains a source credential returned by the server. It is
// sensitive: callers must use it only for the active connection and call Zero
// as soon as it is no longer needed.
type Credential struct {
	Username string  `json:"username"`
	Password string  `json:"password"`
	Domain   *string `json:"domain"`
}

// String returns a redacted representation.
func (Credential) String() string { return "[REDACTED]" }

// GoString returns a redacted Go-syntax representation.
func (Credential) GoString() string { return "[REDACTED]" }

// Format redacts the credential for every fmt formatting verb.
func (Credential) Format(f fmt.State, _ rune) { _, _ = fmt.Fprint(f, "[REDACTED]") }

// MarshalJSON prevents accidental serialization of credential material.
func (Credential) MarshalJSON() ([]byte, error) { return json.Marshal("[REDACTED]") }

// MarshalText prevents accidental text serialization of credential material.
func (Credential) MarshalText() ([]byte, error) { return []byte("[REDACTED]"), nil }

// Zero clears the credential fields on the receiving value. This is
// best-effort because Go strings are immutable and may have been copied.
func (c *Credential) Zero() {
	if c == nil {
		return
	}
	c.Username = ""
	c.Password = ""
	c.Domain = nil
}
