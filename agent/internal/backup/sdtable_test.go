package backup

import "testing"

func TestSDTable_DedupesByContent(t *testing.T) {
	tbl := newSDTable()
	sdA := []byte{1, 2, 3, 4}
	sdB := []byte{5, 6, 7, 8}

	i1 := tbl.index(sdA)
	i2 := tbl.index(sdB)
	i3 := tbl.index(append([]byte(nil), sdA...)) // distinct backing array, same content

	if i1 != 1 {
		t.Errorf("first index = %d, want 1 (1-based)", i1)
	}
	if i2 != 2 {
		t.Errorf("second distinct index = %d, want 2", i2)
	}
	if i3 != i1 {
		t.Errorf("re-inserting identical bytes = %d, want %d (dedupe)", i3, i1)
	}
}

func TestSDTable_EmptyReturnsZero(t *testing.T) {
	tbl := newSDTable()
	if got := tbl.index(nil); got != 0 {
		t.Errorf("index(nil) = %d, want 0", got)
	}
	if got := tbl.index([]byte{}); got != 0 {
		t.Errorf("index(empty) = %d, want 0", got)
	}
}

func TestSDTable_EncodedOrderMatchesInsertionAndIsBase64(t *testing.T) {
	tbl := newSDTable()
	tbl.index([]byte{0xAA})
	tbl.index([]byte{0xBB})
	tbl.index([]byte{0xAA}) // dedupe, no new slot

	got := tbl.encoded()
	want := []string{"qg==", "uw=="} // base64 of 0xAA, 0xBB
	if len(got) != len(want) {
		t.Fatalf("encoded() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("encoded()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestSDTable_EncodedEmptyIsNil(t *testing.T) {
	tbl := newSDTable()
	if got := tbl.encoded(); got != nil {
		t.Errorf("encoded() on an empty table = %v, want nil (so Snapshot.SecurityDescriptors omits entirely via omitempty)", got)
	}
}

func TestSDTable_IndexIsStableAcrossManyInserts(t *testing.T) {
	tbl := newSDTable()
	first := tbl.index([]byte("descriptor-A"))
	for i := 0; i < 50; i++ {
		tbl.index([]byte{byte(i)}) // 50 distinct fillers
	}
	again := tbl.index([]byte("descriptor-A"))
	if again != first {
		t.Errorf("index for a previously-seen descriptor changed: first %d, again %d", first, again)
	}
}

// sdHeader builds a minimal SECURITY_DESCRIPTOR_RELATIVE header (20 bytes):
// Revision u8@0, Sbz1 u8@1, Control u16@2, OffsetOwner u32@4,
// OffsetGroup u32@8, OffsetSacl u32@12, OffsetDacl u32@16.
func sdHeader(control uint16, owner, group, sacl, dacl uint32) []byte {
	b := make([]byte, 20)
	b[0] = 1
	b[2], b[3] = byte(control), byte(control>>8)
	put := func(off int, v uint32) {
		b[off], b[off+1], b[off+2], b[off+3] = byte(v), byte(v>>8), byte(v>>16), byte(v>>24)
	}
	put(4, owner)
	put(8, group)
	put(12, sacl)
	put(16, dacl)
	return b
}

func TestSecurityInfoForSD(t *testing.T) {
	const selfRel, daclPresent, saclPresent = 0x8000, 0x0004, 0x0010
	tests := []struct {
		name     string
		sd       []byte
		haveSACL bool
		want     uint32
		wantErr  bool
	}{
		{"owner+group+dacl", sdHeader(selfRel|daclPresent, 20, 40, 0, 60), false, 0x1 | 0x2 | 0x4, false},
		{"sacl present but privilege not held", sdHeader(selfRel|daclPresent|saclPresent, 20, 40, 80, 60), false, 0x1 | 0x2 | 0x4, false},
		{"sacl present and privilege held", sdHeader(selfRel|daclPresent|saclPresent, 20, 40, 80, 60), true, 0x1 | 0x2 | 0x4 | 0x8, false},
		{"no owner offset: owner not requested", sdHeader(selfRel|daclPresent, 0, 40, 0, 60), false, 0x2 | 0x4, false},
		{"absolute (not self-relative) descriptor refused", sdHeader(daclPresent, 20, 40, 0, 60), false, 0, true},
		{"truncated refused", []byte{1, 0, 0}, false, 0, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := securityInfoForSD(tt.sd, tt.haveSACL)
			if (err != nil) != tt.wantErr || got != tt.want {
				t.Errorf("securityInfoForSD = %#x, %v; want %#x, err=%v", got, err, tt.want, tt.wantErr)
			}
		})
	}
}
