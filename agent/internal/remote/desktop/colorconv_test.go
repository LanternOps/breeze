package desktop

import "testing"

func TestRGBAtoNV12_2x2(t *testing.T) {
	// 2x2 RGBA pixels, row-major:
	// (0,0)=red, (1,0)=green, (0,1)=blue, (1,1)=white
	rgba := []byte{
		255, 0, 0, 255, 0, 255, 0, 255,
		0, 0, 255, 255, 255, 255, 255, 255,
	}

	nv12 := rgbaToNV12(rgba, 2, 2, 2*4)
	defer putNV12Buffer(nv12)

	if len(nv12) != 6 {
		t.Fatalf("expected nv12 length 6, got %d", len(nv12))
	}

	// Expected based on the integer BT.601 math used in rgbaToNV12.
	// Y plane (4 bytes): [red, green, blue, white]
	// UV plane (2 bytes): subsampled from pixel (0,0)=red
	want := []byte{
		82, 144,
		41, 235,
		90, 240,
	}
	for i := range want {
		if nv12[i] != want[i] {
			t.Fatalf("byte[%d]: expected %d, got %d (nv12=%v)", i, want[i], nv12[i], nv12)
		}
	}
}

func TestBGRAtoNV12_2x2(t *testing.T) {
	// Same 2x2 pixels as RGBA test but in BGRA byte order:
	// (0,0)=red:  BGRA=[0,0,255,255]
	// (1,0)=green: BGRA=[0,255,0,255]
	// (0,1)=blue: BGRA=[255,0,0,255]
	// (1,1)=white: BGRA=[255,255,255,255]
	bgra := []byte{
		0, 0, 255, 255, 0, 255, 0, 255,
		255, 0, 0, 255, 255, 255, 255, 255,
	}

	nv12 := bgraToNV12(bgra, 2, 2, 2*4)
	defer putNV12Buffer(nv12)

	if len(nv12) != 6 {
		t.Fatalf("expected nv12 length 6, got %d", len(nv12))
	}

	// Same expected output as RGBA test — same colors, same BT.601 math.
	want := []byte{
		82, 144,
		41, 235,
		90, 240,
	}
	for i := range want {
		if nv12[i] != want[i] {
			t.Fatalf("byte[%d]: expected %d, got %d (nv12=%v)", i, want[i], nv12[i], nv12)
		}
	}
}
