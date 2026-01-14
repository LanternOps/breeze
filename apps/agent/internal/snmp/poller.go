// Package snmp provides SNMP polling, discovery, and metric collection
// utilities for the Breeze agent.
package snmp

import (
	"errors"
	"sync"
	"time"

	"go.uber.org/zap"
)

// SNMPPoller manages periodic polling of SNMP devices.
type SNMPPoller struct {
	devices   map[string]SNMPDevice
	interval  time.Duration
	metricsCh chan SNMPMetric
	stopCh    chan struct{}
	doneCh    chan struct{}
	mu        sync.RWMutex
	logger    *zap.Logger
}

// SNMPDevice defines the target and credentials for polling.
type SNMPDevice struct {
	IP             string
	Port           uint16
	Version        SNMPVersion
	Auth           SNMPAuth
	OIDs           []string
	Timeout        time.Duration
	Retries        int
	MaxRepetitions uint32
}

// NewPoller creates a new SNMPPoller.
func NewPoller(interval time.Duration, metricsCh chan SNMPMetric, logger *zap.Logger) *SNMPPoller {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	if logger == nil {
		logger, _ = zap.NewProduction()
	}
	return &SNMPPoller{
		devices:   make(map[string]SNMPDevice),
		interval:  interval,
		metricsCh: metricsCh,
		logger:    logger.Named("snmp_poller"),
	}
}

// Start begins the polling loop.
func (p *SNMPPoller) Start() {
	p.mu.Lock()
	if p.stopCh != nil {
		p.mu.Unlock()
		return
	}
	p.stopCh = make(chan struct{})
	p.doneCh = make(chan struct{})
	interval := p.interval
	p.mu.Unlock()

	p.logger.Info("starting SNMP poller", zap.Duration("interval", interval))
	go p.run()
}

// Stop stops the polling loop.
func (p *SNMPPoller) Stop() {
	p.mu.Lock()
	if p.stopCh == nil {
		p.mu.Unlock()
		return
	}
	close(p.stopCh)
	doneCh := p.doneCh
	p.mu.Unlock()

	<-doneCh

	p.mu.Lock()
	p.stopCh = nil
	p.doneCh = nil
	p.mu.Unlock()

	p.logger.Info("SNMP poller stopped")
}

// Poll polls a single device and returns the metrics.
func (p *SNMPPoller) Poll(device SNMPDevice) ([]SNMPMetric, error) {
	return CollectMetrics(device)
}

// AddDevice adds or updates a device to be polled.
func (p *SNMPPoller) AddDevice(device SNMPDevice) error {
	if device.IP == "" {
		return errors.New("device IP is required")
	}
	p.mu.Lock()
	p.devices[device.IP] = device
	p.mu.Unlock()
	return nil
}

// RemoveDevice removes a device from polling.
func (p *SNMPPoller) RemoveDevice(ip string) {
	if ip == "" {
		return
	}
	p.mu.Lock()
	delete(p.devices, ip)
	p.mu.Unlock()
}

func (p *SNMPPoller) run() {
	defer close(p.doneCh)

	p.pollAll()

	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()

	for {
		select {
		case <-p.stopCh:
			return
		case <-ticker.C:
			p.pollAll()
		}
	}
}

func (p *SNMPPoller) pollAll() {
	devices := p.snapshotDevices()
	if len(devices) == 0 {
		return
	}

	var wg sync.WaitGroup
	for _, device := range devices {
		wg.Add(1)
		go func(d SNMPDevice) {
			defer wg.Done()
			metrics, err := p.Poll(d)
			if err != nil {
				p.logger.Warn("SNMP poll failed", zap.String("device", d.IP), zap.Error(err))
				return
			}
			p.publish(d, metrics)
		}(device)
	}
	wg.Wait()
}

func (p *SNMPPoller) publish(device SNMPDevice, metrics []SNMPMetric) {
	if p.metricsCh == nil {
		return
	}
	for _, metric := range metrics {
		select {
		case p.metricsCh <- metric:
		default:
			p.logger.Warn("dropping SNMP metric", zap.String("device", device.IP), zap.String("oid", metric.OID))
		}
	}
}

func (p *SNMPPoller) snapshotDevices() []SNMPDevice {
	p.mu.RLock()
	defer p.mu.RUnlock()

	devices := make([]SNMPDevice, 0, len(p.devices))
	for _, device := range p.devices {
		devices = append(devices, device)
	}
	return devices
}

func (d SNMPDevice) clientConfig() SNMPClientConfig {
	return SNMPClientConfig{
		Target:         d.IP,
		Port:           d.Port,
		Version:        d.Version,
		Auth:           d.Auth,
		Timeout:        d.Timeout,
		Retries:        d.Retries,
		MaxRepetitions: d.MaxRepetitions,
	}
}
