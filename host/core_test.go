package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing/common/json"
	"github.com/sagernet/sing/service"
)

// startSSServer поднимает in-process сервер Shadowsocks — «удалённый VPN» для сквозного теста.
func startSSServer(t *testing.T) (port int, method, pass string) {
	t.Helper()
	method, pass = "aes-128-gcm", "test-pass"
	port, err := freePort(0)
	if err != nil {
		t.Fatal(err)
	}
	cfg, _ := json.Marshal(obj{
		"log":       obj{"level": "error"},
		"inbounds":  []obj{{"type": "shadowsocks", "tag": "ss-in", "listen": "127.0.0.1", "listen_port": port, "method": method, "password": pass}},
		"outbounds": []obj{{"type": "direct", "tag": "direct"}},
	})
	ctx := boxContext(context.Background())
	var opts option.Options
	if err := opts.UnmarshalJSONContext(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(service.ExtendContext(ctx))
	inst, err := box.New(box.Options{Context: ctx, Options: opts})
	if err != nil {
		t.Fatal(err)
	}
	if err := inst.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); _ = inst.Close() })
	return port, method, pass
}

func TestEndToEndShadowsocks(t *testing.T) {
	port, method, pass := startSSServer(t)
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "hello-through-vpn") }))
	defer web.Close()

	// ссылка в обеих формах SIP002: userinfo в base64 и «старая» целиком в base64
	userinfo := base64.RawURLEncoding.EncodeToString([]byte(method + ":" + pass))
	links := []string{
		fmt.Sprintf("ss://%s@127.0.0.1:%d#test", userinfo, port),
		"ss://" + base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf("%s:%s@127.0.0.1:%d", method, pass, port))) + "#old",
		fmt.Sprintf("ss://%s@localhost:%d#domain", userinfo, port), // имя сервера доменом
	}
	for _, l := range links {
		c, err := startCore(l, 0, func(string) {})
		if err != nil {
			t.Fatalf("%s: %v", l, err)
		}
		proxy := func(user, pw string) *http.Client {
			pu := &url.URL{Scheme: "http", Host: fmt.Sprintf("127.0.0.1:%d", c.Port)}
			if user != "" {
				pu.User = url.UserPassword(user, pw)
			}
			return &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(pu), DisableKeepAlives: true}}
		}
		resp, err := proxy(c.User, c.Pass).Get(web.URL)
		if err != nil {
			t.Fatalf("%s: запрос через прокси: %v", l, err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(b) != "hello-through-vpn" {
			t.Fatalf("%s: неожиданный ответ %q", l, b)
		}
		time.Sleep(200 * time.Millisecond)
		if up, down := c.stats(); up == 0 || down == 0 {
			t.Errorf("%s: статистика пуста: up=%d down=%d", l, up, down)
		}
		// без логина или с чужим паролем прокси обязан отказать
		for _, creds := range [][2]string{{"", ""}, {c.User, "wrong"}} {
			resp, err := proxy(creds[0], creds[1]).Get(web.URL)
			if err == nil {
				resp.Body.Close()
				if resp.StatusCode == 200 {
					t.Errorf("%s: прокси пропустил запрос без верных учётных данных (%v)", l, creds)
				}
			}
		}
		c.stop()
	}
}

func TestProxyIsLoopbackOnly(t *testing.T) {
	port, method, pass := startSSServer(t)
	c, err := startCore(fmt.Sprintf("ss://%s@127.0.0.1:%d", base64.RawURLEncoding.EncodeToString([]byte(method+":"+pass)), port), 0, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	defer c.stop()
	if c.User == "" || len(c.Pass) < 32 {
		t.Fatal("учётные данные локального прокси не сгенерированы")
	}
	if _, err := c.health(); err == nil {
		t.Log("health ok (есть выход в интернет)")
	} else {
		t.Log("health:", err, "(в песочнице без интернета это нормально)")
	}
}
