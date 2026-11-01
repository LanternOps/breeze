//go:build !darwin || !cgo

package tccdiag

// Supported reports whether this build can diagnose (darwin with cgo).
const Supported = false

// Run has nothing to read off macOS, or in a macOS build without cgo.
func Run(services []Service) Diagnosis {
	d := Diagnosis{Signing: Signing{Kind: SigningUnknown}}
	for _, svc := range services {
		d.Services = append(d.Services, ServiceDiagnosis{
			Service: svc,
			Error:   "TCC diagnosis needs macOS with cgo",
			Verdict: VerdictUnobservable,
		})
	}
	d.Verdict = overallVerdict(d.Services)
	return d
}
