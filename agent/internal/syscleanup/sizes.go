package syscleanup

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Two size grammars, because the tools genuinely differ:
//
//   - apt's SizeToStr emits 1000-based units with a two-character suffix
//     ("After this operation, 12.3 MB disk space will be freed.").
//   - dnf's and journalctl's formatters emit 1024-based units with a single
//     letter, optionally followed by i/B ("Freed space: 1.2 G",
//     "…take up 1.2G in the file system.").
//
// Parsing one with the other's base is a silent 7% error at MB and 10% at GB.

var decimalSizePattern = regexp.MustCompile(`^([0-9]+(?:[.,][0-9]+)?)\s*([kKMGTP]?B)$`)
var binarySizePattern = regexp.MustCompile(`^([0-9]+(?:[.,][0-9]+)?)\s*([KkMGTP]?)(?:i?B?)$`)

var decimalUnitFactor = map[string]float64{
	"B": 1, "kB": 1e3, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12, "PB": 1e15,
}

var binaryUnitFactor = map[string]float64{
	"": 1, "K": 1 << 10, "k": 1 << 10, "M": 1 << 20, "G": 1 << 30, "T": 1 << 40, "P": 1 << 50,
}

func parseSizeWith(text string, pattern *regexp.Regexp, factors map[string]float64, unitGroup int) (int64, bool) {
	match := pattern.FindStringSubmatch(strings.TrimSpace(text))
	if match == nil {
		return 0, false
	}
	amount, err := strconv.ParseFloat(strings.Replace(match[1], ",", ".", 1), 64)
	if err != nil || math.IsNaN(amount) || math.IsInf(amount, 0) || amount < 0 {
		return 0, false
	}
	factor, ok := factors[match[unitGroup]]
	if !ok {
		return 0, false
	}
	bytes := amount * factor
	if bytes > float64(math.MaxInt64) {
		return 0, false
	}
	return int64(bytes), true
}

// parseDecimalSize reads apt's 1000-based sizes ("12.3 MB").
func parseDecimalSize(text string) (int64, bool) {
	return parseSizeWith(text, decimalSizePattern, decimalUnitFactor, 2)
}

// parseBinarySize reads dnf's and journalctl's 1024-based sizes ("1.2G").
func parseBinarySize(text string) (int64, bool) {
	return parseSizeWith(text, binarySizePattern, binaryUnitFactor, 2)
}
