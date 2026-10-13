package heartbeat

import (
	"bytes"
	"encoding/json"
)

// retainStateProtocolVersion is declared in securityCapabilities. Version 1:
// this build honours HeartbeatResponse.RetainState (#8258).
const retainStateProtocolVersion = 1

const (
	retainStateMaxEntries = 16
	retainStateMaxNameLen = 32
)

// RetainState names the features the server made NO decision about this beat.
// For each, the agent keeps its current state instead of treating the
// missing legacy key as "off" (#8258). The zero value means "no feature
// retained", which is exactly the pre-protocol behaviour, and is what every
// response from an API that predates the protocol decodes to.
type RetainState struct {
	PAM              bool
	Helper           bool
	RemoteManagement bool
}

// UnmarshalJSON never returns an error: this field rides on the heartbeat
// response, and a decode failure would drop the beat's commands and upgrade
// instructions. Anything that is not an array of strings degrades to "retain
// nothing" (legacy semantics); unknown names, oversized names and entries
// beyond retainStateMaxEntries are ignored.
func (r *RetainState) UnmarshalJSON(data []byte) error {
	*r = RetainState{}
	dec := json.NewDecoder(bytes.NewReader(data))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('[') {
		return nil // not an array: retain nothing
	}
	// Stream tokens and stop after retainStateMaxEntries, so parse work is
	// bounded by the cap rather than by the array length. A nested value
	// (object/array) ends parsing: it is not a list of names.
	for i := 0; i < retainStateMaxEntries && dec.More(); i++ {
		tok, err := dec.Token()
		if err != nil {
			return nil
		}
		if _, nested := tok.(json.Delim); nested {
			return nil
		}
		name, ok := tok.(string)
		if !ok || len(name) > retainStateMaxNameLen {
			continue
		}
		switch name {
		case "pam":
			r.PAM = true
		case "helper":
			r.Helper = true
		case "remoteManagement":
			r.RemoteManagement = true
		}
	}
	return nil
}
