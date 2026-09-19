package executor

import (
	"errors"
	"strings"
	"testing"
)

// TestRenderBashParamExpansionWordBody covers the word body of a `${name<op>word}`
// expansion. Bash performs command substitution, arithmetic expansion and
// nested parameter expansion inside that word, so it is a word-ish context and
// every construct the dispatcher knows about has to be recognised there —
// copying the remainder of the expansion through raw handed the value to bash.
func TestRenderBashParamExpansionWordBody(t *testing.T) {
	bad := map[string]string{"i": "z[$(id)]"}
	ev := map[string]string{"i": "touch /tmp/pwned"}
	p := map[string]string{"p": "v"}
	n := map[string]string{"n": "5"}

	runRenderCases(t, ScriptTypeBash, []renderCase{
		// --- the confirmed bypasses -------------------------------------
		{
			name:        "default value backtick eval is rejected",
			script:      "echo ${u:-`eval {{i}}`}",
			params:      ev,
			wantErr:     true,
			errContains: "eval",
		},
		{
			name:        "default value command substitution eval is rejected",
			script:      `echo ${u:-$(eval {{i}})}`,
			params:      ev,
			wantErr:     true,
			errContains: "eval",
		},
		{
			name:        "assign-default command substitution eval is rejected",
			script:      `echo ${u:=$(eval {{i}})}`,
			params:      ev,
			wantErr:     true,
			errContains: "eval",
		},
		{
			name:        "alternate-value command substitution eval is rejected",
			script:      `u=1; echo ${u:+$(eval {{i}})}`,
			params:      ev,
			wantErr:     true,
			errContains: "eval",
		},
		{
			name:        "pattern replacement backtick eval is rejected",
			script:      "v=aa; echo ${v/a/`eval {{i}}`}",
			params:      ev,
			wantErr:     true,
			errContains: "eval",
		},
		{
			name:        "default value arithmetic expansion rejects a non-integer",
			script:      `echo ${u:-$(( {{i}} ))}`,
			params:      bad,
			wantErr:     true,
			errContains: "arithmetic",
		},
		{
			name:        "default value nested offset rejects a non-integer",
			script:      `y=abcdefgh; echo ${u:-${y:{{i}}}}`,
			params:      bad,
			wantErr:     true,
			errContains: "arithmetic",
		},
		{
			name:        "default value nested subscript rejects a non-integer",
			script:      `declare -a arr=(1 2); echo ${u:-${arr[{{i}}]}}`,
			params:      bad,
			wantErr:     true,
			errContains: "arithmetic",
		},
		{
			name:        "default value backtick eval inside double quotes is rejected",
			script:      "echo \"${u:-`eval {{i}}`}\"",
			params:      ev,
			wantErr:     true,
			errContains: "eval",
		},
		{
			name:        "default value backtick eval inside an unquoted heredoc is rejected",
			script:      "cat <<EOF\n${u:-`eval {{i}}`}\nEOF\n",
			params:      ev,
			wantErr:     true,
			errContains: "eval",
		},

		// --- an offset region that only appears after a subscript --------
		{
			name:        "offset after a subscript is still arithmetic",
			script:      `echo ${arr[0]:{{i}}}`,
			params:      bad,
			wantErr:     true,
			errContains: "arithmetic",
		},
		{
			name:   "offset after a subscript accepts an integer",
			script: `echo ${arr[0]:{{n}}:2}`,
			params: n,
			want:   `echo ${arr[0]:5:2}`,
		},

		// --- positives: the word body still renders --------------------
		{
			// An UNQUOTED expansion word-splits and globs its result, so the
			// value is spliced in as its own quoted word — bash keeps a quoted
			// span inside the word atomic.
			name:   "unquoted default value renders the one-word form",
			script: `echo ${u:-{{p}}}`,
			params: p,
			want:   `echo ${u:-"${BREEZE_PARAM_P}"}`,
		},
		{
			name:   "unquoted alternate value renders the one-word form",
			script: `u=1; echo ${u:+{{p}}}`,
			params: p,
			want:   `u=1; echo ${u:+"${BREEZE_PARAM_P}"}`,
		},
		{
			// Inside double quotes there is no word splitting and no quote
			// removal, so the bare form is correct and a splice would emit
			// stray quote characters into the value.
			name:   "double-quoted expansion keeps the bare form",
			script: `echo "${u:-{{p}}}"`,
			params: p,
			want:   `echo "${u:-${BREEZE_PARAM_P}}"`,
		},
		{
			name:   "unquoted heredoc body keeps the bare form",
			script: "cat <<EOF\n${u:-{{p}}}\nEOF\n",
			params: p,
			want:   "cat <<EOF\n${u:-${BREEZE_PARAM_P}}\nEOF\n",
		},
		{
			name:    "quoted heredoc rejects the placeholder outright",
			script:  "cat <<'EOF'\n${u:-{{p}}}\nEOF\n",
			params:  p,
			wantErr: true,
		},
		{
			name:   "default value command substitution renders a word reference",
			script: `echo ${u:-$(echo {{p}})}`,
			params: p,
			want:   `echo ${u:-$(echo "${BREEZE_PARAM_P}")}`,
		},
		{
			name:   "double quotes nest fresh inside the word body",
			script: `echo ${u:-"a {{p}} b"}`,
			params: p,
			want:   `echo ${u:-"a ${BREEZE_PARAM_P} b"}`,
		},
		{
			name:   "single quotes in an unquoted word body are spliced",
			script: `echo ${u:-'x{{p}}y'}`,
			params: p,
			want:   `echo ${u:-'x'"${BREEZE_PARAM_P}"'y'}`,
		},
		{
			// Inside double quotes bash keeps the single quotes as literal data
			// and still expands, so the splice form would emit stray quotes.
			name:   "single quotes in an interpolating word body interpolate",
			script: `echo "${u:-'x{{p}}y'}"`,
			params: p,
			want:   `echo "${u:-'x${BREEZE_PARAM_P}y'}"`,
		},
		{
			name:   "a brace inside quotes does not close the expansion",
			script: `echo ${u:-"}" {{p}}}`,
			params: p,
			want:   `echo ${u:-"}" "${BREEZE_PARAM_P}"}`,
		},
		{
			name:   "a brace inside single quotes does not close the expansion",
			script: `echo ${u:-'}' {{p}}}`,
			params: p,
			want:   `echo ${u:-'}' "${BREEZE_PARAM_P}"}`,
		},
		{
			name:   "error-message word renders the one-word form",
			script: `echo ${u:?{{p}}}`,
			params: p,
			want:   `echo ${u:?"${BREEZE_PARAM_P}"}`,
		},
		{
			// The inner expansion decides its own form by walking out to the
			// real enclosing context, which here is unquoted script text.
			name:   "a nested expansion word body renders the one-word form",
			script: `echo ${u:-${v:-{{p}}}}`,
			params: p,
			want:   `echo ${u:-${v:-"${BREEZE_PARAM_P}"}}`,
		},
		{
			name:   "a nested expansion inside double quotes keeps the bare form",
			script: `echo "${u:-${v:-{{p}}}}"`,
			params: p,
			want:   `echo "${u:-${v:-${BREEZE_PARAM_P}}}"`,
		},
		{
			name:   "pattern replacement renders the one-word form",
			script: `echo ${u/a/{{p}}}`,
			params: p,
			want:   `echo ${u/a/"${BREEZE_PARAM_P}"}`,
		},
		{
			// In a pattern position the quotes additionally make the value a
			// LITERAL rather than a glob pattern.
			name:   "prefix removal renders the one-word form",
			script: `echo ${u#{{p}}}`,
			params: p,
			want:   `echo ${u#"${BREEZE_PARAM_P}"}`,
		},
		{
			name:   "suffix removal renders the one-word form",
			script: `echo ${u%%{{p}}}`,
			params: p,
			want:   `echo ${u%%"${BREEZE_PARAM_P}"}`,
		},
		{
			name:   "case modification renders the one-word form",
			script: `echo ${u^{{p}}}`,
			params: p,
			want:   `echo ${u^"${BREEZE_PARAM_P}"}`,
		},
		{
			name:   "a colon after the operator is not an offset",
			script: `echo ${u:-a:{{p}}}`,
			params: p,
			want:   `echo ${u:-a:"${BREEZE_PARAM_P}"}`,
		},
		{
			name:   "subscript then default value is a word body",
			script: `echo ${arr[1]:-{{p}}}`,
			params: p,
			want:   `echo ${arr[1]:-"${BREEZE_PARAM_P}"}`,
		},
		{
			name:   "the expansion closes and the enclosing word resumes",
			script: `echo ${u:-$(( 1 ))} {{p}}`,
			params: p,
			want:   `echo ${u:-$(( 1 ))} "${BREEZE_PARAM_P}"`,
		},
		{
			name:   "indirect expansion is copied through",
			script: `echo ${!u} {{p}}`,
			params: p,
			want:   `echo ${!u} "${BREEZE_PARAM_P}"`,
		},
		{
			name:   "length expansion is copied through",
			script: `echo ${#u} {{p}}`,
			params: p,
			want:   `echo ${#u} "${BREEZE_PARAM_P}"`,
		},
	})
}

