package executor

import (
	"fmt"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

// Script parameters are DATA, never code.
//
// Historically SubstituteParameters spliced the server-supplied parameter
// VALUE straight into the script text (`strings.ReplaceAll`), so any
// `{{key}}` placeholder was an injection point for a scripts:execute
// principal: `echo {{name}}` with name=`x; rm -rf ~` ran two commands.
//
// RenderParameterReferences instead rewrites every placeholder into a
// language-native REFERENCE to the `BREEZE_PARAM_<KEY>` environment variable
// that buildEnvironment already exports for the same parameter. The value
// never reaches the script file, so a miss in the context scanner below can
// only produce wrong OUTPUT (a literal `${...}` in the wrong place), never
// code execution — the failure mode degrades safe, which is why this is
// preferred over context-aware escaping (escaping degrades to injection).
//
// Contexts where an environment reference cannot carry the value safely
// (bash arithmetic, a quoted heredoc, a PowerShell literal here-string, …)
// are rejected with a *ParameterRenderError naming the parameter and the
// recommended alternative. Execute fails the run without executing anything.

// placeholderPattern is the shared placeholder grammar. It is anchored: the
// scanners match it at a specific offset, never search with it, because only
// the scanner knows whether that offset is script text or a quoted string.
// A leading `$` (the `${{key}}` form) is part of the match and is consumed
// with it — the old substituter replaced `{{key}}` first and left the `$`
// behind, which bash then read as its own expansion.
var placeholderPattern = regexp.MustCompile(`^\$?\{\{([A-Za-z0-9_-]+)\}\}`)

// paramEnvPrefix is the environment-variable prefix buildEnvironment uses.
const paramEnvPrefix = "BREEZE_PARAM_"

// parameterEnvName maps a parameter key to its environment variable name.
// It MUST stay identical to the mapping in Executor.buildEnvironment.
func parameterEnvName(key string) string {
	return paramEnvPrefix + strings.ToUpper(strings.ReplaceAll(key, "-", "_"))
}

var (
	// integerValuePattern gates the bash arithmetic contexts, where bash
	// evaluates variable CONTENTS as an expression (`x='a[$(id)]'` inside
	// `$(( x ))` runs `id`), so only a digits-only literal may be emitted.
	integerValuePattern = regexp.MustCompile(`^-?[0-9]{1,18}$`)
	// decimalValuePattern gates the numeric passthroughs where the point is
	// to keep the value typed as a number rather than a string.
	decimalValuePattern = regexp.MustCompile(`^-?[0-9]{1,18}(\.[0-9]{1,18})?$`)
	// identifierValuePattern gates variable-NAME positions (`read {{var}}`).
	identifierValuePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

// ParameterRenderError reports a placeholder that cannot be turned into a safe
// reference in the syntactic context it appears in.
type ParameterRenderError struct {
	// Param is the parameter key as the script author wrote it.
	Param string
	// Context describes where the placeholder appeared, e.g.
	// "a bash arithmetic expression".
	Context string
	// Hint is the recommended alternative for the script author.
	Hint string
}

func (e *ParameterRenderError) Error() string {
	return fmt.Sprintf("parameter %q cannot be safely substituted in %s: %s", e.Param, e.Context, e.Hint)
}

func renderErr(param, context, hint string) error {
	return &ParameterRenderError{Param: param, Context: context, Hint: hint}
}

// RenderParameterReferences rewrites `{{key}}` / `${{key}}` placeholders in a
// script into references to the parameter's BREEZE_PARAM_* environment
// variable, choosing the reference form from the syntactic context.
//
// It returns the rendered script, whether at least one placeholder was
// rewritten (callers use this to gate interpreter flags and the `bash -n`
// syntax check), and an error for any placeholder that cannot be rendered
// safely. Placeholders whose key is not in params are left untouched, which is
// what the old substituter did.
func RenderParameterReferences(content, scriptType string, params map[string]string) (string, bool, error) {
	if len(params) == 0 || content == "" {
		return content, false, nil
	}
	if err := checkParameterKeyCollisions(params); err != nil {
		return "", false, err
	}
	switch renderLanguage(scriptType) {
	case ScriptTypePowerShell:
		return renderPowerShellParameters(content, params)
	case ScriptTypePython:
		return renderPythonParameters(content, params)
	case ScriptTypeCMD:
		return renderCMDParameters(content, params)
	default:
		return renderBashParameters(content, params)
	}
}

// renderLanguage normalises a script type to the language whose grammar the
// script is parsed with. Unknown types mirror GetShellCommand's default.
func renderLanguage(scriptType string) string {
	switch strings.ToLower(scriptType) {
	case ScriptTypePowerShell:
		return ScriptTypePowerShell
	case ScriptTypePython:
		return ScriptTypePython
	case ScriptTypeCMD:
		return ScriptTypeCMD
	case ScriptTypeBash:
		return ScriptTypeBash
	default:
		if runtime.GOOS == "windows" {
			return ScriptTypeCMD
		}
		return ScriptTypeBash
	}
}

// checkParameterKeyCollisions refuses a parameter set where two keys map to the
// same BREEZE_PARAM_ name (`a-b` and `a_b`, or `Path` and `PATH`). Both the
// environment and every reference we emit are keyed on that name, so one value
// would silently win and the script would read the wrong parameter.
func checkParameterKeyCollisions(params map[string]string) error {
	byEnv := make(map[string][]string, len(params))
	for key := range params {
		name := parameterEnvName(key)
		byEnv[name] = append(byEnv[name], key)
	}
	var offenders []string
	for name, keys := range byEnv {
		if len(keys) < 2 {
			continue
		}
		sort.Strings(keys)
		offenders = append(offenders, fmt.Sprintf("%s (from %s)", name, strings.Join(keys, ", ")))
	}
	if len(offenders) == 0 {
		return nil
	}
	sort.Strings(offenders)
	return fmt.Errorf("script parameter keys collide in the environment: %s; rename one of them", strings.Join(offenders, "; "))
}

// scanner is the shared cursor every language renderer walks the script with.
type scanner struct {
	src    string
	i      int
	out    strings.Builder
	params map[string]string
	used   bool
}

func newScanner(src string, params map[string]string) *scanner {
	s := &scanner{src: src, params: params}
	s.out.Grow(len(src) + 32)
	return s
}

func (s *scanner) done() bool { return s.i >= len(s.src) }

func (s *scanner) cur() byte { return s.src[s.i] }

func (s *scanner) hasPrefix(p string) bool { return strings.HasPrefix(s.src[s.i:], p) }

// copyN copies n bytes verbatim from the input to the output.
func (s *scanner) copyN(n int) {
	if s.i+n > len(s.src) {
		n = len(s.src) - s.i
	}
	s.out.WriteString(s.src[s.i : s.i+n])
	s.i += n
}

func (s *scanner) copyByte() { s.copyN(1) }

// placeholder reports the placeholder starting at the cursor, if any.
func (s *scanner) placeholder() (key string, width int, ok bool) {
	if s.done() {
		return "", 0, false
	}
	if c := s.cur(); c != '{' && c != '$' {
		return "", 0, false
	}
	m := placeholderPattern.FindStringSubmatch(s.src[s.i:])
	if m == nil {
		return "", 0, false
	}
	return m[1], len(m[0]), true
}

// value resolves a placeholder key. Unknown keys are not parameters and stay
// in the script exactly as the author wrote them.
func (s *scanner) value(key string) (string, bool) {
	v, ok := s.params[key]
	return v, ok
}

// emit writes a rendered reference and advances past the placeholder.
func (s *scanner) emit(text string, width int) {
	s.out.WriteString(text)
	s.i += width
	s.used = true
}

// skipLiteral copies an unknown placeholder through untouched.
func (s *scanner) skipLiteral(width int) { s.copyN(width) }

// lineStart returns the offset just after the newline preceding pos.
func lineStart(src string, pos int) int {
	if idx := strings.LastIndexByte(src[:pos], '\n'); idx >= 0 {
		return idx + 1
	}
	return 0
}

// prevToken returns the whitespace-delimited token ending before pos.
func prevToken(src string, pos int) string {
	j := pos
	for j > 0 && isSpaceByte(src[j-1]) {
		j--
	}
	end := j
	for j > 0 && !isSpaceByte(src[j-1]) {
		j--
	}
	return src[j:end]
}

// nextToken returns the whitespace-delimited token starting at or after pos.
func nextToken(src string, pos int) string {
	j := pos
	for j < len(src) && isSpaceByte(src[j]) {
		j++
	}
	start := j
	for j < len(src) && !isSpaceByte(src[j]) {
		j++
	}
	return src[start:j]
}

func isSpaceByte(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}

func isIdentByte(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

func containsNewline(s string) bool {
	return strings.ContainsAny(s, "\r\n")
}
