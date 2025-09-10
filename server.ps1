Param(
    [string]$Prefix = "http://localhost:5173/"
)

$ErrorActionPreference = 'Stop'

Write-Host "Starting PowerShell HTTP server on $Prefix"

Add-Type -AssemblyName System.Net.HttpListener
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($Prefix)

try {
    $listener.Start()
} catch {
    Write-Warning "Failed to start listener. You may need to reserve the URL first:"
    Write-Host "Run as Administrator:" -ForegroundColor Yellow
    Write-Host "  netsh http add urlacl url=$Prefix user=$env:USERNAME" -ForegroundColor Yellow
    throw
}

$root = $PSScriptRoot
$dataDir = Join-Path $root 'data'
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
$dataFile = Join-Path $dataDir 'state.json'

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.htm'  = 'text/html; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.gif'  = 'image/gif'
    '.ico'  = 'image/x-icon'
}

function Send-Bytes($ctx, [byte[]]$bytes, [int]$status = 200, [string]$contentType = 'text/plain; charset=utf-8') {
    $ctx.Response.StatusCode = $status
    $ctx.Response.ContentType = $contentType
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-Text($ctx, [string]$text, [int]$status = 200, [string]$contentType = 'text/plain; charset=utf-8') {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    Send-Bytes $ctx $bytes $status $contentType
}

function Handle-Api($ctx) {
    $path = $ctx.Request.Url.AbsolutePath
    if ($ctx.Request.HttpMethod -eq 'GET' -and $path -eq '/api/state') {
        if (-not (Test-Path $dataFile)) { $ctx.Response.StatusCode = 204; return }
        $json = Get-Content -LiteralPath $dataFile -Raw -Encoding UTF8
        Send-Text $ctx $json 200 'application/json; charset=utf-8'
        return
    }
    if ($ctx.Request.HttpMethod -eq 'POST' -and $path -eq '/api/state') {
        $reader = New-Object IO.StreamReader($ctx.Request.InputStream, $ctx.Request.ContentEncoding)
        $body = $reader.ReadToEnd()
        if ([string]::IsNullOrWhiteSpace($body)) { Send-Text $ctx '{"error":"empty"}' 400 'application/json'; return }
        try { $null = $body | ConvertFrom-Json -ErrorAction Stop } catch { Send-Text $ctx '{"error":"bad json"}' 400 'application/json'; return }
        Set-Content -LiteralPath $dataFile -Value $body -Encoding UTF8
        $ctx.Response.StatusCode = 204
        return
    }
    $ctx.Response.StatusCode = 404
}

while ($listener.IsListening) {
    try {
        $ctx = $listener.GetContext()
        $path = $ctx.Request.Url.AbsolutePath
        if ($path.StartsWith('/api/')) {
            Handle-Api $ctx
        } else {
            if ($path -eq '/') { $path = '/index.html' }
            $rel = $path.TrimStart('/') -replace '/', [IO.Path]::DirectorySeparatorChar
            $full = Join-Path $root $rel
            $full = [IO.Path]::GetFullPath($full)
            if (-not $full.StartsWith($root)) { Send-Text $ctx 'Forbidden' 403; $ctx.Response.Close(); continue }
            if (-not (Test-Path $full)) { Send-Text $ctx 'Not Found' 404; $ctx.Response.Close(); continue }
            $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
            $ctype = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
            $bytes = [IO.File]::ReadAllBytes($full)
            Send-Bytes $ctx $bytes 200 $ctype
        }
    } catch {
        try { Send-Text $ctx "Server error: $_" 500 } catch {}
    } finally {
        try { $ctx.Response.Close() } catch {}
    }
}