// wordishFrames are the frame kinds that bash expands nested constructs inside.
// Each entry embeds a snippet in that frame; `PH` marks where the placeholder
// goes. A single, quoted heredoc or arithmetic frame is deliberately absent:
// the first two expand nothing and the last is already the strictest context.
var wordishFrames = []struct {
	name string
	wrap string // contains "SNIP"
}{
	{name: "code", wrap: "echo SNIP\n"},
	{name: "double quotes", wrap: "echo \"SNIP\"\n"},
	{name: "unquoted heredoc", wrap: "cat <<EOF\nSNIP\nEOF\n"},
	{name: "conditional expression", wrap: "[[ -n SNIP ]]\n"},
	{name: "param word default", wrap: "echo ${u:-SNIP}\n"},
	{name: "param word assign default", wrap: "echo ${u:=SNIP}\n"},
	{name: "param word alternate", wrap: "echo ${u:+SNIP}\n"},
	{name: "param word pattern replacement", wrap: "echo ${u/a/SNIP}\n"},
	{name: "param word prefix removal", wrap: "echo ${u#SNIP}\n"},
	{name: "param word suffix removal", wrap: "echo ${u%%SNIP}\n"},
}

// nestedSnippets are the constructs bash evaluates inside a word-ish frame.
// The value below is neither an integer nor an identifier, so a construct that
// re-interprets it must reject it.
var nestedSnippets = []struct {
	name    string
	snippet string
}{
	{name: "backtick eval", snippet: "`eval PH`"},
	{name: "command substitution eval", snippet: "$(eval PH)"},
	{name: "arithmetic expansion", snippet: "$(( PH ))"},
	{name: "dollar bracket arithmetic", snippet: "$[PH]"},
	{name: "nested offset", snippet: "${y:PH}"},
	{name: "nested subscript", snippet: "${arr[PH]}"},
	{name: "backtick array subscript", snippet: "`a[PH]=1`"},
	{name: "backtick declare -i", snippet: "`declare -i q=PH`"},
	{name: "plain command substitution", snippet: "$(echo PH)"},
	{name: "nested default value", snippet: "${y:-PH}"},
}

