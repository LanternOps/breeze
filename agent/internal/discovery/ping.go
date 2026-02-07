package discovery

import (
	"log/slog"
	"math/rand"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
)

var pingSequence uint32

// PingSweep performs an ICMP ping sweep over the target IPs.
func PingSweep(targets []net.IP, timeout time.Duration, workers int) []net.IP {
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
			// Share one ICMP socket per worker instead of one per target
			conn, err := icmp.ListenPacket("ip4:icmp", "0.0.0.0")
			if err != nil {
				slog.Error("ICMP listen failed for worker", "error", err)
				return
			}
			defer conn.Close()
			for ip := range jobs {
				if pingWithConn(conn, ip, timeout) {
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

// pingWithConn pings a single target using a shared ICMP connection.
func pingWithConn(conn *icmp.PacketConn, ip net.IP, timeout time.Duration) bool {
	ip = ip.To4()
	if ip == nil {
		return false
	}

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
