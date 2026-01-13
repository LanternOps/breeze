package discovery

import (
	"net"
	"time"

	"github.com/google/gopacket"
	"github.com/google/gopacket/layers"
	"github.com/google/gopacket/pcap"
	"go.uber.org/zap"
)

// ScanARP attempts to resolve MAC addresses for targets in the local subnet.
func ScanARP(subnets []*net.IPNet, exclude map[string]struct{}, timeout time.Duration, logger *zap.Logger) (map[string]string, error) {
	results := make(map[string]string)
	if len(subnets) == 0 {
		return results, nil
	}

	if timeout <= 0 {
		timeout = 2 * time.Second
	}

	ifaces, err := net.Interfaces()
	if err != nil {
		return results, err
	}

	var scanErr error
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if len(iface.HardwareAddr) == 0 {
			continue
		}

		ifaceSubnets, err := interfaceSubnets(iface)
		if err != nil {
			logger.Warn("Failed to read interface addresses", zap.String("interface", iface.Name), zap.Error(err))
			continue
		}

		for _, ifaceSubnet := range ifaceSubnets {
			matchingSubnets := filterMatchingSubnets(ifaceSubnet, subnets)
			if len(matchingSubnets) == 0 {
				continue
			}

			handle, err := pcap.OpenLive(iface.Name, 65536, true, timeout)
			if err != nil {
				logger.Warn("Failed to open interface for ARP scan", zap.String("interface", iface.Name), zap.Error(err))
				scanErr = err
				continue
			}
			defer handle.Close()

			if err := handle.SetBPFFilter("arp"); err != nil {
				logger.Warn("Failed to set ARP filter", zap.String("interface", iface.Name), zap.Error(err))
			}

			for _, subnet := range matchingSubnets {
				sendARPRequests(handle, iface, ifaceSubnet.IP, subnet, exclude, logger)
			}

			deadline := time.Now().Add(timeout)
			for time.Now().Before(deadline) {
				data, _, err := handle.ReadPacketData()
				if err != nil {
					if err == pcap.NextErrorTimeoutExpired {
						continue
					}
					break
				}
				packet := gopacket.NewPacket(data, layers.LayerTypeEthernet, gopacket.NoCopy)
				if arpLayer := packet.Layer(layers.LayerTypeARP); arpLayer != nil {
					arp, _ := arpLayer.(*layers.ARP)
					if arp.Operation != layers.ARPReply {
						continue
					}
					ip := net.IP(arp.SourceProtAddress)
					mac := net.HardwareAddr(arp.SourceHwAddress)
					if ip == nil || mac == nil {
						continue
					}
					if _, excluded := exclude[ip.String()]; excluded {
						continue
					}
					results[ip.String()] = mac.String()
				}
			}
		}
	}

	return results, scanErr
}

func interfaceSubnets(iface net.Interface) ([]*net.IPNet, error) {
	var subnets []*net.IPNet
	addrs, err := iface.Addrs()
	if err != nil {
		return nil, err
	}
	for _, addr := range addrs {
		ipNet, ok := addr.(*net.IPNet)
		if !ok || ipNet.IP.To4() == nil {
			continue
		}
		subnets = append(subnets, ipNet)
	}
	return subnets, nil
}

func filterMatchingSubnets(ifaceSubnet *net.IPNet, subnets []*net.IPNet) []*net.IPNet {
	var matches []*net.IPNet
	for _, subnet := range subnets {
		if subnet == nil || subnet.IP.To4() == nil {
			continue
		}
		if subnet.Contains(ifaceSubnet.IP) || ifaceSubnet.Contains(subnet.IP) {
			matches = append(matches, subnet)
		}
	}
	return matches
}

func sendARPRequests(handle *pcap.Handle, iface net.Interface, sourceIP net.IP, subnet *net.IPNet, exclude map[string]struct{}, logger *zap.Logger) {
	if sourceIP == nil || subnet == nil {
		return
	}

	ethernet := layers.Ethernet{
		SrcMAC:       iface.HardwareAddr,
		DstMAC:       net.HardwareAddr{0xff, 0xff, 0xff, 0xff, 0xff, 0xff},
		EthernetType: layers.EthernetTypeARP,
	}

	for ip := subnet.IP.Mask(subnet.Mask); subnet.Contains(ip); incIP(ip) {
		ipCopy := make(net.IP, len(ip))
		copy(ipCopy, ip)
		if ipCopy.To4() == nil {
			continue
		}
		if ipCopy.Equal(sourceIP) {
			continue
		}
		if _, excluded := exclude[ipCopy.String()]; excluded {
			continue
		}

		arp := layers.ARP{
			AddrType:          layers.LinkTypeEthernet,
			Protocol:          layers.EthernetTypeIPv4,
			HwAddressSize:     6,
			ProtAddressSize:   4,
			Operation:         layers.ARPRequest,
			SourceHwAddress:   []byte(iface.HardwareAddr),
			SourceProtAddress: []byte(sourceIP.To4()),
			DstHwAddress:      []byte{0, 0, 0, 0, 0, 0},
			DstProtAddress:    []byte(ipCopy.To4()),
		}

		buffer := gopacket.NewSerializeBuffer()
		opts := gopacket.SerializeOptions{FixLengths: true, ComputeChecksums: true}
		if err := gopacket.SerializeLayers(buffer, opts, &ethernet, &arp); err != nil {
			logger.Debug("Failed to serialize ARP packet", zap.Error(err))
			continue
		}

		if err := handle.WritePacketData(buffer.Bytes()); err != nil {
			logger.Debug("Failed to send ARP request", zap.Error(err))
		}
	}
}
