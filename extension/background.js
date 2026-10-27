const HOST = "net.stealthsurf.vpn_host";
const LOCAL_SOCKS_PORT = 10808;
const DAY = 24 * 3600 * 1000;

const DEFAULTS = {
  source: "",
  mode: "all", // all | blocked
  include: "", // домены, которые всегда идут через VPN (в режиме blocked)
  exclude: "", // домены, которые всегда идут напрямую
  listUrls: [
    "https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Russia/inside-raw.lst",
    "https://community.antifilter.download/list/domains.lst",
  ].join("\n"),
  autoUpdate: true,
  killSwitch: true, // не уходить на DIRECT, если прокси недоступен
  bypassLan: true,
  webrtc: true,
  autoConnect: false,
};
// всегда через VPN в режиме "blocked" — нужны для замера скорости и показа IP
const ALWAYS_PROXY = ["speed.cloudflare.com", "api.ipify.org"];

let settings = { ...DEFAULTS };
let state = { status: "off", message: "", server: "" }; // off | connecting | on | error
let endpoint = ""; // строка PAC вида "SOCKS5 127.0.0.1:10808"
let traffic = { downTotal: 0, upTotal: 0, downSess: 0, upSess: 0, sessStart: 0 };
let listInfo = { count: 0, updated: 0 };
let sets = { blocked: new Set(), include: new Set(), exclude: new Set(), always: new Set(ALWAYS_PROXY) };
let port = null;

// ---------- загрузка / сохранение ----------
const boot = (async () => {
  const [l, s] = await Promise.all([
    chrome.storage.local.get(["settings", "url", "traffic", "blocked", "listInfo"]),
    chrome.storage.session.get(["state", "endpoint"]),
  ]);
  settings = { ...DEFAULTS, ...(l.settings || {}) };
  if (!l.settings && l.url) settings.source = l.url; // миграция со старой версии
  if (l.traffic) traffic = { ...traffic, ...l.traffic };
  if (s.state) state = s.state;
  if (s.endpoint) endpoint = s.endpoint;
  if (l.listInfo) listInfo = l.listInfo;
  let blocked = l.blocked;
  if (!blocked) blocked = await loadBundled();
  rebuildSets(blocked);
  if (state.status === "on") startTick(); // service worker перезапустился посреди сессии
})();

async function loadBundled() {
  const txt = await (await fetch(chrome.runtime.getURL("data/blocked.txt"))).text();
  const list = parseDomains(txt);
  listInfo = { count: list.length, updated: 0 };
  await chrome.storage.local.set({ blocked: list, listInfo });
  return list;
}

function parseDomains(text) {
  const out = new Set();
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim().toLowerCase();
    if (!line || line[0] === "#" || line.startsWith("//")) continue;
    line = line.replace(/^(domain|full):/, "").replace(/^\*\./, "").replace(/^\./, "");
    if (/^[a-z0-9.-]+$/.test(line) && !line.includes("..") && !/^[.-]|[.-]$/.test(line)) out.add(line);
  }
  return [...out];
}

function rebuildSets(blockedList) {
  if (blockedList) sets.blocked = new Set(blockedList);
  sets.include = new Set(parseDomains(settings.include));
  sets.exclude = new Set(parseDomains(settings.exclude));
}

function inSet(set, host) {
  for (;;) {
    if (set.has(host)) return true;
    const i = host.indexOf(".");
    if (i < 0) return false;
    host = host.slice(i + 1);
  }
}

function shouldProxy(host) {
  if (inSet(sets.exclude, host)) return false;
  if (settings.mode === "all") return true;
  return inSet(sets.always, host) || inSet(sets.include, host) || inSet(sets.blocked, host);
}

function persistState() {
  chrome.storage.session.set({ state, endpoint });
}

function setState(patch) {
  state = { ...state, ...patch };
  persistState();
  chrome.action.setBadgeText({ text: state.status === "on" ? "ON" : state.status === "connecting" ? "…" : "" });
  chrome.action.setBadgeBackgroundColor({ color: state.status === "on" ? "#0a0" : "#888" });
  chrome.runtime.sendMessage({ type: "state", state }).catch(() => {});
}

