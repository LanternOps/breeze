package discovery

import (
	"log/slog"
	"math/rand/v2"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
)

var pingSequence uint32

// PingResult holds a responding IP and its round-trip time.
type PingResult struct {
	IP  net.IP
	RTT time.Duration
}

// PingSweep performs an ICMP ping sweep over the target IPs.
// Returns a slice of PingResult with the responding IP and measured RTT.
func PingSweep(targets []net.IP, timeout time.Duration, workers int) []PingResult {
	if len(targets) == 0 {
		return nil
	}
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	if workers <= 0 {
		workers = 128
	}

	// Verify we can open an ICMP socket before spawning workers.
	// Running without root on macOS/Linux will fail here.
	testConn, err := icmp.ListenPacket("ip4:icmp", "0.0.0.0")
	if err != nil {
		slog.Warn("ICMP ping unavailable (requires root/elevated privileges), skipping ping sweep", "error", err)
		return nil
	}
	testConn.Close()

	jobs := make(chan net.IP, workers)
	results := make(chan PingResult, len(targets))
	var wg sync.WaitGroup

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			conn, err := icmp.ListenPacket("ip4:icmp", "0.0.0.0")
			if err != nil {
				slog.Error("ICMP listen failed for worker", "error", err)
				// Drain jobs to prevent deadlock
				for range jobs {
				}
				return
			}
			defer conn.Close()
			for ip := range jobs {
				if rtt, ok := pingWithConn(conn, ip, timeout); ok {
					results <- PingResult{IP: ip, RTT: rtt}
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

	alive := make([]PingResult, 0, len(results))
	for r := range results {
		alive = append(alive, r)
	}
	return alive
}

// pingWithConn pings a single target using a shared ICMP connection.
// Returns the round-trip time and true if the target responded.
func pingWithConn(conn *icmp.PacketConn, ip net.IP, timeout time.Duration) (time.Duration, bool) {
	ip = ip.To4()
	if ip == nil {
		return 0, false
	}

	seq := int(atomic.AddUint32(&pingSequence, 1))
	id := os.Getpid() & 0xffff
	message := icmp.Message{
		Type: ipv4.ICMPTypeEcho,
		Code: 0,
		Body: &icmp.Echo{
			ID:   id,
			Seq:  seq,
			Data: []byte{0x42, 0x52, 0x5a, byte(rand.IntN(256))},
		},
	}
	payload, err := message.Marshal(nil)
	if err != nil {
		return 0, false
	}

	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return 0, false
	}

	sendTime := time.Now()
	if _, err := conn.WriteTo(payload, &net.IPAddr{IP: ip}); err != nil {
		return 0, false
	}

	targetStr := ip.String()
	buffer := make([]byte, 1500)
	for {
		n, peer, err := conn.ReadFrom(buffer)
		if err != nil {
			return 0, false
		}
		if peer == nil {
			continue
		}

		// Only accept replies from the target we pinged
		peerIP := peer.(*net.IPAddr)
		if peerIP.IP.String() != targetStr {
			continue
		}

		parsed, err := icmp.ParseMessage(1, buffer[:n])
		if err != nil {
			return 0, false
		}
		if parsed.Type != ipv4.ICMPTypeEchoReply {
			continue
		}

		// Verify the echo ID and sequence match what we sent
		echo, ok := parsed.Body.(*icmp.Echo)
		if !ok {
			continue
		}
		if echo.ID == id && echo.Seq == seq {
			return time.Since(sendTime), true
		}
	}
}
