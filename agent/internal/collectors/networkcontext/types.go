// Package networkcontext collects passive OS network evidence. It never probes.
package networkcontext

import (
	"context"
	"net/netip"
	"time"
)

type Outcome string

const (
	Complete         Outcome = "complete"
	Partial          Outcome = "partial"
	Failed           Outcome = "failed"
	Unsupported      Outcome = "unsupported"
	NotAttempted     Outcome = "not_attempted"
	MaxEnvelopeBytes         = 512 * 1024
)

type Capability struct {
	Name      string `json:"name"`
	Version   int    `json:"version"`
	Supported bool   `json:"supported"`
}
type Context struct {
	ContextKey string   `json:"contextKey"`
	Families   []string `json:"families"`
}
type Manifest struct {
	Outcome  Outcome   `json:"outcome"`
	Contexts []Context `json:"contexts"`
}
type AddressRow struct {
	Address      string  `json:"address"`
	PrefixLength uint8   `json:"prefixLength"`
	Family       string  `json:"family"`
	Zone         *string `json:"zone"`
	State        string  `json:"state"`
	Assignment   string  `json:"assignment"`
}
type InterfaceRow struct {
	RowKey             string       `json:"rowKey"`
	InterfaceKey       string       `json:"interfaceKey"`
	OSIndex            uint32       `json:"osIndex"`
	Name               string       `json:"name"`
	Kind               string       `json:"kind"`
	AdminState         string       `json:"adminState"`
	OperState          string       `json:"operState"`
	MTU                *uint32      `json:"mtu"`
	Addresses          []AddressRow `json:"addresses"`
	PermanentMAC       string       `json:"permanentMac,omitempty"`
	CurrentMAC         string       `json:"currentMac,omitempty"`
	ParentInterfaceKey string       `json:"parentInterfaceKey,omitempty"`
}
type NextHop struct {
	Address      *string `json:"address"`
	Zone         *string `json:"zone"`
	InterfaceKey *string `json:"interfaceKey"`
	Weight       *uint32 `json:"weight"`
}
type RouteRow struct {
	RowKey            string    `json:"rowKey"`
	Family            string    `json:"family"`
	DestinationPrefix string    `json:"destinationPrefix"`
	InterfaceKey      *string   `json:"interfaceKey"`
	TableKey          string    `json:"tableKey"`
	RouteType         string    `json:"routeType"`
	Metric            *uint32   `json:"metric"`
	NextHops          []NextHop `json:"nextHops"`
	OSFlags           uint32    `json:"osFlags"`
	SourcePrefix      string    `json:"sourcePrefix,omitempty"`
	Protocol          string    `json:"protocol,omitempty"`
	ExpiresInSeconds  *uint32   `json:"expiresInSeconds,omitempty"`
}

// Selector fields are validated by Kind, and remain absent for other variants.
type RuleSelector struct {
	Kind         string  `json:"kind"`
	Prefix       string  `json:"prefix,omitempty"`
	InterfaceKey string  `json:"interfaceKey,omitempty"`
	Value        *uint32 `json:"value,omitempty"`
	Mask         *uint32 `json:"mask,omitempty"`
	Start        *uint32 `json:"start,omitempty"`
	End          *uint32 `json:"end,omitempty"`
}
type RuleRow struct {
	RowKey                   string         `json:"rowKey"`
	Priority                 uint32         `json:"priority"`
	TableKey                 *string        `json:"tableKey"`
	Action                   string         `json:"action"`
	Selectors                []RuleSelector `json:"selectors"`
	SelectorCoverage         string         `json:"selectorCoverage"`
	UnsupportedSelectorKinds []string       `json:"unsupportedSelectorKinds,omitempty"`
}
type Domain struct {
	Name      string `json:"name"`
	RouteOnly bool   `json:"routeOnly"`
}
type ResolverRow struct {
	RowKey       string   `json:"rowKey"`
	Address      string   `json:"address"`
	Zone         *string  `json:"zone"`
	InterfaceKey *string  `json:"interfaceKey"`
	IsLocalStub  bool     `json:"isLocalStub"`
	Port         uint16   `json:"port"`
	Transport    string   `json:"transport"`
	Domains      []Domain `json:"domains"`
	Mechanism    string   `json:"mechanism"`
	ServerName   string   `json:"serverName,omitempty"`
}
type NeighborRow struct {
	RowKey       string  `json:"rowKey"`
	Address      string  `json:"address"`
	Family       string  `json:"family"`
	Zone         *string `json:"zone"`
	InterfaceKey string  `json:"interfaceKey"`
	MAC          *string `json:"mac"`
	State        string  `json:"state"`
	IsRouter     *bool   `json:"isRouter"`
}
type Section[T any] struct {
	Kind            string  `json:"kind"`
	ContextKey      string  `json:"contextKey"`
	AddressFamily   string  `json:"addressFamily,omitempty"`
	ContentDigest   string  `json:"contentDigest"`
	Outcome         Outcome `json:"outcome"`
	ReasonCode      string  `json:"reasonCode,omitempty"`
	RowCount        int     `json:"rowCount"`
	OmittedRowCount int     `json:"omittedRowCount,omitempty"`
	Rows            []T     `json:"rows"`
}
type ResolverSection = Section[ResolverRow]

// Snapshot contains one actual OS read; wire sections are assembled by BuildReport.
type Snapshot struct {
	CapturedAt      time.Time
	Capabilities    []Capability
	ContextManifest Manifest
	Interfaces      []Section[InterfaceRow]
	Routes          []Section[RouteRow]
	Rules           []Section[RuleRow]
	Resolvers       []Section[ResolverRow]
	Neighbors       []Section[NeighborRow]
}
type Reader interface {
	Contexts(context.Context) (Manifest, error)
	Capabilities() []Capability
	Interfaces(context.Context, Context) (Section[InterfaceRow], error)
	Routes(context.Context, Context) (Section[RouteRow], error)
	Rules(context.Context, Context) (Section[RuleRow], error)
	Resolvers(context.Context, Context) (Section[ResolverRow], error)
	Neighbors(context.Context, Context) (Section[NeighborRow], error)
}
type RouteLookupRequest struct {
	Destination  netip.Addr
	Source       netip.Addr
	ContextKey   string
	InterfaceKey string
}
type RouteSelection struct {
	OSIndex       uint32   `json:"-"`
	LocalPrefixes []string `json:"-"`
	ContextKey    string   `json:"contextKey"`
	InterfaceKey  string   `json:"interfaceKey"`
	SourceAddress string   `json:"sourceAddress"`
	NextHop       *string  `json:"nextHop"`
	Zone          *string  `json:"zone"`
	Attribution   string   `json:"attribution"`
}