// ---------- PAC ----------
function buildPac() {
  const q = (set) => JSON.stringify([...set]);
  const route = endpoint + (settings.killSwitch ? "" : "; DIRECT");
  return `
var P = ${JSON.stringify(route)};
function mk(a){var o={};for(var i=0;i<a.length;i++)o[a[i]]=1;return o;}
var EX = mk(${q(sets.exclude)});
var IN = mk(${q(new Set([...sets.include, ...sets.always]))});
var BL = mk(${settings.mode === "blocked" ? q(sets.blocked) : "[]"});
var ALL = ${settings.mode === "all"};
function has(o,k){return Object.prototype.hasOwnProperty.call(o,k);}
function walk(o,h){for(;;){if(has(o,h))return true;var i=h.indexOf(".");if(i<0)return false;h=h.slice(i+1);}}
function FindProxyForURL(url,host){
  host=host.toLowerCase();
  if(isPlainHostName(host)||host==="localhost")return "DIRECT";
  ${settings.bypassLan ? `if(/^[0-9.]+$/.test(host)&&(isInNet(host,"10.0.0.0","255.0.0.0")||isInNet(host,"172.16.0.0","255.240.0.0")||isInNet(host,"192.168.0.0","255.255.0.0")||isInNet(host,"127.0.0.0","255.0.0.0")||isInNet(host,"169.254.0.0","255.255.0.0")))return "DIRECT";` : ""}
  if(walk(EX,host))return "DIRECT";
  if(ALL||walk(IN,host)||walk(BL,host))return P;
  return "DIRECT";
}`;
}

async function applyProxy() {
  if (state.status !== "on" || !endpoint) return;
  await chrome.proxy.settings.set({
    scope: "regular",
    value: { mode: "pac_script", pacScript: { data: buildPac(), mandatory: true } },
  });
  try {
    if (settings.webrtc) await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: "disable_non_proxied_udp" });
    else await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
  } catch {}
}

async function clearProxy() {
  stopTick();
  await chrome.proxy.settings.clear({ scope: "regular" });
  try { await chrome.privacy.network.webRTCIPHandlingPolicy.clear({}); } catch {}
}

// ---------- прямой прокси / авторизация ----------
function parseDirect(input) {
  let u;
  try { u = new URL(input); } catch { return null; }
  const scheme = u.protocol.slice(0, -1);
  const isProxyScheme = ["socks5", "socks4", "socks", "http"].includes(scheme);
  const isHttpsProxy = scheme === "https" && (u.pathname === "/" || u.pathname === "") && !u.search;
  if (!isProxyScheme && !isHttpsProxy) return null;
  if (!u.hostname || !u.port) return null;
  const pacScheme = { socks5: "SOCKS5", socks: "SOCKS5", socks4: "SOCKS", http: "PROXY", https: "HTTPS" }[scheme];
  return {
    scheme: pacScheme, host: u.hostname, port: Number(u.port),
    user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password),
  };
}

chrome.webRequest.onAuthRequired.addListener(
  (details, cb) => {
    if (!details.isProxy) return cb({});
    chrome.storage.session.get("auth").then(({ auth }) => {
      cb(auth && auth.user ? { authCredentials: { username: auth.user, password: auth.pass } } : {});
    });
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);

// ---------- трафик и скорость ----------
// режим ядра: точные байты из sing-box (clash API хоста); режим прямого прокси: оценка по Content-Length.
let flushTimer = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; chrome.storage.local.set({ traffic }); }, 3000);
}

const HIST = 60;
let speed = { down: 0, up: 0, hist: [] }; // байт/с, история за HIST секунд
let sec = { down: 0, up: 0 };
let realStats = false; // байты приходят от ядра sing-box
let lastHostStats = null;
let tickTimer = null;

function addBytes(down, up) {
  traffic.downTotal += down; traffic.downSess += down;
  traffic.upTotal += up; traffic.upSess += up;
  sec.down += down; sec.up += up;
  scheduleFlush();
}

function startTick() {
  stopTick();
  speed = { down: 0, up: 0, hist: [] };
  sec = { down: 0, up: 0 };
  tickTimer = setInterval(() => {
    // оценка по заголовкам приходит рывками — сглаживаем; данные ядра точные
    const k = realStats ? 1 : 0.35;
    speed.down = speed.down * (1 - k) + sec.down * k;
    speed.up = speed.up * (1 - k) + sec.up * k;
    speed.hist.push([Math.round(speed.down), Math.round(speed.up)]);
    if (speed.hist.length > HIST) speed.hist.shift();
    sec = { down: 0, up: 0 };
  }, 1000);
}

function stopTick() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  speed = { down: 0, up: 0, hist: [] };
}

