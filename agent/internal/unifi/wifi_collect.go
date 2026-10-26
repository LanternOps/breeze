package unifi

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"sort"

	"github.com/breeze-rmm/agent/internal/topologycanon"
)

// CollectDeviceStatistics reads GET /sites/{siteId}/devices/{deviceId}/statistics/latest
// for one device. 404 = unsupported for that device only; any other failure is
// Failed for that device only (callers keep sibling rows).
func (c *APIClient) CollectDeviceStatistics(ctx context.Context, siteID, deviceID string) (TopologyStatisticsRowV2, topologycanon.Outcome, error) {
	path := fmt.Sprintf("%s/sites/%s/devices/%s/statistics/latest", apiBase, url.PathEscape(siteID), url.PathEscape(deviceID))
	body, status, err := c.getPage(ctx, path, 0)
	if err != nil {
		return TopologyStatisticsRowV2{}, topologycanon.Failed, err
	}
	if status == http.StatusNotFound {
		return TopologyStatisticsRowV2{}, topologycanon.Unsupported, nil
	}
	row, err := parseStatistics(deviceID, body)
	if err != nil {
		return TopologyStatisticsRowV2{}, topologycanon.Failed, fmt.Errorf("unifi api %s: %w", path, err)
	}
	return row, topologycanon.Complete, nil
}

type statsTarget struct {
	site     int
	siteID   string
	deviceID string
}

type statsTally struct {
	rows                         []TopologyStatisticsRowV2
	unsupported, failed, skipped int
}

// assembleWifi builds Snapshot.ResourcesV2 from the v1 poll data plus the
// bounded statistics window.
func (c *APIClient) assembleWifi(ctx context.Context, snap *Snapshot, sites []SiteRef, siteDevices [][]Device, deviceLists, details []Resource, extras map[detailKey]detailV2, opts PollOptions) {
	find := func(rs []Resource, site, kind string) (Resource, bool) {
		for _, r := range rs {
			if r.ControllerSiteID == site && r.Kind == kind {
				return r, true
			}
		}
		return Resource{}, false
	}

	type caps struct{ features, interfaces []string }
	siteCaps := make([]map[string]caps, len(sites))
	var targets []statsTarget
	for i, s := range sites {
		siteCaps[i] = map[string]caps{}
		for _, d := range siteDevices[i] {
			if _, dup := siteCaps[i][d.ID]; dup {
				continue
			}
			f, df := decodeCapabilitySet(d.Features, documentedFeatures)
			in, di := decodeCapabilitySet(d.Interfaces, documentedInterfaces)
			snap.DroppedCapabilityValues += df + di
			siteCaps[i][d.ID] = caps{f, in}
		}
		if o := deviceLists[i].Outcome; o != topologycanon.Complete && o != topologycanon.Partial {
			continue
		}
		for _, row := range deviceLists[i].DeviceList {
			cp := siteCaps[i][row.DeviceID]
			if isAPCandidate(cp.features, cp.interfaces) || extras[detailKey{i, row.DeviceID}].APConfirmed {
				targets = append(targets, statsTarget{site: i, siteID: s.ID, deviceID: row.DeviceID})
			}
		}
	}
	for _, e := range extras {
		snap.DroppedCapabilityValues += e.Dropped
	}
	// Fair, restart-stable order (§6.4).
	sort.Slice(targets, func(a, b int) bool {
		if targets[a].siteID != targets[b].siteID {
			return targets[a].siteID < targets[b].siteID
		}
		return targets[a].deviceID < targets[b].deviceID
	})

	tallies := make([]statsTally, len(sites))
	n := len(targets)
	snap.NextStatisticsCursor = opts.StatisticsCursor
	attempted := 0
	if n > 0 {
		start := ((opts.StatisticsCursor % n) + n) % n
		take := opts.StatisticsBudget
		if take > n {
			take = n
		}
		done := make([]bool, n)
		for k := 0; k < take; k++ {
			if ctx.Err() != nil {
				break // deadline: the rest keep their turn (cursor not advanced past them)
			}
			idx := (start + k) % n
			t := targets[idx]
			attempted++
			done[idx] = true
			row, outcome, _ := c.CollectDeviceStatistics(ctx, t.siteID, t.deviceID)
			switch outcome {
			case topologycanon.Complete:
				tallies[t.site].rows = append(tallies[t.site].rows, row)
			case topologycanon.Unsupported:
				tallies[t.site].unsupported++
			default:
				tallies[t.site].failed++
			}
		}
		for idx, t := range targets {
			if !done[idx] {
				tallies[t.site].skipped++
			}
		}
		snap.NextStatisticsCursor = (start + attempted) % n
	}
	snap.StatisticsAttempted = attempted

	for i, s := range sites {
		dl := deviceLists[i]
		v2dl := ResourceV2{ControllerSiteID: s.ID, Kind: ResourceDeviceList, Outcome: dl.Outcome, ReasonCode: dl.ReasonCode,
			RowCount: dl.RowCount, OmittedRowCount: dl.OmittedRowCount, DeviceList: make([]TopologyDeviceRowV2, 0, len(dl.DeviceList))}
		for _, row := range dl.DeviceList {
			cp := siteCaps[i][row.DeviceID]
			v2dl.DeviceList = append(v2dl.DeviceList, TopologyDeviceRowV2{TopologyDeviceRow: row, Features: cp.features, Interfaces: cp.interfaces})
		}
		snap.ResourcesV2 = append(snap.ResourcesV2, v2dl)

		if cl, ok := find(snap.Resources, s.ID, ResourceClientList); ok {
			snap.ResourcesV2 = append(snap.ResourcesV2, ResourceV2{ControllerSiteID: s.ID, Kind: ResourceClientList, Outcome: cl.Outcome,
				ReasonCode: cl.ReasonCode, RowCount: cl.RowCount, OmittedRowCount: cl.OmittedRowCount, ClientList: cl.ClientList})
		}
		if d, ok := find(details, s.ID, ResourceDeviceDetails); ok {
			v2d := ResourceV2{ControllerSiteID: s.ID, Kind: ResourceDeviceDetails, Outcome: d.Outcome, ReasonCode: d.ReasonCode,
				RowCount: d.RowCount, OmittedRowCount: d.OmittedRowCount, DeviceDetails: make([]TopologyDeviceDetailRowV2, 0, len(d.DeviceDetails))}
			for _, row := range d.DeviceDetails {
				v2d.DeviceDetails = append(v2d.DeviceDetails, TopologyDeviceDetailRowV2{TopologyDeviceDetailRow: row, Radios: extras[detailKey{i, row.RowKey}].Radios})
			}
			snap.ResourcesV2 = append(snap.ResourcesV2, v2d)
		}
		st := ResourceV2{ControllerSiteID: s.ID, Kind: ResourceStatistics}
		finishStatistics(&st, tallies[i], dl.Outcome)
		snap.ResourcesV2 = append(snap.ResourcesV2, st)
	}
}

