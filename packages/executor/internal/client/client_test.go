package client

import "testing"

func TestParseToken(t *testing.T) {
	fp, err := parseToken("ach_abc-DEF_123.0123456789ABCDEF")
	if err != nil || fp != "0123456789abcdef" {
		t.Fatalf("fp = %q, err = %v", fp, err)
	}
	for _, bad := range []string{"", "ach_x", "xyz_x.0123456789abcdef", "ach_x.0123", "ach_x.zzzzzzzzzzzzzzzz"} {
		if _, err := parseToken(bad); err == nil {
			t.Errorf("parseToken(%q) accepted", bad)
		}
	}
}

func TestWSURL(t *testing.T) {
	cases := map[string]string{
		"http://10.0.0.2:8481":     "ws://10.0.0.2:8481/executor/ws",
		"https://ws.example/base/": "wss://ws.example/base/executor/ws",
		"wss://ws.example":         "wss://ws.example/executor/ws",
	}
	for in, want := range cases {
		got, err := wsURL(in)
		if err != nil || got != want {
			t.Errorf("wsURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	if _, err := wsURL("ftp://x"); err == nil {
		t.Error("ftp scheme accepted")
	}
}
