package hwhealth

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type commandOutput struct {
	args []string
	text string
}
type cliSource struct {
	kind        Kind
	names, dirs []string
	timeout     time.Duration
	commands    [][]string
	expand      func([]commandOutput) [][]string
	parse       func([]commandOutput) Result
	run         toolRunner
}

func (s *cliSource) Name() Kind { return s.kind }
func (s *cliSource) Tier() Tier { return Tier("raid") }
func (s *cliSource) Detect(ctx context.Context) Availability {
	if ctx.Err() != nil {
		return Availability{}
	}
	path, ok := lookupTool(s.names, s.dirs)
	return Availability{Path: path, Available: ok}
}
func (s *cliSource) Collect(ctx context.Context, a Availability) (Result, error) {
	return collectCLI(ctx, s, a)
}
func collectCLI(ctx context.Context, s *cliSource, a Availability) (Result, error) {
	run := s.run
	if run == nil {
		run = runTool
	}
	outputs := []commandOutput{}
	warnings := []string{}
	complete := true
	execute := func(commands [][]string) {
		for _, args := range commands {
			if ctx.Err() != nil {
				complete = false
				warnings = append(warnings, "cycle cancelled")
				break
			}
			out, err := run(ctx, s.timeout, a.Path, args...)
			if err != nil || out.Truncated || (out.ExitCode != 0 && s.kind != "megacli") {
				complete = false
				warnings = append(warnings, fmt.Sprintf("%s: exit=%d truncated=%t error=%v", strings.Join(args, " "), out.ExitCode, out.Truncated, err))
				continue
			}
			if strings.TrimSpace(string(out.Stdout)) == "" {
				complete = false
				warnings = append(warnings, "empty output: "+strings.Join(args, " "))
				continue
			}
			outputs = append(outputs, commandOutput{args: args, text: string(out.Stdout)})
		}
	}
	execute(s.commands)
	if s.expand != nil {
		execute(s.expand(outputs))
	}
	if len(outputs) == 0 {
		return Result{}, fmt.Errorf("%s: no usable command output", s.kind)
	}
	result := s.parse(outputs)
	result.Complete = result.Complete && complete
	result.Warnings = append(result.Warnings, warnings...)
	if result.ToolVersion == "" {
		result.ToolVersion = a.Version
	}
	if len(result.Components) == 0 && !result.Complete {
		return result, fmt.Errorf("%s: no recognizable records", s.kind)
	}
	return result, nil
}
func textFields(text string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), ": ")
		if !ok {
			k, v, ok = strings.Cut(strings.TrimSpace(line), ":")
		}
		// First non-empty value wins: vendor records list their own fields before trailing
		// sub-sections (ports, SEPs, enclosures) whose same-named fields must not overwrite them.
		if key := strings.ToLower(strings.TrimSpace(k)); ok && out[key] == "" {
			out[key] = strings.TrimSpace(v)
		}
	}
	return out
}
func firstText(m map[string]string, keys ...string) string {
	for _, k := range keys {
		if v := m[strings.ToLower(k)]; v != "" {
			return v
		}
	}
	return ""
}
func textInt(s string) int {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return 0
	}
	n, _ := strconv.Atoi(fields[0])
	return n
}
func textPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
func textComponent(source Kind, typ ComponentType, key, parent, name, raw string) Component {
	return Component{ComponentKey: key, ComponentType: typ, ParentKey: textPtr(parent), Source: source, Name: name,
		State: remainingVendorState(source, typ, raw), StateDetail: textPtr(raw), Attributes: map[string]any{}}
}

var sizePattern = regexp.MustCompile(`(?i)([0-9]+(?:\.[0-9]+)?)\s*(bytes|[KMGTP]i?B|[KMGTP])?`)

func textSize(raw string) *int64 {
	m := sizePattern.FindStringSubmatch(raw)
	if m == nil {
		return nil
	}
	n, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return nil
	}
	unit := strings.ToUpper(m[2])
	scale := map[string]float64{"": 1, "BYTES": 1, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12, "PB": 1e15, "K": 1024, "M": 1048576, "G": 1073741824, "T": 1099511627776, "P": 1125899906842624, "KIB": 1024, "MIB": 1048576, "GIB": 1073741824, "TIB": 1099511627776, "PIB": 1125899906842624}[unit]
	if n < 0 || n*scale >= float64(1<<63) {
		return nil
	}
	v := int64(n * scale)
	return &v
}

var temperaturePattern = regexp.MustCompile(`^\s*(-?[0-9]+)`)

// textTemperature reads a leading integer Celsius value ("35C (95.00 F)", "31") and
// returns nil for absent or non-numeric values instead of fabricating 0 °C.
func textTemperature(raw string) *int {
	m := temperaturePattern.FindStringSubmatch(raw)
	if m == nil {
		return nil
	}
	n, err := strconv.Atoi(m[1])
	if err != nil || n < -50 || n > 200 {
		return nil
	}
	return &n
}

var percentPattern = regexp.MustCompile(`([0-9]+(?:\.[0-9]+)?)\s*%`)

func textProgress(raw string) *int {
	m := percentPattern.FindStringSubmatch(raw)
	if m == nil {
		return nil
	}
	n, _ := strconv.ParseFloat(m[1], 64)
	if n < 0 || n > 100 {
		return nil
	}
	p := int(n)
	return &p
}
func cliResult(components []Component, recognized, expected int) Result {
	r := Result{Components: components, Complete: recognized == expected && recognized > 0}
	if !r.Complete {
		r.Warnings = []string{"unrecognized or incomplete command output"}
	}
	return r
}
