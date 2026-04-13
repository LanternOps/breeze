package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestErrHTTPStatus_Error(t *testing.T) {
	err := &ErrHTTPStatus{StatusCode: 401, Body: `{"error":"invalid key"}`}
	got := err.Error()
	want := `http 401: {"error":"invalid key"}`
	if got != want {
		t.Errorf("Error() = %q, want %q", got, want)
	}
}

func TestErrHTTPStatus_ErrorsAs(t *testing.T) {
	var wrapped error = &ErrHTTPStatus{StatusCode: 404, Body: "not found"}
	var target *ErrHTTPStatus
	if !errors.As(wrapped, &target) {
		t.Fatal("errors.As should match *ErrHTTPStatus")
	}
	if target.StatusCode != 404 {
		t.Errorf("StatusCode = %d, want 404", target.StatusCode)
	}
}

func TestRotateToken(t *testing.T) {
	t.Parallel()

	var sawAuth string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path != "/api/v1/agents/agent-1/rotate-token" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"authToken":"brz_rotated","rotatedAt":"2026-03-31T20:00:00Z"}`))
	}))
	defer ts.Close()

	client := NewClient(ts.URL, "brz_old", "agent-1")
	resp, err := client.RotateToken()
	if err != nil {
		t.Fatalf("RotateToken() error = %v", err)
	}
	if sawAuth != "Bearer brz_old" {
		t.Fatalf("Authorization header = %q, want %q", sawAuth, "Bearer brz_old")
	}
	if resp.AuthToken != "brz_rotated" {
		t.Fatalf("AuthToken = %q, want %q", resp.AuthToken, "brz_rotated")
	}
	if resp.RotatedAt != "2026-03-31T20:00:00Z" {
		t.Fatalf("RotatedAt = %q, want %q", resp.RotatedAt, "2026-03-31T20:00:00Z")
	}
}
