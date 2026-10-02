package integrity

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustParse(t *testing.T, raw string) *Expectation {
	t.Helper()
	e, err := Parse(json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func writeTemp(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "staged")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestCheckStoredBytes(t *testing.T) {
	attested := mustParse(t, attestedJSON("s", "m"))
	override := mustParse(t, `{"v":1,"mode":"unattested_override","snapshotId":"s","authorizationId":"a"}`)
	body := "hello world"
	good := Stored{Size: int64(len(body)), SHA256: sum(body)}
	sameSizeOther := Stored{Size: int64(len(body)), SHA256: sum("hello WORLD")}
	cases := []struct {
		name     string
		e        *Expectation
		want     Stored
		wantErr  error
		warn     bool
		sizeOnly bool
	}{
		{name: "attested match", e: attested, want: good},
		{name: "attested same size different bytes", e: attested, want: sameSizeOther, wantErr: ErrIntegrityMismatch},
		{name: "attested size mismatch", e: attested, want: Stored{Size: 3, SHA256: good.SHA256}, wantErr: ErrIntegrityMismatch},
		{name: "attested volatile size mismatch fails", e: attested, want: Stored{Size: 3, SHA256: good.SHA256, Volatile: true}, wantErr: ErrIntegrityMismatch},
		{name: "attested volatile checksum mismatch fails", e: attested, want: Stored{Size: good.Size, SHA256: sameSizeOther.SHA256, Volatile: true}, wantErr: ErrIntegrityMismatch},
		{name: "attested missing checksum fails", e: attested, want: Stored{Size: good.Size}, wantErr: ErrMissingChecksum},
		{name: "override volatile checksum mismatch warns", e: override, want: Stored{Size: good.Size, SHA256: sameSizeOther.SHA256, Volatile: true}, warn: true},
		{name: "override volatile size mismatch warns", e: override, want: Stored{Size: 1, SHA256: good.SHA256, Volatile: true}, warn: true},
		{name: "override missing checksum is size only", e: override, want: Stored{Size: good.Size}, sizeOnly: true},
		{name: "override checksum mismatch fails", e: override, want: sameSizeOther, wantErr: ErrChecksumMismatch},
		{name: "none size mismatch fails", e: nil, want: Stored{Size: 1, SHA256: good.SHA256}, wantErr: ErrSizeMismatch},
		{name: "none volatile warns", e: nil, want: Stored{Size: 1, SHA256: good.SHA256, Volatile: true}, warn: true},
		{name: "none missing checksum size only", e: nil, want: Stored{Size: good.Size}, sizeOnly: true},
		{name: "checksum compare is case insensitive", e: attested, want: Stored{Size: good.Size, SHA256: strings.ToUpper(good.SHA256)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, err := CheckStoredBytes(writeTemp(t, body), tc.want, tc.e)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if (res.Warning != "") != tc.warn || res.SizeOnly != tc.sizeOnly {
				t.Fatalf("res = %+v", res)
			}
		})
	}
}

func TestMismatchErrorsAreRetryable(t *testing.T) {
	for _, err := range []error{ErrIntegrityMismatch, ErrChecksumMismatch, ErrSizeMismatch} {
		if !Retryable(err) {
			t.Fatalf("%v should be retryable from another source", err)
		}
	}
	if Retryable(ErrMissingChecksum) || Retryable(errors.New("other")) {
		t.Fatal("only content mismatches are retryable")
	}
}

func TestFailureCode(t *testing.T) {
	cases := map[error]string{
		ErrIntegrityMismatch: "integrity_mismatch",
		ErrMissingChecksum:   "missing_checksum",
		ErrChecksumMismatch:  "checksum_mismatch",
		ErrSizeMismatch:      "size_mismatch",
	}
	for err, code := range cases {
		if got := FailureCode(err); got != code {
			t.Fatalf("FailureCode(%v) = %q, want %q", err, got, code)
		}
	}
}
