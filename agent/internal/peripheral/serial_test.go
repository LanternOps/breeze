package peripheral

import "testing"

func TestParseSerial(t *testing.T) {
	cases := map[string]string{
		`USBSTOR\DISK&VEN_SANDISK&PROD_ULTRA&REV_1.00\4C530001234567890123&0`: "4C530001234567890123&0",
		`USB\VID_0781&PID_5583\0101a1b2c3`:                                     "0101a1b2c3",
		`USBSTOR\DISK`:                                                         "", // no serial segment
		``:                                                                     "",
	}
	for in, want := range cases {
		if got := parseSerial(in); got != want {
			t.Errorf("parseSerial(%q)=%q want %q", in, got, want)
		}
	}
}
