package userhelper

import (
	"strings"

	"github.com/breeze-rmm/agent/internal/ipc"
)

const (
	maxNotifyTitleBytes = 256
	maxNotifyBodyBytes  = 2048
	maxNotifyIconBytes  = 512
)

var allowedNotifyUrgencies = map[string]struct{}{
	"":         {},
	"low":      {},
	"normal":   {},
	"critical": {},
}

func sanitizeNotifyRequest(req ipc.NotifyRequest) ipc.NotifyRequest {
	req.Title = trimNotifyField(req.Title, maxNotifyTitleBytes)
	req.Body = trimNotifyField(req.Body, maxNotifyBodyBytes)
	req.Icon = trimNotifyField(req.Icon, maxNotifyIconBytes)
	req.Urgency = strings.ToLower(strings.TrimSpace(req.Urgency))
	if _, ok := allowedNotifyUrgencies[req.Urgency]; !ok {
		req.Urgency = ""
	}
	if len(req.Actions) > 4 {
		req.Actions = req.Actions[:4]
	}
	for i := range req.Actions {
		req.Actions[i] = trimNotifyField(req.Actions[i], maxNotifyTitleBytes)
	}
	return req
}

func trimNotifyField(value string, max int) string {
	value = strings.TrimSpace(value)
	if max <= 0 || len(value) <= max {
		return value
	}
	return value[:max]
}
