package hwhealth

import "context"

type Availability struct {
	Path      string
	Version   string
	Available bool
}

type Result struct {
	Components  []Component
	Complete    bool
	Warnings    []string
	ToolVersion string
}

type Source interface {
	Name() Kind
	Tier() Tier
	Detect(context.Context) Availability
	Collect(context.Context, Availability) (Result, error)
}

type source struct {
	kind    Kind
	tier    Tier
	detect  func(context.Context) Availability
	collect func(context.Context, Availability) (Result, error)
}

func (s *source) Name() Kind                                                { return s.kind }
func (s *source) Tier() Tier                                                { return s.tier }
func (s *source) Detect(c context.Context) Availability                     { return s.detect(c) }
func (s *source) Collect(c context.Context, a Availability) (Result, error) { return s.collect(c, a) }