// finishStatistics maps a site's tally onto the section outcome, reusing the
// existing bounded reasons (limit_exceeded, request_failed, endpoint_unavailable,
// device_list_partial). A target that was not attempted (budget/deadline) is
// reported as omitted coverage, never as a zero-valued row (§13).
func finishStatistics(r *ResourceV2, t statsTally, listOutcome topologycanon.Outcome) {
	if listOutcome != topologycanon.Complete && listOutcome != topologycanon.Partial {
		r.Outcome, r.ReasonCode = topologycanon.NotAttempted, "device_list_unavailable"
		return
	}
	rows, _, _ := finalizeRows(t.rows, func(x TopologyStatisticsRowV2) string { return x.RowKey }, maxDeviceDetailRows)
	r.Statistics, r.RowCount = rows, len(rows)
	ok := len(rows)
	switch {
	case ok == 0 && t.failed == 0 && t.skipped == 0 && t.unsupported > 0:
		r.Outcome, r.ReasonCode, r.Statistics, r.RowCount = topologycanon.Unsupported, "endpoint_unavailable", nil, 0
	case ok == 0 && t.unsupported == 0 && t.skipped == 0 && t.failed > 0:
		r.Outcome, r.ReasonCode, r.Statistics, r.RowCount = topologycanon.Failed, "request_failed", nil, 0
	case t.skipped > 0 && t.failed == 0:
		r.Outcome, r.ReasonCode, r.OmittedRowCount = topologycanon.Partial, "limit_exceeded", t.skipped
	case t.failed > 0 || t.skipped > 0:
		r.Outcome, r.ReasonCode = topologycanon.Partial, "request_failed"
	case t.unsupported > 0:
		r.Outcome, r.ReasonCode = topologycanon.Partial, "endpoint_unavailable"
	case listOutcome == topologycanon.Partial:
		r.Outcome, r.ReasonCode = topologycanon.Partial, "device_list_partial"
	default:
		r.Outcome = topologycanon.Complete
	}
}
