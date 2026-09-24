package hwhealth

import "testing"

func TestKeys(t *testing.T) {
	for _, tc := range []struct{ got, want string }{
		{controllerKey("storcli", "0"), "storcli:c0"},
		{slotKey("perccli:c1", "", "3"), "perccli:c1:e-:s3"},
		{memberKey("mdadm:md0", "ata-S1"), "mdadm:md0:m:ata-S1"},
		{smartKey(" S ", "sat", "/dev/sda", true), "smart:S"},
		{smartKey("S", "sat", "/dev/sda", false), "smart:dev:sat:/dev/sda"},
		{smartKey("", "megaraid,0", "/dev/bus/0", true), "smart:dev:megaraid,0:/dev/bus/0"},
		{smartKey("  ", "megaraid,1", "/dev/bus/0", true), "smart:dev:megaraid,1:/dev/bus/0"},
		{smartKey("S", "megaraid,0", "/dev/bus/0", false), "smart:dev:megaraid,0:/dev/bus/0"},
		{smartKey("S", "megaraid,1", "/dev/bus/0", false), "smart:dev:megaraid,1:/dev/bus/0"},
		{smartKey("", "", "/dev/sda", false), "smart:dev::/dev/sda"},
	} {
		if tc.got != tc.want {
			t.Fatalf("%q != %q", tc.got, tc.want)
		}
	}
}
