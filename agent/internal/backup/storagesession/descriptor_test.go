package storagesession

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func descriptorJSON(t *testing.T, mutate func(map[string]any)) map[string]any {
	t.Helper()
	now := time.Now().UTC()
	d := map[string]any{
		"version":      1,
		"sessionId":    testSessionID,
		"token":        testSessionToken,
		"baseUrl":      "https://control-plane.example",
		"expiresAt":    now.Add(10 * time.Minute).Format(time.RFC3339),
		"deadline":     now.Add(time.Hour).Format(time.RFC3339),
		"capabilities": []string{"resolve_batch", "renew"},
		"maxBatch":     100,
	}
	if mutate != nil {
		mutate(d)
	}
	return d
}

func TestParsePayload(t *testing.T) {
	cases := []struct {
		name        string
		payload     map[string]any
		wantPresent bool
		wantErr     string
	}{
		{name: "absent", payload: map[string]any{"snapshotId": "s"}},
		{name: "explicit null", payload: map[string]any{"storageSession": nil}},
		{name: "legacy provider config only", payload: map[string]any{
			"provider": "s3", "providerConfig": map[string]any{"bucket": "b"},
		}},
		{name: "valid", payload: map[string]any{"storageSession": descriptorJSON(t, nil)}, wantPresent: true},
		{name: "valid with s3 provider label", payload: map[string]any{
			"storageSession": descriptorJSON(t, nil), "provider": "s3",
		}, wantPresent: true},
		{name: "valid with null providerConfig", payload: map[string]any{
			"storageSession": descriptorJSON(t, nil), "providerConfig": nil,
		}, wantPresent: true},
		{name: "fractional seconds accepted", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) {
			d["expiresAt"] = time.Now().UTC().Add(5 * time.Minute).Format("2006-01-02T15:04:05.000Z07:00")
		})}, wantPresent: true},
		{name: "both session and providerConfig", payload: map[string]any{
			"storageSession": descriptorJSON(t, nil), "providerConfig": map[string]any{"bucket": "b"},
		}, wantErr: "mutually exclusive"},
		{name: "empty providerConfig object still conflicts", payload: map[string]any{
			"storageSession": descriptorJSON(t, nil), "providerConfig": map[string]any{},
		}, wantErr: "mutually exclusive"},
		{name: "local provider", payload: map[string]any{
			"storageSession": descriptorJSON(t, nil), "provider": "local",
		}, wantErr: "provider"},
		{name: "non-object", payload: map[string]any{"storageSession": []int{1}}, wantErr: "storage session"},
		{name: "version 2", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["version"] = 2 })}, wantErr: "unsupported storage session version 2"},
		{name: "version 0", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["version"] = 0 })}, wantErr: "version"},
		{name: "version missing", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { delete(d, "version") })}, wantErr: "version"},
		{name: "session id path", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["sessionId"] = "a/../b" })}, wantErr: "sessionId"},
		{name: "session id uppercase uuid ok", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) {
			d["sessionId"] = strings.ToUpper(testSessionID)
		})}, wantPresent: true},
		{name: "token short", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["token"] = strings.Repeat("a", 42) })}, wantErr: "token"},
		{name: "token bad alphabet", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["token"] = strings.Repeat("a", 43) + "+" })}, wantErr: "token"},
		{name: "token padded ok", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["token"] = strings.Repeat("a", 43) + "=" })}, wantPresent: true},
		{name: "http base url", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["baseUrl"] = "http://control-plane.example" })}, wantErr: "baseUrl"},
		{name: "http loopback base url outside tests", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["baseUrl"] = "http://127.0.0.1:8080" })}, wantErr: "baseUrl"},
		{name: "base url userinfo", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["baseUrl"] = "https://u:p@control-plane.example" })}, wantErr: "baseUrl"},
		{name: "base url path", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["baseUrl"] = "https://control-plane.example/api" })}, wantErr: "baseUrl"},
		{name: "base url fragment", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["baseUrl"] = "https://control-plane.example/#x" })}, wantErr: "baseUrl"},
		{name: "base url trailing slash ok", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["baseUrl"] = "https://control-plane.example/" })}, wantPresent: true},
		{name: "expiresAt bad", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["expiresAt"] = "soon" })}, wantErr: "expiresAt"},
		{name: "deadline bad", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["deadline"] = "" })}, wantErr: "deadline"},
		{name: "expiresAt after deadline", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) {
			d["expiresAt"] = time.Now().UTC().Add(3 * time.Hour).Format(time.RFC3339)
		})}, wantErr: "expiresAt"},
		{name: "deadline passed", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) {
			d["expiresAt"] = time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
			d["deadline"] = time.Now().UTC().Add(-30 * time.Minute).Format(time.RFC3339)
		})}, wantErr: "deadline"},
		{name: "resolve capability missing", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["capabilities"] = []string{"renew"} })}, wantErr: "resolve_batch"},
		{name: "renew capability optional", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["capabilities"] = []string{"resolve_batch", "future_thing"} })}, wantPresent: true},
		{name: "maxBatch zero", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["maxBatch"] = 0 })}, wantErr: "maxBatch"},
		{name: "maxBatch huge", payload: map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["maxBatch"] = 100000 })}, wantErr: "maxBatch"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(tc.payload)
			if err != nil {
				t.Fatal(err)
			}
			d, err := ParsePayload(raw, time.Now())
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("ParsePayload succeeded, want error containing %q", tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) || !strings.Contains(err.Error(), "storage session") {
					t.Fatalf("error = %q, want it to contain %q and name the storage session", err, tc.wantErr)
				}
				if strings.Contains(err.Error(), testSessionToken) {
					t.Fatalf("error contains the session token: %q", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParsePayload: %v", err)
			}
			if (d != nil) != tc.wantPresent {
				t.Fatalf("present = %v, want %v", d != nil, tc.wantPresent)
			}
		})
	}
}

func TestParsePayloadLoopbackHTTPOnlyWhenAllowed(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["baseUrl"] = "http://127.0.0.1:8080" })})
	restore := AllowLoopbackHTTPForTest()
	defer restore()
	if _, err := ParsePayload(raw, time.Now()); err != nil {
		t.Fatalf("loopback http base url should be accepted in test mode: %v", err)
	}
	raw, _ = json.Marshal(map[string]any{"storageSession": descriptorJSON(t, func(d map[string]any) { d["baseUrl"] = "http://control-plane.example" })})
	if _, err := ParsePayload(raw, time.Now()); err == nil {
		t.Fatal("non-loopback http base url accepted in test mode")
	}
}

func TestDescriptorStringRedactsToken(t *testing.T) {
	d := &Descriptor{Token: testSessionToken, SessionID: testSessionID}
	for _, s := range []string{d.String(), fmtV(d)} {
		if strings.Contains(s, testSessionToken) {
			t.Fatalf("descriptor formatting contains the token: %q", s)
		}
	}
}
