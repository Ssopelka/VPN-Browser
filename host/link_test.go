package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestParseLinks(t *testing.T) {
	vm, _ := json.Marshal(map[string]any{"v": "2", "ps": "VM", "add": "vm.example.com", "port": "443", "id": "uuid-1", "aid": "0", "net": "ws", "path": "/ws", "host": "cdn.example.com", "tls": "tls", "sni": "vm.example.com"})
	cases := []struct {
		link, typ, name string
		check           func(t *testing.T, ob obj)
	}{
		{"vless://62f3f0da-666c-4df5-a370-834c9c64034a@1.2.3.4:443?security=reality&sni=example.com&fp=chrome&pbk=PUB&sid=ab12&flow=xtls-rprx-vision&type=tcp#%F0%9F%87%A9%F0%9F%87%AA%20DE", "vless", "🇩🇪 DE", func(t *testing.T, ob obj) {
			tl := ob["tls"].(obj)
			if tl["reality"].(obj)["public_key"] != "PUB" || ob["flow"] != "xtls-rprx-vision" || tl["server_name"] != "example.com" {
				t.Errorf("reality разобран неверно: %v", ob)
			}
		}},
		{"vless://id@host.com:443?security=tls&type=ws&path=%2Fp&host=h.com#x", "vless", "x", func(t *testing.T, ob obj) {
			if ob["transport"].(obj)["path"] != "/p" {
				t.Errorf("ws path: %v", ob["transport"])
			}
		}},
		{"vmess://" + base64.StdEncoding.EncodeToString(vm), "vmess", "VM", func(t *testing.T, ob obj) {
			if ob["server_port"] != 443 || ob["transport"] == nil || ob["tls"] == nil {
				t.Errorf("vmess: %v", ob)
			}
		}},
		{"trojan://p%40ss@t.example.com:443?sni=t.example.com#T", "trojan", "T", func(t *testing.T, ob obj) {
			if ob["password"] != "p@ss" || ob["tls"] == nil {
				t.Errorf("trojan: %v", ob)
			}
		}},
		{"hy2://secret@h.example.com:8443?sni=a.com&insecure=1&obfs=salamander&obfs-password=x#H", "hysteria2", "H", func(t *testing.T, ob obj) {
			if ob["tls"].(obj)["insecure"] != true || ob["obfs"].(obj)["password"] != "x" {
				t.Errorf("hy2: %v", ob)
			}
		}},
		{"hy2://secret@h.example.com#NoPort", "hysteria2", "NoPort", func(t *testing.T, ob obj) {
			if ob["server_port"] != 443 {
				t.Errorf("порт по умолчанию: %v", ob["server_port"])
			}
		}},
		{"tuic://uuid:pw@t.example.com:443?congestion_control=cubic&alpn=h3#TU", "tuic", "TU", func(t *testing.T, ob obj) {
			if ob["password"] != "pw" || ob["congestion_control"] != "cubic" {
				t.Errorf("tuic: %v", ob)
			}
		}},
		{"anytls://pw@a.example.com:443?sni=a.com#AT", "anytls", "AT", nil},
		{"socks5://u:p@127.0.0.1:1080#S", "socks", "S", func(t *testing.T, ob obj) {
			if ob["username"] != "u" || ob["password"] != "p" {
				t.Errorf("socks: %v", ob)
			}
		}},
		{"ss://2022-blake3-aes-128-gcm:abc%3D@1.1.1.1:8388#SS22", "shadowsocks", "SS22", func(t *testing.T, ob obj) {
			if ob["method"] != "2022-blake3-aes-128-gcm" || ob["password"] != "abc=" {
				t.Errorf("ss2022: %v", ob)
			}
		}},
	}
	for _, c := range cases {
		ob, name, err := parseLink(c.link)
		if err != nil {
			t.Fatalf("%s: %v", c.link, err)
		}
		if ob["type"] != c.typ || name != c.name {
			t.Errorf("%s: type=%v name=%q", c.link, ob["type"], name)
		}
		if c.check != nil {
			c.check(t, ob)
		}
	}
}

func TestParseLinkErrors(t *testing.T) {
	for _, l := range []string{"", "garbage", "vless://@:443", "vless://id@h:443?type=xhttp", "foo://a@b:1", "vmess://!!!", "ss://@"} {
		if _, _, err := parseLink(l); err == nil {
			t.Errorf("ожидалась ошибка для %q", l)
		}
	}
}

func TestSelectLink(t *testing.T) {
	plain := "# comment\nfoo://x\nvless://id@h:443#a\nvless://id@h:443#b\n"
	if l, err := selectLink(plain); err != nil || !strings.HasSuffix(l, "#a") {
		t.Errorf("plain: %q %v", l, err)
	}
	b64 := base64.StdEncoding.EncodeToString([]byte(plain))
	if l, err := selectLink(b64); err != nil || !strings.HasSuffix(l, "#a") {
		t.Errorf("base64: %q %v", l, err)
	}
	if _, err := selectLink("nothing here"); err == nil {
		t.Error("ожидалась ошибка для подписки без ссылок")
	}
}

func TestBuildConfigNoClashAPI(t *testing.T) {
	cfg, _, _, err := buildConfig("socks5://1.2.3.4:1080", 12345, "u", "p")
	if err != nil {
		t.Fatal(err)
	}
	s := string(cfg)
	if strings.Contains(s, "clash_api") || strings.Contains(s, "0.0.0.0") || !strings.Contains(s, `"listen":"127.0.0.1"`) {
		t.Errorf("небезопасный конфиг: %s", s)
	}
}
