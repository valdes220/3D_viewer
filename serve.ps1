# NOMA — локальный сервер для тестов туров. Ничего устанавливать не нужно.
# Запуск: двойной клик по start-noma.bat. Остановка: закрыть окно.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$mime = @{
  '.html'='text/html; charset=utf-8'; '.htm'='text/html; charset=utf-8'; '.js'='text/javascript'; '.mjs'='text/javascript'
  '.css'='text/css'; '.json'='application/json'; '.webmanifest'='application/manifest+json'
  '.glb'='model/gltf-binary'; '.gltf'='model/gltf+json'; '.bin'='application/octet-stream'
  '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.webp'='image/webp'; '.svg'='image/svg+xml'; '.ico'='image/x-icon'
  '.hdr'='application/octet-stream'; '.exr'='application/octet-stream'; '.ktx2'='image/ktx2'; '.wasm'='application/wasm'
  '.mp4'='video/mp4'; '.webm'='video/webm'
}
$listener = $null; $port = 8080
foreach ($p in 8080..8090) {
  try { $l = New-Object System.Net.HttpListener; $l.Prefixes.Add("http://localhost:$p/"); $l.Start(); $listener = $l; $port = $p; break } catch { }
}
if (-not $listener) { Write-Host 'Не удалось занять порт 8080-8090' -ForegroundColor Red; Read-Host 'Enter — выход'; exit 1 }
$url = "http://localhost:$port/"
Write-Host ''
Write-Host '  NOMA — локальный сервер запущен' -ForegroundColor Cyan
Write-Host "  Папка:   $root"
Write-Host "  Адрес:   $url"
Write-Host "  Тур:     ${url}?tour=ИМЯ_ПАПКИ   (папка tours\ИМЯ_ПАПКИ\tour.json)"
Write-Host '  Остановить — закрой это окно.'
Write-Host ''
$tours = Join-Path $root 'tours'
if (Test-Path $tours) { Get-ChildItem $tours -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'tour.json') } | ForEach-Object { Write-Host "    ${url}?tour=$($_.Name)" -ForegroundColor Green } }
Start-Process $url
while ($listener.IsListening) {
  $ctx = $listener.GetContext(); $req = $ctx.Request; $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart('/'))
    if ($rel -eq '' -or $rel.EndsWith('/')) { $rel += 'index.html' }
    $path = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $path -PathType Leaf)) {
      $res.StatusCode = 404; $b = [Text.Encoding]::UTF8.GetBytes("404: $rel"); $res.OutputStream.Write($b, 0, $b.Length)
      Write-Host "404  $rel" -ForegroundColor Yellow
    } else {
      $ext = [IO.Path]::GetExtension($path).ToLower()
      $res.ContentType = $(if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' })
      $res.Headers.Add('Cache-Control', 'no-cache'); $res.Headers.Add('Access-Control-Allow-Origin', '*')
      $fs = [IO.File]::OpenRead($path); $res.ContentLength64 = $fs.Length
      try { $fs.CopyTo($res.OutputStream) } finally { $fs.Close() }
    }
  } catch { } finally { try { $res.Close() } catch { } }
}
