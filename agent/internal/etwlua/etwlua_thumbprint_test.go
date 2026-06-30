package etwlua

import "testing"

func TestNormalizeThumbprint(t *testing.T) {
	const hex64 = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

	tests := []struct {
		name    string
		raw     string
		want    string
		wantOK  bool
	}{
		{name: "plain lowercase 64-hex", raw: hex64, want: hex64, wantOK: true},
		{
			name:   "uppercase is lowercased",
			raw:    "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
			want:   hex64,
			wantOK: true,
		},
		{
			name:   "colon-separated byte pairs (PowerShell/CertUtil style)",
			raw:    "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
			want:   hex64,
			wantOK: true,
		},
		{
			name:   "spaces and trailing NUL padding stripped",
			raw:    "ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67 89\x00",
			want:   hex64,
			wantOK: true,
		},
		{name: "empty", raw: "", want: "", wantOK: false},
		{name: "too short (SHA-1 40-hex) rejected", raw: "abcdef0123456789abcdef0123456789abcdef01", want: "", wantOK: false},
		{
			name:   "too long rejected",
			raw:    hex64 + "ab",
			want:   "",
			wantOK: false,
		},
		{
			name:   "non-hex char rejected (no half-formed pin)",
			raw:    "zbcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
			want:   "",
			wantOK: false,
		},
		{
			name:   "0x prefix rejected",
			raw:    "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
			want:   "",
			wantOK: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := NormalizeThumbprint(tt.raw)
			if ok != tt.wantOK {
				t.Fatalf("NormalizeThumbprint(%q) ok = %v, want %v", tt.raw, ok, tt.wantOK)
			}
			if got != tt.want {
				t.Fatalf("NormalizeThumbprint(%q) = %q, want %q", tt.raw, got, tt.want)
			}
		})
	}
}
