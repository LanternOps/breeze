package yarascan

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"

	yx "github.com/niallnsec/yaraxwasm"
)

// BenchmarkHashIocs measures what hash IOCs cost a scan (#6267 W04-1): a hash
// IOC makes every scanned file be hashed in full, matching or not. If 1000
// hashes cost much more than one per file, the hash module is not caching the
// digest per scan and the importer must cap hash IOCs (escalate). Not a gate;
// the PR records the numbers:
//
//	go test -run '^$' -bench BenchmarkHashIocs -benchtime 3x ./internal/yarascan/
//
// The main variants use the importer's form — the digest bound once per rule
// (`with digest = hash.<algo>(0, filesize) : (digest == "…" or …)`); the
// `-naive` variant re-calls hash.<algo>() per literal, for comparison.
func BenchmarkHashIocs(b *testing.B) {
	hashRules := func(algo string, n int, naive bool) []BundleRule {
		var rules []BundleRule
		const perRule = 400 // stays under the 60 KiB generated-source budget
		for start := 0; start < n; start += perRule {
			var conds []string
			for i := start; i < min(start+perRule, n); i++ {
				sum := sha256.Sum256([]byte(fmt.Sprintf("%s-%d", algo, i)))
				digest := hex.EncodeToString(sum[:])[:map[string]int{"md5": 32, "sha1": 40, "sha256": 64}[algo]]
				if naive {
					conds = append(conds, fmt.Sprintf(`hash.%s(0, filesize) == "%s"`, algo, digest))
				} else {
					conds = append(conds, fmt.Sprintf(`digest == "%s"`, digest))
				}
			}
			name := fmt.Sprintf("bench_%s_%d", algo, start)
			cond := strings.Join(conds, " or\n ")
			if !naive {
				cond = fmt.Sprintf("with digest = hash.%s(0, filesize) : (%s)", algo, cond)
			}
			rules = append(rules, BundleRule{ID: name, Name: name, Severity: "high",
				Source: "import \"hash\"\nrule " + name + " { condition: " + cond + " }"})
		}
		return rules
	}
	variants := []struct {
		name  string
		rules []BundleRule
	}{
		{"baseline-string", []BundleRule{{ID: "s", Name: "bench_string", Severity: "high",
			Source: `rule bench_string { strings: $a = "breeze-bench-never-present" condition: $a }`}}},
		{"sha256x1", hashRules("sha256", 1, false)},
		{"sha256x1000", hashRules("sha256", 1000, false)},
		{"md5+sha1+sha256x250", append(append(hashRules("md5", 250, false), hashRules("sha1", 250, false)...), hashRules("sha256", 250, false)...)},
		{"sha256x1000-naive", hashRules("sha256", 1000, true)},
	}

	pool := make([]byte, 1000*(64<<10)) // 62.5 MiB of random bytes
	if _, err := rand.Read(pool); err != nil {
		b.Fatal(err)
	}
	big := pool[:25<<20]
	small := make([][]byte, 1000)
	for i := range small {
		small[i] = pool[i*(64<<10) : (i+1)*(64<<10)]
	}

	for _, v := range variants {
		entry := compileEntry(b, bundle("bench", v.rules...))
		for _, shape := range []struct {
			name string
			bufs [][]byte
		}{{"25MiB", [][]byte{big}}, {"1000x64KiB", small}} {
			b.Run(v.name+"/"+shape.name, func(b *testing.B) {
				s := yx.NewScanner(entry.Rules)
				defer s.Destroy()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					for _, buf := range shape.bufs {
						res, err := s.Scan(buf)
						if err != nil {
							b.Fatal(err)
						}
						if len(res.MatchingRules()) != 0 {
							b.Fatal("random data must not match")
						}
					}
				}
			})
		}
	}
}
