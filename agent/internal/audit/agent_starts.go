package audit

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
)

// AgentStartsAfter lists the version of every agent_start entry written after
// the entry whose hash is token, oldest first, reading the rotated backups and
// then the current file. found is false when no entry has that hash (it was
// never written, or has rotated out). A start whose line cannot be read (torn
// by a crash) is listed with version "": unknown, not skipped.
//
// The pending-restart record (#12827) uses it to learn whether an agent of
// another version started after the record's writer. Every agent version
// writes an agent_start entry with its version at start, so the answer does
// not depend on the older agent knowing about the record.
func (l *Logger) AgentStartsAfter(token string) ([]string, bool, error) {
	if l == nil {
		return nil, false, errors.New("the audit log is disabled")
	}
	if token == "" {
		return nil, false, nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	var versions []string
	found := false
	for i := l.maxBackups; i >= 0; i-- {
		err := scanAgentStarts(l.backupName(i), token, &found, &versions)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, false, err
		}
	}
	if !found {
		return nil, false, nil
	}
	return versions, true, nil
}

var agentStartMarker = []byte(`"` + EventAgentStart + `"`)

func scanAgentStarts(path, token string, found *bool, versions *[]string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	tokenBytes := []byte(token)
	r := bufio.NewReader(f)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			if !*found {
				if bytes.Contains(line, tokenBytes) {
					var e Entry
					if json.Unmarshal(line, &e) == nil && e.EntryHash == token {
						*found = true
					}
				}
			} else if bytes.Contains(line, agentStartMarker) {
				var e Entry
				if jerr := json.Unmarshal(line, &e); jerr != nil {
					*versions = append(*versions, "")
				} else if e.EventType == EventAgentStart {
					v, _ := e.Details["version"].(string)
					*versions = append(*versions, v)
				}
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}