// TestRenderBashWordishFramesShareTheNestedDispatcher asserts BY CONSTRUCTION
// that every word-ish frame kind routes nested constructs through the one
// shared dispatcher: the same snippet embedded in any of them must produce the
// same verdict. Three review rounds each found one frame that had grown its own
// partial copy of this list, so membership is the contract under test, not the
// individual case.
func TestRenderBashWordishFramesShareTheNestedDispatcher(t *testing.T) {
	params := map[string]string{"i": "z[$(id)]"}
	for _, snip := range nestedSnippets {
		t.Run(snip.name, func(t *testing.T) {
			var want string
			for i, frame := range wordishFrames {
				script := strings.ReplaceAll(frame.wrap, "SNIP",
					strings.ReplaceAll(snip.snippet, "PH", "{{i}}"))
				got := renderVerdict(script, params)
				if i == 0 {
					want = got
					continue
				}
				if got != want {
					t.Fatalf("frame %q verdict %q, but frame %q gave %q for script %q",
						frame.name, got, wordishFrames[0].name, want, script)
				}
			}
		})
	}
}

// renderVerdict classifies a render outcome: "ok", or the rejection context.
func renderVerdict(script string, params map[string]string) string {
	_, _, err := RenderParameterReferences(script, ScriptTypeBash, params)
	if err == nil {
		return "ok"
	}
	var pre *ParameterRenderError
	if errors.As(err, &pre) {
		return "rejected: " + pre.Context
	}
	return "error: " + err.Error()
}
