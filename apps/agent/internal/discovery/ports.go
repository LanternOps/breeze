package discovery

import (
	"fmt"
	"net"
	"sort"
	"sync"
	"time"

	"go.uber.org/zap"
)

// PortRange defines a range of ports to scan.
type PortRange struct {
	Start int
	End   int
}

// ScanPorts scans TCP ports for the provided targets.
func ScanPorts(targets []net.IP, portRanges []PortRange, timeout time.Duration, workers int, logger *zap.Logger) map[string][]OpenPort {
	results := make(map[string][]OpenPort)
	if len(targets) == 0 || len(portRanges) == 0 {
		return results
	}
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	if workers <= 0 {
		workers = 128
	}

	jobs := make(chan portJob)
	var wg sync.WaitGroup
	var mu sync.Mutex

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range jobs {
				if scanPort(job.IP, job.Port, timeout) {
					service := identifyService(job.Port)
					mu.Lock()
					results[job.IP.String()] = append(results[job.IP.String()], OpenPort{Port: job.Port, Service: service})
					mu.Unlock()
				}
			}
		}()
	}

	for _, target := range targets {
		for _, portRange := range portRanges {
			for port := portRange.Start; port <= portRange.End; port++ {
				jobs <- portJob{IP: target, Port: port}
			}
		}
	}
	close(jobs)

	wg.Wait()

	for ip := range results {
		ports := results[ip]
		sort.Slice(ports, func(i, j int) bool { return ports[i].Port < ports[j].Port })
		results[ip] = ports
	}

	logger.Debug("Port scan completed", zap.Int("targets", len(targets)))
	return results
}

type portJob struct {
	IP   net.IP
	Port int
}

func scanPort(ip net.IP, port int, timeout time.Duration) bool {
	address := net.JoinHostPort(ip.String(), formatPort(port))
	conn, err := net.DialTimeout("tcp", address, timeout)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func formatPort(port int) string {
	return fmt.Sprintf("%d", port)
}

func identifyService(port int) string {
	switch port {
	case 22:
		return "ssh"
	case 23:
		return "telnet"
	case 25:
		return "smtp"
	case 53:
		return "dns"
	case 80:
		return "http"
	case 110:
		return "pop3"
	case 135:
		return "rpc"
	case 139:
		return "netbios-ssn"
	case 143:
		return "imap"
	case 161:
		return "snmp"
	case 443:
		return "https"
	case 445:
		return "smb"
	case 465:
		return "smtps"
	case 587:
		return "smtp"
	case 631:
		return "ipp"
	case 993:
		return "imaps"
	case 995:
		return "pop3s"
	case 1433:
		return "mssql"
	case 1521:
		return "oracle"
	case 2049:
		return "nfs"
	case 3306:
		return "mysql"
	case 3389:
		return "rdp"
	case 5432:
		return "postgres"
	case 5672:
		return "amqp"
	case 5985:
		return "winrm"
	case 5986:
		return "winrm"
	case 6379:
		return "redis"
	case 8080:
		return "http-alt"
	case 8443:
		return "https-alt"
	case 9100:
		return "printer"
	default:
		return ""
	}
}
