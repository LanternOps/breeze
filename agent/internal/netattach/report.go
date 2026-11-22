package netattach

import (
	"context"
	"time"
)

// Report is the heartbeat's networkAttachmentsV1 object (spec §7.1). Field
// order is the JSON order of the spec.
type Report struct {
	Epoch       string             `json:"epoch"`
	Sequence    uint64             `json:"sequence"`
	CapturedAt  string             `json:"capturedAt"` // UTC, RFC 3339, whole seconds
	Complete    bool               `json:"complete"`
	Attachments []ReportAttachment `json:"attachments"` // never nil in a built report
}

// ReportAttachment is one attachment on the wire.
type ReportAttachment struct {
	InterfaceName  string  `json:"interfaceName"`
	LocalAddress   string  `json:"localAddress"`
	PrefixLength   uint8   `json:"prefixLength"`
	GatewayAddress string  `json:"gatewayAddress"`
	GatewayMac     *string `json:"gatewayMac"` // lower-case aa:bb:cc:dd:ee:ff, null when absent
	Primary        bool    `json:"primary"`
}

// BuildReport reads the current attachments and stamps them with the next
// epoch and sequence. A read error gives Complete false with whatever
// attachments came back. A state that cannot produce a sequence gives the zero
// Report (empty Epoch), which the heartbeat never attaches.
func BuildReport(ctx context.Context, st *State, serverHost string, now time.Time) Report {
	return buildReport(ctx, st, serverHost, now, Current)
}

func buildReport(ctx context.Context, st *State, serverHost string, now time.Time,
	cur func(context.Context, string) ([]Attachment, bool, error)) Report {
	attachments, complete, err := cur(ctx, serverHost)
	epoch, sequence, seqErr := st.Next()
	if seqErr != nil {
		log.Warn("network attachment report skipped: no sequence", "error", seqErr.Error())
		return Report{}
	}
	r := Report{
		Epoch:       epoch,
		Sequence:    sequence,
		CapturedAt:  now.UTC().Truncate(time.Second).Format(time.RFC3339),
		Complete:    complete && err == nil,
		Attachments: make([]ReportAttachment, 0, len(attachments)),
	}
	for _, a := range attachments {
		wire := ReportAttachment{
			InterfaceName:  a.InterfaceName,
			LocalAddress:   a.LocalAddress.String(),
			PrefixLength:   a.PrefixLength,
			GatewayAddress: a.GatewayAddress.String(),
			Primary:        a.Primary,
		}
		if len(a.GatewayMAC) == 6 {
			mac := a.GatewayMAC.String() // net.HardwareAddr formats lower-case
			wire.GatewayMac = &mac
		}
		r.Attachments = append(r.Attachments, wire)
	}
	return r
}
