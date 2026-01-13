package discovery

import (
	"math/rand"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
)

var pingSequence uint32

// PingSweep performs an ICMP ping sweep over the target IPs.
func PingSweep(targets []net.IP, timeout time.Duration, workers int, logger *zap.Logger) []net.IP {
	if len(targets) == 0 {
		return nil
	}
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	if workers <= 0 {
		workers = 128
	}

	jobs := make(chan net.IP)
	results := make(chan net.IP, len(targets))
	var wg sync.WaitGroup

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ip := range jobs {
				if pingOnce(ip, timeout, logger) {
					results <- ip
				}
			}
		}()
	}

	for _, target := range targets {
		jobs <- target
	}
	close(jobs)

	wg.Wait()
	close(results)

	alive := make([]net.IP, 0, len(results))
	for ip := range results {
		alive = append(alive, ip)
	}
	return alive
}

func pingOnce(ip net.IP, timeout time.Duration, logger *zap.Logger) bool {
	ip = ip.To4()
	if ip == nil {
		return false
	}

	conn, err := icmp.ListenPacket("ip4:icmp", "0.0.0.0")
	if err != nil {
		logger.Debug("ICMP listen failed", zap.Error(err))
		return false
	}
	defer conn.Close()

	seq := int(atomic.AddUint32(&pingSequence, 1))
	id := os.Getpid() & 0xffff
	message := icmp.Message{
		Type: ipv4.ICMPTypeEcho,
		Code: 0,
		Body: &icmp.Echo{
			ID:   id,
			Seq:  seq,
			Data: []byte{0x42, 0x52, 0x5a, byte(rand.Intn(255))},
		},
	}
	payload, err := message.Marshal(nil)
	if err != nil {
		return false
	}

	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return false
	}

	if _, err := conn.WriteTo(payload, &net.IPAddr{IP: ip}); err != nil {
		return false
	}

	buffer := make([]byte, 1500)
	for {
		n, peer, err := conn.ReadFrom(buffer)
		if err != nil {
			return false
		}
		if peer == nil {
			continue
		}
		parsed, err := icmp.ParseMessage(1, buffer[:n])
		if err != nil {
			return false
		}
		if parsed.Type == ipv4.ICMPTypeEchoReply {
			return true
		}
	}
}
