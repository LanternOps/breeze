package executor

import "testing"

func TestRenderPowerShellContexts(t *testing.T) {
	p := map[string]string{"p": "v"}
	runRenderCases(t, ScriptTypePowerShell, []renderCase{
		{
			name:   "unquoted becomes an env reference",
			script: `Write-Output {{p}}`,
			params: p,
			want:   `Write-Output ${env:BREEZE_PARAM_P}`,
		},
		{
			name:   "double quotes keep the literal",
			script: `Write-Output "name={{p}}"`,
			params: p,
			want:   `Write-Output "name=${env:BREEZE_PARAM_P}"`,
		},
		{
			name:   "dollar form is consumed whole",
			script: `Write-Output "${{p}}"`,
			params: p,
			want:   `Write-Output "${env:BREEZE_PARAM_P}"`,
		},
		{
			name:   "single-quoted literal is rewritten to a double-quoted one",
			script: `Write-Output 'name={{p}}'`,
			params: p,
			want:   `Write-Output "name=${env:BREEZE_PARAM_P}"`,
		},
		{
			name:   "author fragments are escaped for their new quoting",
			script: "Write-Output 'v=\"$x`y {{p}} it''s'",
			params: p,
			want:   "Write-Output \"v=`\"`$x``y ${env:BREEZE_PARAM_P} it's\"",
		},
		{
			name:          "single-quoted literal without a parameter is untouched",
			script:        `Write-Output 'it''s $x "q"'`,
			params:        p,
			want:          `Write-Output 'it''s $x "q"'`,
			wantUntouched: true,
		},
		{
			name:   "subexpression inside a string",
			script: `Write-Output "$(Get-Item {{p}})"`,
			params: p,
			want:   `Write-Output "$(Get-Item ${env:BREEZE_PARAM_P})"`,
		},
		{
			name:   "expanding here-string",
			script: "$t = @\"\nv={{p}}\n\"@\n",
			params: p,
			want:   "$t = @\"\nv=${env:BREEZE_PARAM_P}\n\"@\n",
		},
		{
			name:   "line comment reference is inert",
			script: `# uses {{p}}`,
			params: p,
			want:   `# uses ${env:BREEZE_PARAM_P}`,
		},
		{
			name:   "block comment reference is inert",
			script: "<# uses {{p}} #>\nWrite-Output ok",
			params: p,
			want:   "<# uses ${env:BREEZE_PARAM_P} #>\nWrite-Output ok",
		},
		{
			name:          "unknown key is left as written",
			script:        `Write-Output "{{nope}}"`,
			params:        p,
			want:          `Write-Output "{{nope}}"`,
			wantUntouched: true,
		},
		{
			name:        "literal here-string is rejected",
			script:      "$t = @'\nv={{p}}\n'@\n",
			params:      p,
			wantErr:     true,
			errContains: "literal here-string",
		},
		{
			name:        "Invoke-Expression is rejected",
			script:      `Invoke-Expression "Get-Item {{p}}"`,
			params:      p,
			wantErr:     true,
			errContains: "Invoke-Expression",
		},
		{
			name:        "iex alias is rejected",
			script:      `iex "Get-Item {{p}}"`,
			params:      p,
			wantErr:     true,
			errContains: "Invoke-Expression",
		},
		{
			name:        "iex with a single-quoted argument is rejected",
			script:      `iex 'Get-Item {{p}}'`,
			params:      p,
			wantErr:     true,
			errContains: "Invoke-Expression",
		},
	})
}

func TestRenderPowerShellNumericPassthrough(t *testing.T) {
	runRenderCases(t, ScriptTypePowerShell, []renderCase{
		{
			name:   "unquoted integer stays a number",
			script: `$x = {{n}}`,
			params: map[string]string{"n": "42"},
			want:   `$x = 42`,
		},
		{
			name:   "unquoted decimal stays a number",
			script: `$x = {{n}}`,
			params: map[string]string{"n": "-1.5"},
			want:   `$x = -1.5`,
		},
		{
			name:   "non-numeric unquoted value is a reference",
			script: `$x = {{n}}`,
			params: map[string]string{"n": "42 percent"},
			want:   `$x = ${env:BREEZE_PARAM_N}`,
		},
		{
			name:   "inside double quotes there is no passthrough",
			script: `$x = "{{n}}"`,
			params: map[string]string{"n": "42"},
			want:   `$x = "${env:BREEZE_PARAM_N}"`,
		},
	})
}