function onHostStats(m) {
  realStats = true;
  if (lastHostStats) {
    const down = Math.max(0, m.down - lastHostStats.down);
    const up = Math.max(0, m.up - lastHostStats.up);
    addBytes(down, up);
  }
  lastHostStats = { down: m.down, up: m.up };
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (state.status !== "on" || realStats || d.fromCache) return;
    let host;
    try { host = new URL(d.url).hostname.toLowerCase(); } catch { return; }
    if (!shouldProxy(host)) return;
    const h = d.responseHeaders && d.responseHeaders.find((x) => x.name.toLowerCase() === "content-length");
    const down = h ? parseInt(h.value, 10) || 0 : 0;
    addBytes(down, 600 + d.url.length);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// ---------- список заблокированных ----------
async function updateList() {
  await boot;
  const urls = settings.listUrls.split(/\s+/).filter((u) => /^https:\/\//.test(u));
  const all = new Set();
  let ok = 0;
  for (const u of urls) {
    try {
      const r = await fetch(u, { cache: "no-store" });
      if (!r.ok) continue;
      parseDomains(await r.text()).forEach((d) => all.add(d));
      ok++;
    } catch {}
  }
  if (!ok) return { ok: false, error: "Не удалось скачать списки" };
  const list = [...all];
  listInfo = { count: list.length, updated: Date.now() };
  await chrome.storage.local.set({ blocked: list, listInfo });
  rebuildSets(list);
  await applyProxy();
  return { ok: true, listInfo };
}

// ---------- подключение ----------
function disconnectHost() {
  if (port) { try { port.postMessage({ cmd: "stop" }); port.disconnect(); } catch {} port = null; }
}

async function connect() {
  await boot;
  disconnectHost();
  await chrome.storage.session.remove("auth");
  traffic.downSess = traffic.upSess = 0;
  traffic.sessStart = Date.now();
  chrome.storage.local.set({ traffic });
  realStats = false;
  lastHostStats = null;
  startTick();
  if (settings.autoUpdate && Date.now() - listInfo.updated > DAY) updateList(); // фоном, не блокируем

  const input = (settings.source || "").trim();
  if (!input) return setState({ status: "error", message: "Укажите ссылку или ключ в Настройках → Источник", server: "" });
  const direct = parseDirect(input);
  if (direct) {
    if (direct.scheme === "SOCKS5" && direct.user) {
      return setState({ status: "error", message: "SOCKS5 с логином/паролем не поддерживается браузером — используйте http(s) прокси", server: "" });
    }
    if (direct.user) await chrome.storage.session.set({ auth: { user: direct.user, pass: direct.pass } });
    endpoint = `${direct.scheme} ${direct.host}:${direct.port}`;
    setState({ status: "on", message: "Подключено", server: `${direct.host}:${direct.port}` });
    return applyProxy();
  }

  setState({ status: "connecting", message: "Запуск…", server: "" });
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    return setState({ status: "error", message: String(e) });
  }
  port.onMessage.addListener(async (m) => {
    if (m.event === "stats") return onHostStats(m);
    if (m.event === "progress") return setState({ message: m.message });
    if (m.event === "started") {
      endpoint = `SOCKS5 127.0.0.1:${LOCAL_SOCKS_PORT}`;
      setState({ status: "on", message: "Подключено", server: m.server });
      return applyProxy();
    }
    if (m.event === "error") {
      await clearProxy();
      return setState({ status: "error", message: m.message, server: "" });
    }
  });
  port.onDisconnect.addListener(async () => {
    const err = chrome.runtime.lastError?.message;
    port = null;
    if (state.status === "off") return;
    await clearProxy();
    setState({
      status: "error",
      message: "Для VLESS/Hysteria/Trojan и др. нужен хост: запустите install.bat из папки VPN-Browser. Без него работают только socks5/http прокси." + (err ? " [" + err + "]" : ""),
      server: "",
    });
  });
  port.postMessage({ cmd: "start", url: input, socksPort: LOCAL_SOCKS_PORT });
}

async function disconnect() {
  setState({ status: "off", message: "", server: "" });
  disconnectHost();
  stopTick();
  endpoint = "";
  persistState();
  await chrome.storage.session.remove("auth");
  await chrome.storage.local.set({ traffic });
  await clearProxy();
}

// ---------- сообщения ----------
const snapshot = () => ({ state, settings, traffic, speed, realStats, listInfo, listLocal: sets.blocked.size });

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (!msg || msg.type === "state") return false;
  (async () => {
    await boot;
    switch (msg.type) {
      case "getState": return snapshot();
      case "connect": await connect(); return snapshot();
      case "disconnect": await disconnect(); return snapshot();
      case "saveSettings":
        settings = { ...settings, ...msg.settings };
        await chrome.storage.local.set({ settings });
        rebuildSets();
        await applyProxy();
        return snapshot();
      case "updateList": return await updateList();
      case "resetTraffic":
        traffic = { ...traffic, downTotal: 0, upTotal: 0, downSess: 0, upSess: 0 };
        await chrome.storage.local.set({ traffic });
        return snapshot();
    }
  })().then(reply);
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  await boot;
  const { settings: s } = await chrome.storage.local.get("settings");
  if (!s) await chrome.storage.local.set({ settings });
});

chrome.runtime.onStartup.addListener(async () => {
  await boot;
  await clearProxy(); // после перезапуска браузера хоста нет — убираем возможный «висящий» прокси
  setState({ status: "off", message: "", server: "" });
  if (settings.autoConnect) connect();
});
