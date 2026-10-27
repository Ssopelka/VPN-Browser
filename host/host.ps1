# Native messaging host (PowerShell, без Python): загружает подписку, запускает sing-box, шлёт статистику.
# Поддерживаемые ссылки: vless, vmess, trojan, ss, hysteria2/hy2, hysteria, tuic, anytls, socks.
# ВАЖНО: в stdout можно писать только сообщения протокола — любой лишний вывод ломает связь с браузером.
param(
    [switch]$NoMain,
    [Parameter(ValueFromRemainingArguments = $true)]$Rest  # браузер передаёт origin и --parent-window
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Here = $PSScriptRoot
$BinDir = Join-Path $Here 'bin'
$Core = Join-Path $BinDir 'sing-box.exe'
$Cfg = Join-Path $Here 'core-config.json'
$ReleaseApi = 'https://api.github.com/repos/SagerNet/sing-box/releases/latest'
$ApiAddr = '127.0.0.1:10086'
$Schemes = @('vless', 'vmess', 'trojan', 'ss', 'hysteria2', 'hy2', 'hysteria', 'tuic', 'anytls', 'socks', 'socks5')
$Utf8 = New-Object System.Text.UTF8Encoding($false)

$script:proc = $null
$script:running = $false

# ---------- native messaging ----------
$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Send-Msg($obj) {
    $bytes = $Utf8.GetBytes((ConvertTo-Json $obj -Depth 20 -Compress))
    $stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

function Send-Progress([string]$text) { Send-Msg ([ordered]@{ event = 'progress'; message = $text }) }

function Read-Exact([byte[]]$buf, [int]$off, [int]$n) {
    while ($off -lt $n) {
        $r = $stdin.Read($buf, $off, $n - $off)
        if ($r -le 0) { return $false }
        $off += $r
    }
    return $true
}

# ---------- сеть ----------
function Get-Bytes([string]$url, [string]$ua = 'v2rayN/6.0') {
    $wc = New-Object Net.WebClient
    $wc.Headers['User-Agent'] = $ua
    try { return , $wc.DownloadData($url) } finally { $wc.Dispose() }
}

function Get-Text([string]$url, [string]$ua = 'v2rayN/6.0') { $Utf8.GetString((Get-Bytes $url $ua)) }

# ---------- ядро ----------
function Ensure-Core {
    if (Test-Path $Core) { return }
    $null = New-Item -ItemType Directory -Force -Path $BinDir
    Send-Progress 'Скачиваю sing-box…'
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
    $rel = Get-Text $ReleaseApi 'vpn-terminal' | ConvertFrom-Json
    $asset = $rel.assets | Where-Object { $_.name -like "*windows-$arch.zip" -and $_.name -notlike '*legacy*' } | Select-Object -First 1
    if (-not $asset) { throw 'Не найден архив sing-box для Windows' }
    $blob = Get-Bytes $asset.browser_download_url 'vpn-terminal'
    if ($asset.digest -and $asset.digest.StartsWith('sha256:')) {
        $sha = [Security.Cryptography.SHA256]::Create()
        $hex = -join ($sha.ComputeHash($blob) | ForEach-Object { $_.ToString('x2') })
        if ($hex -ne $asset.digest.Substring(7).ToLower()) { throw 'SHA-256 sing-box не совпал, отмена' }
    }
    $zip = New-Object IO.Compression.ZipArchive((New-Object IO.MemoryStream(, $blob)))
    try {
        $entry = $zip.Entries | Where-Object { $_.Name -eq 'sing-box.exe' } | Select-Object -First 1
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $Core, $true)
    } finally { $zip.Dispose() }
}

# ---------- разбор ссылок ----------
function Unesc([string]$s) { if ($null -eq $s) { return '' } [Uri]::UnescapeDataString($s) }

function B64Decode([string]$s) {
    $s = $s.Trim().Replace('-', '+').Replace('_', '/')
    $s += '=' * ((4 - $s.Length % 4) % 4)
    $Utf8.GetString([Convert]::FromBase64String($s))
}

function Test-Truthy($v) { @('1', 'true', 'yes') -contains ([string]$v).ToLower() }

function Parse-Query([string]$q) {
    $h = @{}
    if (-not $q) { return $h }
    foreach ($kv in $q.Split('&')) {
        if (-not $kv) { continue }
        $i = $kv.IndexOf('=')
        if ($i -lt 0) { $k = $kv; $v = '' } else { $k = $kv.Substring(0, $i); $v = $kv.Substring($i + 1) }
        $k = Unesc $k
        if (-not $h.ContainsKey($k)) { $h[$k] = Unesc $v }
    }
    return $h
}

function Split-Link([string]$link, [bool]$looseUser = $false) {
    $u = if ($looseUser) { '[^@]*' } else { '[^@/?#]*' }
    $m = [regex]::Match($link, "^(?<s>[A-Za-z0-9+.-]+)://(?:(?<u>$u)@)?(?<h>\[[^\]]+\]|[^:/?#]*)(?::(?<p>\d+))?(?<path>/[^?#]*)?(?:\?(?<q>[^#]*))?(?:#(?<f>.*))?$")
    if (-not $m.Success) { throw 'Не удалось разобрать ссылку' }
    $raw = $m.Groups['u'].Value
    $user = Unesc $raw; $pass = $null
    $ci = $raw.IndexOf(':')
    if ($ci -ge 0) { $user = Unesc $raw.Substring(0, $ci); $pass = Unesc $raw.Substring($ci + 1) }
    $srv = $m.Groups['h'].Value.Trim('[', ']')
    [pscustomobject]@{
        HasUser = $m.Groups['u'].Success; RawUser = $raw; User = $user; Pass = $pass
        Server = $srv; Port = $(if ($m.Groups['p'].Success) { [int]$m.Groups['p'].Value } else { 0 })
        Query = (Parse-Query $m.Groups['q'].Value)
        Name = $(if ($m.Groups['f'].Value) { Unesc $m.Groups['f'].Value } else { $srv })
    }
}

function Get-Q($q, [string]$key, $default = '') { if ($q.ContainsKey($key) -and $q[$key] -ne '') { $q[$key] } else { $default } }

function New-Tls($q, [string]$srv, [bool]$defaultOn) {
    $sec = if ($q.ContainsKey('security')) { $q['security'] } elseif ($defaultOn) { 'tls' } else { 'none' }
    if (@('tls', 'reality', 'xtls') -notcontains $sec) { return $null }
    $t = [ordered]@{ enabled = $true; server_name = (Get-Q $q 'sni' (Get-Q $q 'peer' $srv)) }
    $alpn = Get-Q $q 'alpn'
    if ($alpn) { $t.alpn = @($alpn.Split(',') | Where-Object { $_ }) }
    if ((Test-Truthy (Get-Q $q 'allowInsecure')) -or (Test-Truthy (Get-Q $q 'insecure'))) { $t.insecure = $true }
    $fp = Get-Q $q 'fp'
    if ($fp -or $sec -eq 'reality') { $t.utls = [ordered]@{ enabled = $true; fingerprint = $(if ($fp) { $fp } else { 'chrome' }) } }
    if ($sec -eq 'reality') { $t.reality = [ordered]@{ enabled = $true; public_key = (Get-Q $q 'pbk'); short_id = (Get-Q $q 'sid') } }
    return $t
}

function New-Transport($q) {
    $net = Get-Q $q 'type' 'tcp'
    $path = Get-Q $q 'path' '/'
    $hostHdr = Get-Q $q 'host'
    switch ($net) {
        { $_ -in 'tcp', 'raw' } { return $null }
        'ws' {
            $t = [ordered]@{ type = 'ws'; path = $path }
            if ($hostHdr) { $t.headers = [ordered]@{ Host = $hostHdr } }
            return $t
        }
        'grpc' { return [ordered]@{ type = 'grpc'; service_name = (Get-Q $q 'serviceName' (Get-Q $q 'path')) } }
        { $_ -in 'http', 'h2' } {
            $t = [ordered]@{ type = 'http'; path = $path }
            if ($hostHdr) { $t.host = @($hostHdr.Split(',')) }
            return $t
        }
        'httpupgrade' { return [ordered]@{ type = 'httpupgrade'; path = $path; host = $hostHdr } }
        default { throw "Транспорт «$net» не поддерживается ядром sing-box" }
    }
}

function Add-TlsTransport($ob, $q, [string]$srv, [bool]$defaultTls) {
    $t = New-Tls $q $srv $defaultTls
    if ($t) { $ob.tls = $t }
    $tr = New-Transport $q
    if ($tr) { $ob.transport = $tr }
    return $ob
}

function Parse-Link([string]$link) {
    $scheme = $link.Substring(0, $link.IndexOf('://')).ToLower()

    if ($scheme -eq 'vmess') {
        $j = B64Decode ($link.Substring(8).Split('#')[0]) | ConvertFrom-Json
        $q = @{
            type = [string]$j.net; path = [string]$j.path; host = [string]$j.host; sni = [string]$j.sni
            alpn = [string]$j.alpn; fp = [string]$j.fp; serviceName = [string]$j.path
            security = $(if (@('tls', 'reality') -contains [string]$j.tls) { 'tls' } else { 'none' })
        }
        $ob = [ordered]@{ type = 'vmess'; server = [string]$j.add; server_port = [int]$j.port; uuid = [string]$j.id
            security = $(if ($j.scy) { [string]$j.scy } else { 'auto' }); alter_id = [int]("0$($j.aid)") }
        $name = if ($j.ps) { [string]$j.ps } else { [string]$j.add }
        return @((Add-TlsTransport $ob $q $j.add $false), $name)
    }

    if ($scheme -eq 'ss' -and -not $link.Split('#')[0].Contains('@')) {
        # ss://base64(method:pass@host:port)#name
        $parts = $link.Substring(5).Split('#')
        $raw = B64Decode ($parts[0].Split('?')[0])
        $at = $raw.LastIndexOf('@'); $cred = $raw.Substring(0, $at); $hp = $raw.Substring($at + 1)
        $c = $cred.IndexOf(':'); $hc = $hp.LastIndexOf(':')
        $name = if ($parts.Length -gt 1) { Unesc $parts[1] } else { $hp }
        return @([ordered]@{ type = 'shadowsocks'; server = $hp.Substring(0, $hc); server_port = [int]$hp.Substring($hc + 1)
                method = $cred.Substring(0, $c); password = $cred.Substring($c + 1) }, $name)
    }

    $u = Split-Link $link ($scheme -eq 'ss')
    $q = $u.Query; $srv = $u.Server; $port = $u.Port; $name = $u.Name

    switch ($scheme) {
        'vless' {
            $ob = [ordered]@{ type = 'vless'; server = $srv; server_port = $port; uuid = $u.User }
            if (Get-Q $q 'flow') { $ob.flow = $q['flow'] }
            return @((Add-TlsTransport $ob $q $srv $false), $name)
        }
        'trojan' {
            $ob = [ordered]@{ type = 'trojan'; server = $srv; server_port = $port; password = (Unesc $u.RawUser) }
            return @((Add-TlsTransport $ob $q $srv $true), $name)
        }
        'ss' {
            if ($null -eq $u.Pass) { $mp = B64Decode (Unesc $u.RawUser) } else { $mp = "$($u.User):$($u.Pass)" }  # SIP002 / SS-2022
            $c = $mp.IndexOf(':')
            return @([ordered]@{ type = 'shadowsocks'; server = $srv; server_port = $port
                    method = $mp.Substring(0, $c); password = $mp.Substring($c + 1) }, $name)
        }
        { $_ -in 'hysteria2', 'hy2' } {
            $ob = [ordered]@{ type = 'hysteria2'; server = $srv; server_port = $(if ($port) { $port } else { 443 })
                password = (Unesc $u.RawUser); tls = (New-Tls $q $srv $true) }
            if (Get-Q $q 'obfs') { $ob.obfs = [ordered]@{ type = $q['obfs']; password = (Get-Q $q 'obfs-password') } }
            return @($ob, $name)
        }
        'hysteria' {
            $q2 = $q.Clone(); if (-not (Get-Q $q2 'alpn')) { $q2['alpn'] = 'hysteria' }
            $ob = [ordered]@{ type = 'hysteria'; server = $srv; server_port = $port
                up_mbps = [int](Get-Q $q 'upmbps' 50); down_mbps = [int](Get-Q $q 'downmbps' 100); tls = (New-Tls $q2 $srv $true) }
            if (Get-Q $q 'auth') { $ob.auth_str = $q['auth'] }
            if (Get-Q $q 'obfsParam') { $ob.obfs = $q['obfsParam'] }
            return @($ob, $name)
        }
        'tuic' {
            $q2 = $q.Clone(); if (Get-Q $q 'allow_insecure') { $q2['insecure'] = $q['allow_insecure'] }
            $ob = [ordered]@{ type = 'tuic'; server = $srv; server_port = $port; uuid = $u.User; password = [string]$u.Pass
                congestion_control = (Get-Q $q 'congestion_control' 'bbr'); udp_relay_mode = (Get-Q $q 'udp_relay_mode' 'native')
                tls = (New-Tls $q2 $srv $true) }
            return @($ob, $name)
        }
        'anytls' {
            return @([ordered]@{ type = 'anytls'; server = $srv; server_port = $port; password = (Unesc $u.RawUser); tls = (New-Tls $q $srv $true) }, $name)
        }
        { $_ -in 'socks', 'socks5' } {
            $ob = [ordered]@{ type = 'socks'; server = $srv; server_port = $port; version = '5' }
            if ($u.User) { $ob.username = $u.User; $ob.password = [string]$u.Pass }
            return @($ob, $name)
        }
    }
    throw "Протокол $scheme не поддерживается"
}

function Select-Link([string]$body) {
    $text = $body.Trim()
    if (-not $text.Split("`n")[0].Contains('://')) { try { $text = B64Decode $text } catch { } }
    foreach ($line in $text.Split("`n")) {
        $line = $line.Trim()
        $i = $line.IndexOf('://')
        if ($i -gt 0 -and $Schemes -contains $line.Substring(0, $i).ToLower()) { return $line }
    }
    throw 'В подписке нет поддерживаемых ссылок'
}

function Build-Config([string]$link, [int]$socksPort) {
    $r = Parse-Link $link
    $ob = $r[0]; $ob.tag = 'proxy'
    $cfg = [ordered]@{
        log          = [ordered]@{ level = 'warn' }
        inbounds     = @([ordered]@{ type = 'mixed'; tag = 'in'; listen = '127.0.0.1'; listen_port = $socksPort })
        outbounds    = @($ob, [ordered]@{ type = 'direct'; tag = 'direct' })
        route        = [ordered]@{ final = 'proxy' }
        experimental = [ordered]@{ clash_api = [ordered]@{ external_controller = $ApiAddr } }
    }
    return @($cfg, $r[1])
}

# ---------- запуск ----------
function Stop-Core {
    $script:running = $false
    if ($script:proc -and -not $script:proc.HasExited) {
        try { $script:proc.Kill(); $null = $script:proc.WaitForExit(3000) } catch { }
    }
    $script:proc = $null
}

function Start-Core($msg) {
    Stop-Core
    # на случай, если прошлый хост был убит и ядро осталось висеть
    Get-Process sing-box -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Core } | Stop-Process -Force -ErrorAction SilentlyContinue
    $src = ([string]$msg.url).Trim()
    Ensure-Core
    if ($src -match '^https?://') {
        Send-Progress 'Загружаю конфиг…'
        $link = Select-Link (Get-Text $src)
    } else { $link = $src }
    $port = if ($msg.socksPort) { [int]$msg.socksPort } else { 10808 }
    $r = Build-Config $link $port
    [IO.File]::WriteAllText($Cfg, (ConvertTo-Json $r[0] -Depth 20), $Utf8)

    Send-Progress 'Запуск ядра…'
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $Core
    $psi.Arguments = "run -c `"$Cfg`" --disable-color"
    $psi.WorkingDirectory = $BinDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true   # не наследовать канал браузера
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $p = [Diagnostics.Process]::Start($psi)
    if ($p.WaitForExit(1500)) {
        $err = $p.StandardError.ReadToEnd().Trim()
        if ($err.Length -gt 400) { $err = $err.Substring($err.Length - 400) }
        throw "sing-box не запустился: $err"
    }
    $p.BeginOutputReadLine(); $p.BeginErrorReadLine()  # сливаем вывод, чтобы буфер не переполнился
    $script:proc = $p
    $script:running = $true
    Send-Msg ([ordered]@{ event = 'started'; server = $r[1]; protocol = $r[0].outbounds[0].type })
}

function Send-Stats {
    if (-not $script:running) { return }
    if ($script:proc.HasExited) {
        $script:running = $false
        Send-Msg ([ordered]@{ event = 'error'; message = 'Ядро sing-box неожиданно завершилось' })
        return
    }
    try {
        $wc = New-Object Net.WebClient
        $wc.Proxy = $null
        $s = $wc.DownloadString("http://$ApiAddr/connections")
        $wc.Dispose()
        $up = [regex]::Match($s, '"uploadTotal":(\d+)').Groups[1].Value
        $down = [regex]::Match($s, '"downloadTotal":(\d+)').Groups[1].Value
        Send-Msg ([ordered]@{ event = 'stats'; up = [int64]("0$up"); down = [int64]("0$down") })
    } catch { }
}

function Invoke-Main {
    $hdr = New-Object byte[] 4
    while ($true) {
        $task = $stdin.ReadAsync($hdr, 0, 4)
        while (-not $task.Wait(1000)) { Send-Stats }  # раз в секунду, пока ждём команду
        $got = $task.Result
        if ($got -le 0 -or -not (Read-Exact $hdr $got 4)) { break }
        $len = [BitConverter]::ToInt32($hdr, 0)
        $body = New-Object byte[] $len
        if (-not (Read-Exact $body 0 $len)) { break }
        $msg = $Utf8.GetString($body) | ConvertFrom-Json
        try {
            switch ($msg.cmd) {
                'start' { Start-Core $msg }
                'stop' { Stop-Core }
            }
        } catch {
            Stop-Core
            Send-Msg ([ordered]@{ event = 'error'; message = $_.Exception.Message })
        }
    }
    Stop-Core
}

if (-not $NoMain) {
    try { Invoke-Main } finally { Stop-Core }
}
