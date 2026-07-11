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
		{"empty host rejected", "https:///path-only", true},
		{"uppercase scheme ok (url.Parse lowercases)", "HTTPS://new.example.com", false},
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

// TestValidateTieredClearsBackupEqualToPrimary pins the load-time self-heal:
// a backup equal to the primary (e.g. left by a torn promote persist) is
// warned about and cleared, never kept as a useless failover target.
func TestValidateTieredClearsBackupEqualToPrimary(t *testing.T) {
	cfg := &Config{
		ServerURL:       "https://one.example.com",
		BackupServerURL: "https://one.example.com",
	}
	result := cfg.ValidateTiered()
	if len(result.Warnings) == 0 {
		t.Fatal("expected a warning for backup_server_url == server_url")
	}
	if cfg.BackupServerURL != "" {
		t.Fatalf("backup_server_url not cleared: %q", cfg.BackupServerURL)
	}

	distinct := &Config{
		ServerURL:       "https://one.example.com",
		BackupServerURL: "https://two.example.com",
	}
	_ = distinct.ValidateTiered()
	if distinct.BackupServerURL != "https://two.example.com" {
		t.Fatalf("distinct backup wrongly cleared: %q", distinct.BackupServerURL)
	}
}
