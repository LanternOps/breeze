package sim

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

const scrapeFixture = `# HELP breeze_db_pool_admission_permits x
# TYPE breeze_db_pool_admission_permits gauge
breeze_db_pool_admission_permits 30
breeze_db_pool_admission_effective_permits 27
breeze_db_pool_admission_in_use 30
breeze_db_pool_admission_waiting 12
breeze_db_pool_admission_abandoned 3
breeze_db_wedged_client_read_backends 1
breeze_nodejs_eventloop_lag_window_max_seconds 0.42
breeze_admission_level 2
breeze_admission_mode{mode="enforce"} 1
`

func TestParseScrape(t *testing.T) {
	s := parseScrape(scrapeFixture)
	if !s.OK || s.Permits != 30 || s.Effective != 27 || s.InUse != 30 || s.Waiting != 12 || s.Abandoned != 3 || s.Wedged != 1 || s.Level != 2 || s.LagMaxS != 0.42 {
		t.Fatalf("%+v", s)
	}
}

// The wedge detector reports -1 until it has observed: unknown, not a failure.
func TestParseScrapeWedgedUnknownStaysOK(t *testing.T) {
	s := parseScrape(strings.Replace(scrapeFixture, "breeze_db_wedged_client_read_backends 1", "breeze_db_wedged_client_read_backends -1", 1))
	if !s.OK || s.Wedged != -1 {
		t.Fatalf("wedged -1 must parse as unknown and keep ok: %+v", s)
	}
}

func TestParseScrapeIsNotOKWhenItCannotSee(t *testing.T) {
	for name, body := range map[string]string{
		"empty":           "",
		"no pool series":  "process_start_time_seconds 1\n",
		"no request pool": strings.Replace(scrapeFixture, "breeze_db_pool_admission_permits 30", "breeze_db_pool_admission_permits -1", 1),
		"NaN":             strings.Replace(scrapeFixture, "_effective_permits 27", "_effective_permits NaN", 1),
		"missing wedged":  strings.Replace(scrapeFixture, "breeze_db_wedged_client_read_backends 1\n", "", 1),
		"negative wait":   strings.Replace(scrapeFixture, "_waiting 12", "_waiting -1", 1),
	} {
		if s := parseScrape(body); s.OK {
			t.Errorf("%s: parsed as ok: %+v", name, s)
		}
	}
}

func TestNotOKSampleHasNoNumbers(t *testing.T) {
	data, err := json.Marshal(PoolSample{T: 3, Error: "HTTP 401"})
	if err != nil {
		t.Fatal(err)
	}
	if got := string(data); got != `{"t":3,"ok":false,"error":"HTTP 401"}` {
		t.Fatalf("a not-ok sample must not carry zero pool numbers: %s", got)
	}
	data, _ = json.Marshal(parseScrape(scrapeFixture))
	if !strings.Contains(string(data), `"wedged":1`) || !strings.Contains(string(data), `"ok":true`) {
		t.Fatalf("ok sample: %s", data)
	}
}

func TestSamplerRecordsFailuresAsNotOK(t *testing.T) {
	f := newFakeAPI(t)
	f.setScrape("tok", scrapeFixture)
	samp := &PoolSampler{URL: f.srv.URL + "/metrics/scrape", Token: "wrong", Interval: 20 * ms, Client: http.DefaultClient, Start: time.Now()}
	ctx, cancel := context.WithTimeout(context.Background(), 70*ms)
	defer cancel()
	samp.Run(ctx)
	got := samp.Samples()
	if len(got) < 2 || got[0].OK {
		t.Fatalf("a 401 scrape must be a not-ok sample, got %+v", got)
	}
}

func TestSamplerReadsThePool(t *testing.T) {
	f := newFakeAPI(t)
	f.setScrape("tok", scrapeFixture)
	samp := &PoolSampler{URL: f.srv.URL + "/metrics/scrape", Token: "tok", Interval: 20 * ms, Client: http.DefaultClient, Start: time.Now()}
	ctx, cancel := context.WithTimeout(context.Background(), 70*ms)
	defer cancel()
	samp.Run(ctx)
	got := samp.Samples()
	if len(got) < 2 || !got[0].OK || got[0].Permits != 30 || got[0].T <= 0 {
		t.Fatalf("samples %+v", got)
	}
	if f.count("GET /metrics/scrape") != 0 {
		t.Fatal("the scrape is not agent traffic and must not be counted as a route")
	}
}
