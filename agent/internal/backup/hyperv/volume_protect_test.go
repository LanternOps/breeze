package hyperv

import (
	"strings"
	"testing"
)

func TestCheckDriveLetter(t *testing.T) {
	for _, tt := range []struct {
		in string
		ok bool
	}{
		{"E", true}, {"z", true}, {"", false}, {"EF", false}, {"1", false}, {":", false}, {"E:", false}, {"É", false},
	} {
		if err := checkDriveLetter(tt.in); (err == nil) != tt.ok {
			t.Errorf("checkDriveLetter(%q) = %v, want ok=%v", tt.in, err, tt.ok)
		}
	}
}

func TestCheckProtectedRootDACL(t *testing.T) {
	tests := []struct {
		name string
		sddl string
		want string // substring of the error; "" means accepted
	}{
		{name: "the protection this restore applies", sddl: protectedVolumeRootSDDL},
		{name: "SIDs instead of aliases", sddl: "D:PAI(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;S-1-5-32-544)"},
		{name: "protected without auto-inherit flag", sddl: "D:P(A;OICI;FA;;;SY)"},
		{name: "deny entry for users", sddl: "D:P(D;OICI;FA;;;BU)(A;OICI;FA;;;SY)"},
		{name: "owner section before the DACL", sddl: "O:BAD:PAI(A;OICI;FA;;;SY)"},

		{name: "default NTFS root DACL", sddl: "D:AI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;;0x1301bf;;;AU)(A;OICIIO;SDGXGWGR;;;AU)(A;OICI;0x1200a9;;;BU)", want: "not protected"},
		{name: "protected but granting authenticated users", sddl: "D:PAI(A;OICI;FA;;;SY)(A;;0x1301bf;;;AU)", want: "grants access to AU"},
		{name: "protected but granting users", sddl: "D:PAI(A;OICI;FA;;;SY)(A;CI;DC;;;BU)", want: "grants access to BU"},
		{name: "protected but granting everyone by SID", sddl: "D:P(A;;FA;;;S-1-1-0)", want: "grants access"},
		{name: "object entry", sddl: "D:P(OA;;FA;00000000-0000-0000-0000-000000000000;;SY)", want: "does not accept"},
		{name: "callback entry", sddl: "D:P(XA;;FA;;;SY;(Member_of {SID(BA)}))", want: "does not accept"},
		{name: "null DACL", sddl: "D:NO_ACCESS_CONTROL", want: "NULL DACL"},
		{name: "no DACL", sddl: "O:BA", want: "no DACL"},
		{name: "unterminated entry", sddl: "D:P(A;;FA;;;SY", want: "unterminated"},
		{name: "trailing garbage", sddl: "D:P(A;;FA;;;SY)x", want: "unexpected content"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := checkProtectedRootDACL(tt.sddl)
			if tt.want == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestCheckVolumeRootEntries(t *testing.T) {
	svi := volumeRootEntry{Name: systemVolumeInformation, Dir: true, OwnerSID: "S-1-5-32-544"}
	tests := []struct {
		name    string
		entries []volumeRootEntry
		wantErr bool
	}{
		{name: "empty root", entries: nil},
		{name: "system volume information owned by administrators", entries: []volumeRootEntry{svi}},
		{name: "system volume information owned by system, other case", entries: []volumeRootEntry{{Name: "system volume information", Dir: true, OwnerSID: "S-1-5-18"}}},

		{name: "directory created before protection", entries: []volumeRootEntry{svi, {Name: "Windows", Dir: true, OwnerSID: "S-1-5-21-1-2-3-1001"}}, wantErr: true},
		{name: "file created before protection", entries: []volumeRootEntry{{Name: "bootmgr", OwnerSID: "S-1-5-32-544"}}, wantErr: true},
		{name: "system volume information owned by a user", entries: []volumeRootEntry{{Name: systemVolumeInformation, Dir: true, OwnerSID: "S-1-5-21-1-2-3-1001"}}, wantErr: true},
		{name: "system volume information as a link", entries: []volumeRootEntry{{Name: systemVolumeInformation, Dir: true, Reparse: true, OwnerSID: "S-1-5-18"}}, wantErr: true},
		{name: "system volume information as a file", entries: []volumeRootEntry{{Name: systemVolumeInformation, OwnerSID: "S-1-5-18"}}, wantErr: true},
		{name: "owner unreadable", entries: []volumeRootEntry{{Name: systemVolumeInformation, Dir: true}}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := checkVolumeRootEntries(tt.entries); (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
