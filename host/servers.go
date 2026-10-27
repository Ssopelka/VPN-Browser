package main

import (
	"errors"
	"strings"
)

// selectLinks возвращает все поддерживаемые ссылки из тела подписки (обычный текст или base64).
func selectLinks(body string) ([]string, error) {
	text := strings.TrimSpace(body)
	first, _, _ := strings.Cut(text, "\n")
	if !strings.Contains(first, "://") {
		if dec, err := b64Decode(text); err == nil {
			text = dec
		}
	}
	var out []string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if isSupportedLink(line) {
			out = append(out, line)
		}
	}
	if len(out) == 0 {
		return nil, errors.New("в подписке нет поддерживаемых ссылок")
	}
	return out, nil
}

type serverInfo struct {
	Name string `json:"name"`
	Type string `json:"type"`
	link string
}

// parseServers разбирает ссылки и пропускает нечитаемые.
func parseServers(links []string) []serverInfo {
	var out []serverInfo
	for _, l := range links {
		ob, name, err := parseLink(l)
		if err != nil {
			continue
		}
		t, _ := ob["type"].(string)
		out = append(out, serverInfo{Name: name, Type: t, link: l})
	}
	return out
}

// chooseServer выбирает сервер по имени, иначе первый.
func chooseServer(servers []serverInfo, want string) (serverInfo, bool) {
	for _, s := range servers {
		if want != "" && s.Name == want {
			return s, true
		}
	}
	if len(servers) > 0 {
		return servers[0], true
	}
	return serverInfo{}, false
}
