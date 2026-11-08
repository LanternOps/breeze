package backup

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// decodeSnapshotManifestFile decodes the manifest at path with
// decodeSnapshotManifest. In attested mode the caller has already checked the
// file against its attested size and SHA-256; nothing here re-checks it.
func decodeSnapshotManifestFile(path string, keep func(*SnapshotFile) bool) (*Snapshot, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open manifest: %w", err)
	}
	defer func() { _ = f.Close() }()
	return decodeSnapshotManifest(f, keep)
}

// decodeSnapshotManifest decodes a snapshot manifest from r without holding
// the encoded file list in memory (#11234): the "files" array is read one
// entry at a time, and when keep is non-nil only the entries it accepts are
// retained, so a restore of a few selected paths from a million-entry
// snapshot holds those few entries, not the whole list. A nil keep retains
// every entry.
//
// The result matches json.Unmarshal into a Snapshot for the same bytes
// (filtered by keep), and it fails on the same inputs, with one exception: a
// repeated "files" key restarts the list with fresh entries, where
// json.Unmarshal decodes the repeat into the earlier entries in place and
// keeps their fields (see decodeManifestFiles; the agent never writes one).
// The parity test pins the inputs it lists. A json.Decoder's Decode of the
// whole object would not help: it buffers a complete top-level value before
// decoding it.
func decodeSnapshotManifest(r io.Reader, keep func(*SnapshotFile) bool) (*Snapshot, error) {
	dec := json.NewDecoder(r)
	var snapshot Snapshot

	tok, err := dec.Token()
	if err != nil {
		return nil, manifestTokenError(err)
	}
	switch tok {
	case nil:
		// A top-level null leaves the Snapshot zero, as json.Unmarshal does.
	case json.Delim('{'):
		if err := decodeManifestObject(dec, &snapshot, keep); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("manifest is not a JSON object (starts with %v)", tok)
	}

	// json.Unmarshal rejects anything but whitespace after the value.
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("invalid manifest JSON: data after the top-level value")
		}
		return nil, err
	}
	return &snapshot, nil
}

// decodeManifestObject decodes the members of the top-level object, whose
// opening brace has been read, through its closing brace.
func decodeManifestObject(dec *json.Decoder, snapshot *Snapshot, keep func(*SnapshotFile) bool) error {
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return manifestTokenError(err)
		}
		key, ok := tok.(string)
		if !ok {
			return fmt.Errorf("invalid manifest JSON: object key is %v", tok)
		}
		// json.Unmarshal matches object keys to fields case-insensitively;
		// strings.EqualFold applies the same simple Unicode folding.
		if strings.EqualFold(key, "files") {
			if err := decodeManifestFiles(dec, snapshot, keep); err != nil {
				return err
			}
			continue
		}
		if err := decodeManifestMember(dec, snapshot, key); err != nil {
			return err
		}
	}
	if _, err := dec.Token(); err != nil { // the closing '}'
		return manifestTokenError(err)
	}
	return nil
}

// decodeManifestMember decodes one top-level member other than "files" into
// snapshot. The value is re-wrapped as a one-member object and handed to
// json.Unmarshal, so every other Snapshot field — present or added later —
// decodes exactly as it always has (tags, case folding, unknown keys ignored)
// without this file listing them. Each member is buffered whole; they are
// small next to the file list.
func decodeManifestMember(dec *json.Decoder, snapshot *Snapshot, key string) error {
	var value json.RawMessage
	if err := dec.Decode(&value); err != nil {
		return manifestTokenError(err)
	}
	name, err := json.Marshal(key)
	if err != nil {
		return err
	}
	member := make([]byte, 0, len(name)+len(value)+3)
	member = append(member, '{')
	member = append(member, name...)
	member = append(member, ':')
	member = append(member, value...)
	member = append(member, '}')
	return json.Unmarshal(member, snapshot)
}

// decodeManifestFiles decodes the "files" value one entry at a time,
// retaining the entries keep accepts. A repeated "files" key restarts the
// list with fresh entries; unlike json.Unmarshal it does not decode the
// repeat into the earlier entries in place. As with json.Unmarshal, null
// leaves Files nil and an empty array leaves it empty (not nil).
func decodeManifestFiles(dec *json.Decoder, snapshot *Snapshot, keep func(*SnapshotFile) bool) error {
	tok, err := dec.Token()
	if err != nil {
		return manifestTokenError(err)
	}
	if tok == nil {
		snapshot.Files = nil
		return nil
	}
	if tok != json.Delim('[') {
		return fmt.Errorf("invalid manifest: \"files\" is %v, not an array", tok)
	}
	snapshot.Files = []SnapshotFile{}
	for dec.More() {
		var entry SnapshotFile
		if err := dec.Decode(&entry); err != nil {
			return manifestTokenError(err)
		}
		if keep == nil || keep(&entry) {
			snapshot.Files = append(snapshot.Files, entry)
		}
	}
	if _, err := dec.Token(); err != nil { // the closing ']'
		return manifestTokenError(err)
	}
	return nil
}

// manifestTokenError maps a decoder hitting the end of the input inside the
// manifest to a truncation error wrapping io.ErrUnexpectedEOF: a bare io.EOF
// there would read as a clean end of stream.
func manifestTokenError(err error) error {
	if errors.Is(err, io.EOF) {
		return fmt.Errorf("manifest truncated: %w", io.ErrUnexpectedEOF)
	}
	return err
}
