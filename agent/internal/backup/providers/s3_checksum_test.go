package providers

import (
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
)

// #6350: with the SDK default (WhenSupported) an HTTPS PutObject of a known
// length carries a CRC32 trailer as a SINGLE aws-chunked chunk. MinIO rejects
// any chunk over 16 MiB with HTTP 400 "chunk too big", so every file between
// 16 MiB and multipartUploadThreshold failed to upload while the job still
// reported only a partial. The client must therefore be built with
// WhenRequired, for a custom endpoint and for AWS alike (above ~160 GiB the
// multipart part size passes 16 MiB too).
func TestS3Provider_RequestChecksumCalculationIsWhenRequired(t *testing.T) {
	cases := []struct {
		name     string
		endpoint string
	}{
		{name: "custom endpoint (MinIO)", endpoint: "https://minio.example.com:9000"},
		{name: "default AWS endpoint", endpoint: ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := NewS3ProviderWithEndpoint("bucket", "us-east-1", tc.endpoint, "AKID", "SECRET", "")
			client, err := p.getClient()
			if err != nil {
				t.Fatalf("getClient: %v", err)
			}
			if got := client.Options().RequestChecksumCalculation; got != aws.RequestChecksumCalculationWhenRequired {
				t.Errorf("RequestChecksumCalculation = %v, want WhenRequired (%v)", got, aws.RequestChecksumCalculationWhenRequired)
			}
		})
	}
}

// The multipart threshold is only reached ABOVE 100 MB, which is what left the
// 16 MiB..100 MB band on the single-PutObject path in the first place. Pinned
// so a future change to either half of the fix is a deliberate one.
func TestMultipartUploadThresholdUnchanged(t *testing.T) {
	if multipartUploadThreshold != 100*1024*1024 {
		t.Errorf("multipartUploadThreshold = %d, want %d", multipartUploadThreshold, 100*1024*1024)
	}
}
