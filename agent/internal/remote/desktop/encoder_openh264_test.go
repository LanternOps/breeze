package desktop

import "testing"

// TestClampThreads locks in the thread-count policy for OpenH264's
// IMultipleThreadIdc: minimum 2 (so the encoder can overlap slice encode with
// bitstream emit), maximum 4 (realtime H264 sees marginal returns past 4).
func TestClampThreads(t *testing.T) {
	cases := []struct {
		in, want int
	}{
		{0, 2},
		{1, 2},
		{2, 2},
		{3, 3},
		{4, 4},
		{8, 4},
		{64, 4},
	}
	for _, tc := range cases {
		if got := clampThreads(tc.in); got != tc.want {
			t.Errorf("clampThreads(%d) = %d, want %d", tc.in, got, tc.want)
		}
	}
}
