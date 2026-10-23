package svcquery

import (
	"errors"
	"testing"
)

const sampleLaunchctlList = `PID	Status	Label
-	0	com.apple.SafariHistoryServiceAgent
412	0	ctrld
-	78	com.example.stopped
977	0	com.nextdns.nextdns
`

func TestParseLaunchctlList(t *testing.T) {
	tests := []struct {
		name       string
		lookup     string
		wantLabel  string
		wantStatus ServiceStatus
		wantErr    error
	}{
		{"running exact label", "ctrld", "ctrld", StatusRunning, nil},
		{"stopped exact label", "com.example.stopped", "com.example.stopped", StatusStopped, nil},
		{"suffix match keeps the resolved label", "nextdns", "com.nextdns.nextdns", StatusRunning, nil},
		{"absent label", "missing", "", "", ErrServiceNotFound},
		{"header is not a service", "Label", "", "", ErrServiceNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info, err := parseLaunchctlList(sampleLaunchctlList, tt.lookup)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want errors.Is(%v)", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if info.Name != tt.wantLabel || info.Status != tt.wantStatus {
				t.Fatalf("got %+v, want label %q status %q", info, tt.wantLabel, tt.wantStatus)
			}
		})
	}
}

// resolveLaunchdStatus is the whole of darwin GetStatus minus the exec: it is
// what tells "launchctl could not be asked" apart from "the label is absent".
func TestResolveLaunchdStatus(t *testing.T) {
	noPlist := func(string) (bool, error) { return false, nil }

	t.Run("launchctl list failing is an error, not not-found", func(t *testing.T) {
		_, err := resolveLaunchdStatus("", errors.New("exit status 1"), "ctrld", noPlist)
		if err == nil || errors.Is(err, ErrServiceNotFound) {
			t.Fatalf("err = %v, want a non-not-found error", err)
		}
	})

	t.Run("absent label and no plist is ErrServiceNotFound", func(t *testing.T) {
		info, err := resolveLaunchdStatus(sampleLaunchctlList, nil, "ctrld-absent", noPlist)
		if !errors.Is(err, ErrServiceNotFound) {
			t.Fatalf("err = %v, want errors.Is(ErrServiceNotFound)", err)
		}
		if info.Status != StatusUnknown {
			t.Fatalf("status = %q, want unknown", info.Status)
		}
	})

	t.Run("absent label with an installed plist is stopped", func(t *testing.T) {
		var asked []string
		info, err := resolveLaunchdStatus(sampleLaunchctlList, nil, "ctrld-absent", func(p string) (bool, error) {
			asked = append(asked, p)
			return p == "/Library/LaunchDaemons/ctrld-absent.plist", nil
		})
		if err != nil || info.Status != StatusStopped {
			t.Fatalf("got (%+v, %v), want stopped", info, err)
		}
		if len(asked) == 0 {
			t.Fatal("plist existence was never checked")
		}
	})

	t.Run("an unreadable plist path is an error, not absence", func(t *testing.T) {
		_, err := resolveLaunchdStatus(sampleLaunchctlList, nil, "ctrld-absent", func(string) (bool, error) {
			return false, errors.New("permission denied")
		})
		if err == nil || errors.Is(err, ErrServiceNotFound) {
			t.Fatalf("err = %v, want a non-not-found error", err)
		}
	})

	t.Run("listed label wins without a plist check", func(t *testing.T) {
		info, err := resolveLaunchdStatus(sampleLaunchctlList, nil, "ctrld", func(string) (bool, error) {
			t.Fatal("plist checked for a listed label")
			return false, nil
		})
		if err != nil || info.Status != StatusRunning {
			t.Fatalf("got (%+v, %v), want running", info, err)
		}
	})
}
