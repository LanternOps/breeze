package sim

import (
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const storeVersion = 1

// Identity is one enrolled simulated device.
type Identity struct {
	Index      int       `json:"index"`
	Hostname   string    `json:"hostname"`
	AgentID    string    `json:"agentId"`
	DeviceID   string    `json:"deviceId"`
	AuthToken  string    `json:"authToken"`
	OrgID      string    `json:"orgId"`
	SiteID     string    `json:"siteId"`
	EnrolledAt time.Time `json:"enrolledAt"`
}

type storeFile struct {
	Version      int        `json:"version"`
	ServerURL    string     `json:"serverUrl"`
	HostnameBase string     `json:"hostnameBase"`
	Agents       []Identity `json:"agents"`
}

// TokenStore persists one token per simulated device. Safe for concurrent use.
type TokenStore struct {
	mu       sync.Mutex
	file     storeFile
	byIndex  map[int]int
	reenroll int
}

func randomTag() string {
	b := make([]byte, 3)
	_, _ = crand.Read(b)
	return hex.EncodeToString(b)
}

// LoadStore reads path, or starts an empty store when it does not exist. A
// store written for another server is refused: its tokens must never be sent
// anywhere else.
func LoadStore(path, serverURL, prefix string) (*TokenStore, error) {
	s := &TokenStore{byIndex: map[int]int{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		s.file = storeFile{Version: storeVersion, ServerURL: serverURL, HostnameBase: prefix + "-" + randomTag()}
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &s.file); err != nil {
		return nil, fmt.Errorf("token store %s: %w", path, err)
	}
	if s.file.Version != storeVersion {
		return nil, fmt.Errorf("token store %s: version %d, want %d", path, s.file.Version, storeVersion)
	}
	if s.file.ServerURL != serverURL {
		return nil, fmt.Errorf("token store %s belongs to %s, not %s; pass another --store", path, s.file.ServerURL, serverURL)
	}
	for i, id := range s.file.Agents {
		s.byIndex[id.Index] = i
	}
	return s, nil
}

func (s *TokenStore) HostnameBase() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.file.HostnameBase
}

func (s *TokenStore) Hostname(index int) string {
	return fmt.Sprintf("%s-%05d", s.HostnameBase(), index)
}

// ReenrollHostname is a never-repeating hostname for re-enrolling index after
// its stored token was rejected (the old row may still exist under the old
// hostname).
func (s *TokenStore) ReenrollHostname(index int) string {
	s.mu.Lock()
	s.reenroll++
	n := s.reenroll
	s.mu.Unlock()
	return fmt.Sprintf("%s-r%d%s", s.Hostname(index), n, randomTag())
}

func (s *TokenStore) Get(index int) (Identity, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i, ok := s.byIndex[index]
	if !ok {
		return Identity{}, false
	}
	return s.file.Agents[i], true
}

func (s *TokenStore) Put(id Identity) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if i, ok := s.byIndex[id.Index]; ok {
		s.file.Agents[i] = id
		return
	}
	s.byIndex[id.Index] = len(s.file.Agents)
	s.file.Agents = append(s.file.Agents, id)
}

// Missing counts indices in [0, n) with no stored identity.
func (s *TokenStore) Missing(n int) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	missing := 0
	for i := 0; i < n; i++ {
		if _, ok := s.byIndex[i]; !ok {
			missing++
		}
	}
	return missing
}

// Save writes the store atomically with mode 0600 (it holds bearer tokens).
func (s *TokenStore) Save(path string) error {
	s.mu.Lock()
	file := s.file
	file.Agents = append([]Identity(nil), s.file.Agents...)
	s.mu.Unlock()
	sort.Slice(file.Agents, func(i, j int) bool { return file.Agents[i].Index < file.Agents[j].Index })
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tokens-*.json") // CreateTemp opens 0600
	if err != nil {
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}
