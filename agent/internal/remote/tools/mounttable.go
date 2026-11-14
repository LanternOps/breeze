package tools

import (
	"bufio"
	"io"
	"path/filepath"
	"strconv"
	"strings"
)

// The mount table lists every mounted volume's top folder, bind mounts
// included (which share their source's device, so a device comparison
// cannot see them). Scans anchor the protected locations at each of them.

// loadMountTable returns every mount point on this system (a variable so a
// test can supply a table). ok is false when the table is not available.
var loadMountTable = readMountTable

// parseMountInfo reads mount points from /proc/self/mountinfo content: the
// fifth field of each line, with the kernel's octal escapes (\040 for a
// space, \011, \012, \134) undone. Malformed lines are skipped.
func parseMountInfo(r io.Reader) []string {
	var out []string
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 5 || !strings.HasPrefix(fields[4], "/") {
			continue
		}
		out = append(out, unescapeMountField(fields[4]))
	}
	return out
}

func unescapeMountField(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+4 <= len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// longestMountPoint returns the mount point in table that is p or its
// nearest ancestor ("" if none).
func longestMountPoint(table []string, p string) string {
	p = filepath.Clean(p)
	best := ""
	for _, m := range table {
		m = filepath.Clean(m)
		if len(m) <= len(best) {
			continue
		}
		if p == m || strings.HasPrefix(p, strings.TrimSuffix(m, string(filepath.Separator))+string(filepath.Separator)) {
			best = m
		}
	}
	return best
}
