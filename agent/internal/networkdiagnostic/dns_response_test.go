package networkdiagnostic

import (
	"golang.org/x/net/dns/dnsmessage"
	"testing"
)

func TestDNSResponseQuestionAndAnswerChain(t *testing.T) {
	name := dnsmessage.MustNewName("status.example.test.")
	other := dnsmessage.MustNewName("other.example.test.")
	address := func(owner dnsmessage.Name) dnsmessage.Resource {
		return dnsmessage.Resource{Header: dnsmessage.ResourceHeader{Name: owner, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}, Body: &dnsmessage.AResource{A: [4]byte{192, 0, 2, 20}}}
	}
	for _, tc := range []struct {
		name     string
		question dnsmessage.Name
		answers  []dnsmessage.Resource
		want     int
		bad      bool
	}{
		{"wrong question", other, []dnsmessage.Resource{address(name)}, 0, true},
		{"unrelated answer", name, []dnsmessage.Resource{address(other)}, 0, false},
		{"duplicate addresses", name, []dnsmessage.Resource{address(name), address(name), address(name)}, 1, false},
		{"valid cname", name, []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{Name: name, Type: dnsmessage.TypeCNAME, Class: dnsmessage.ClassINET}, Body: &dnsmessage.CNAMEResource{CNAME: other}}, address(other)}, 1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := dnsmessage.Message{Header: dnsmessage.Header{ID: 123, Response: true}, Questions: []dnsmessage.Question{{Name: tc.question, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}}, Answers: tc.answers}
			wire, err := response.Pack()
			if err != nil {
				t.Fatal(err)
			}
			got, err := parseDNSResponse(wire, 123, name, dnsmessage.TypeA)
			if (err != nil) != tc.bad || len(got) != tc.want {
				t.Fatal(got, err)
			}
		})
	}
}
