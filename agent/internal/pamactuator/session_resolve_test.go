package pamactuator

import (
	"errors"
	"testing"
)

func TestResolveSubjectSessionWith(t *testing.T) {
	// console fallback is a fixed sentinel so tests can tell it apart from the
	// other two branches; a non-nil error variant proves it is propagated.
	const consoleID uint32 = 999
	consoleOK := func(Request) (uint32, error) { return consoleID, nil }
	consoleErr := func(Request) (uint32, error) { return 0, errors.New("no console") }

	// userLookup: "alice" is logged into session 3; everyone else is absent.
	userLookup := func(name string) (uint32, bool) {
		if name == "alice" {
			return 3, true
		}
		return 0, false
	}

	tests := []struct {
		name       string
		req        Request
		lookup     func(string) (uint32, bool)
		console    func(Request) (uint32, error)
		wantID     uint32
		wantSource string
		wantErr    bool
	}{
		{
			name:       "explicit session id wins over everything",
			req:        Request{SubjectSessionID: 7, SubjectUsername: "alice"},
			lookup:     userLookup,
			console:    consoleOK,
			wantID:     7,
			wantSource: "etw_session",
		},
		{
			name:       "session id 0 is treated as unset -> username lookup",
			req:        Request{SubjectSessionID: 0, SubjectUsername: "alice"},
			lookup:     userLookup,
			console:    consoleOK,
			wantID:     3,
			wantSource: "username_lookup",
		},
		{
			name:       "WTS sentinel session id is treated as unset -> username lookup",
			req:        Request{SubjectSessionID: invalidSessionID, SubjectUsername: "alice"},
			lookup:     userLookup,
			console:    consoleOK,
			wantID:     3,
			wantSource: "username_lookup",
		},
		{
			name:       "username not logged in -> console fallback",
			req:        Request{SubjectUsername: "bob"},
			lookup:     userLookup,
			console:    consoleOK,
			wantID:     consoleID,
			wantSource: "console_fallback",
		},
		{
			name:       "empty username -> console fallback",
			req:        Request{},
			lookup:     userLookup,
			console:    consoleOK,
			wantID:     consoleID,
			wantSource: "console_fallback",
		},
		{
			name:       "nil lookup -> console fallback even with a username",
			req:        Request{SubjectUsername: "alice"},
			lookup:     nil,
			console:    consoleOK,
			wantID:     consoleID,
			wantSource: "console_fallback",
		},
		{
			name:       "console error is propagated",
			req:        Request{SubjectUsername: "bob"},
			lookup:     userLookup,
			console:    consoleErr,
			wantSource: "console_fallback",
			wantErr:    true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			id, source, err := resolveSubjectSessionWith(tt.req, tt.lookup, tt.console)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr = %v", err, tt.wantErr)
			}
			if source != tt.wantSource {
				t.Errorf("source = %q, want %q", source, tt.wantSource)
			}
			if !tt.wantErr && id != tt.wantID {
				t.Errorf("id = %d, want %d", id, tt.wantID)
			}
		})
	}
}

func TestResolveSubjectSessionStrictWithNeverFallsBackToConsole(t *testing.T) {
	lookup := func(name string) (uint32, bool) {
		if name == `CORP\alice` {
			return 12, true
		}
		return 0, false
	}

	id, source, err := resolveSubjectSessionStrictWith(Request{SubjectUsername: `CORP\alice`}, lookup)
	if err != nil || id != 12 || source != "username_lookup" {
		t.Fatalf("strict subject resolution = (%d, %q, %v), want (12, username_lookup, nil)", id, source, err)
	}

	for _, req := range []Request{
		{},
		{SubjectUsername: "bob"},
		{SubjectUsername: "alice", SubjectSessionID: 99},
	} {
		id, source, err = resolveSubjectSessionStrictWith(req, func(string) (uint32, bool) { return 0, false })
		if err == nil || id != 0 || source != "subject_session_required" {
			t.Fatalf("strict missing subject session for %+v = (%d, %q, %v), want fail closed", req, id, source, err)
		}
	}
}

func TestBareUsername(t *testing.T) {
	cases := map[string]string{
		`CORP\alice`:         "alice",
		`DELL70601\pamtest`:  "pamtest",
		"bob":                "bob",
		"carol@corp.com":     "carol",
		`CORP\dave@corp.com`: "dave",
		"  spacey  ":         "spacey",
		"":                   "",
	}
	for in, want := range cases {
		if got := bareUsername(in); got != want {
			t.Errorf("bareUsername(%q) = %q, want %q", in, got, want)
		}
	}
}
