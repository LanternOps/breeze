package backup

import "testing"

// shadowDeviceRoot is pure string logic, so its classification is pinned on
// every GOOS. The Windows-only half (filepath.Clean stripping the separator,
// and a real shadow copy refusing to stat without it) lives in
// whole_machine_root_windows_test.go.
func TestShadowDeviceRoot_Classification(t *testing.T) {
	const dev = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy12`
	tests := []struct {
		in     string
		want   string
		wantOK bool
	}{
		{dev, dev, true},
		{dev + `\`, dev, true},
		{dev + `\\`, dev, true},
		{dev + `/`, dev, true},
		{`\\?\globalroot\DEVICE\HarddiskVolumeShadowCopy12\`, `\\?\globalroot\DEVICE\HarddiskVolumeShadowCopy12`, true},
		{dev + `\Windows`, "", false},
		{dev + `\Windows\`, "", false},
		{`\\?\GLOBALROOT\Device\`, "", false},
		{`\\?\GLOBALROOT\Device`, "", false},
		{`C:\`, "", false},
		{`C:`, "", false},
		{`\\server\share\`, "", false},
		{`/var/tmp`, "", false},
		{"", "", false},
	}
	for _, tt := range tests {
		got, ok := shadowDeviceRoot(tt.in)
		if got != tt.want || ok != tt.wantOK {
			t.Errorf("shadowDeviceRoot(%q) = (%q, %v), want (%q, %v)", tt.in, got, ok, tt.want, tt.wantOK)
		}
	}
}

// The bare device name is what rewritePathsForVSS produces for a configured
// `C:` root; it must come out separator-terminated on every platform.
func TestCleanBackupRoot_BareShadowDeviceGetsSeparator(t *testing.T) {
	const dev = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy12`
	if got, want := cleanBackupRoot(dev), dev+`\`; got != want {
		t.Errorf("cleanBackupRoot(%q) = %q, want %q", dev, got, want)
	}
	if got, want := cleanBackupRoot(dev+`\`), dev+`\`; got != want {
		t.Errorf("cleanBackupRoot(%q) = %q, want %q", dev+`\`, got, want)
	}
}
