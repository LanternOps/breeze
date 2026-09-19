package recoveryconsole

import "testing"

func TestParseKernelCmdline(t *testing.T) {
	cases := []struct {
		name      string
		cmdline   string
		wantMedia bool
		wantCI    bool
		want      Answers
	}{
		{
			name:      "media only",
			cmdline:   "console=tty0 breeze.media=1",
			wantMedia: true,
			wantCI:    false,
			want:      Answers{},
		},
		{
			name:      "full ci answers",
			cmdline:   "breeze.media=1 breeze.ci=1 breeze.server=http://10.0.2.2:8080 breeze.code=ABC-DEF-GHJ breeze.target=/dev/sda breeze.confirm=ERASE breeze.after=poweroff breeze.insecure=1",
			wantMedia: true,
			wantCI:    true,
			want: Answers{
				Server:   "http://10.0.2.2:8080",
				Code:     "ABC-DEF-GHJ",
				Target:   "/dev/sda",
				Confirm:  "ERASE",
				After:    "poweroff",
				Insecure: true,
			},
		},
		{
			name:      "empty",
			cmdline:   "",
			wantMedia: false,
			wantCI:    false,
			want:      Answers{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			media, ci, a := ParseKernelCmdline(tc.cmdline)
			if media != tc.wantMedia {
				t.Errorf("media = %v, want %v", media, tc.wantMedia)
			}
			if ci != tc.wantCI {
				t.Errorf("ci = %v, want %v", ci, tc.wantCI)
			}
			if a != tc.want {
				t.Errorf("answers = %+v, want %+v", a, tc.want)
			}
		})
	}
}
