package config

import "testing"

func TestValidateBackupServerURL(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{"empty is valid (unset)", "", false},
		{"https ok", "https://new.example.com", false},
		{"https with port ok", "https://new.example.com:8443", false},
		{"http localhost ok", "http://localhost:3001", false},
		{"http 127.0.0.1 ok", "http://127.0.0.1:3001", false},
		{"http ::1 ok", "http://[::1]:3001", false},
		{"http non-localhost rejected", "http://new.example.com", true},
		{"garbage rejected", "://not a url", true},
		{"ftp rejected", "ftp://new.example.com", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateBackupServerURL(tc.raw)
			if (err != nil) != tc.wantErr {
				t.Fatalf("ValidateBackupServerURL(%q) err=%v, wantErr=%v", tc.raw, err, tc.wantErr)
			}
		})
	}
}
