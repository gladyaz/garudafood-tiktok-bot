# Menghentikan SEMUA proses bot dan service AutoPIN, lalu membuktikan sisanya nol.
#
# Dibuat sesudah insiden LIVE 2026-10-05 (Phase 21). Pemeriksaan sebelumnya
# memakai pola `-match 'node index\.js'`, yang TIDAK PERNAH cocok dengan command
# line sebenarnya di mesin ini:
#
#     "C:\Program Files\nodejs\node.exe" index.js
#
# Jadi laporan "sisa bot: 0" terbit tiga kali padahal tiga bot masih hidup, dan
# salah satunya melakukan klik Pin yang tidak diotorisasi. Pencocokan di bawah
# memakai -like pada substring nama skrip, bukan pola yang mengasumsikan
# bagaimana node dipanggil.

$ErrorActionPreference = 'Stop'

$patterns = @('*index.js*', '*autopin-service.js*')

# P5: aplikasi yang DIPASANG menaruh profil dan kunci di %APPDATA%, bukan di repo.
#
# Kenapa skrip ini harus tahu: ia adalah alat yang dipercaya operator untuk
# menjawab "sudah bersih atau belum" sebelum LIVE. Kalau ia hanya melihat profil
# di repo, maka sesudah aplikasi terpaket dipakai ia akan menerbitkan
# "sisa chrome autopin: 0" sementara Chrome automation masih hidup memegang sesi
# TikTok -- angka nol yang menenangkan dan salah.
#
# Itu persis kegagalan 2026-10-05 yang melahirkan skrip ini: pencocokan yang
# tidak cocok dengan kenyataan. Jadi KEDUA lokasi diperiksa, selalu.
$chromeProfilePatterns = @(
    '*autopin-profile*',                 # checkout pengembang
    '*AI LIVE HOST\browser-profile*'     # aplikasi terpasang (%APPDATA%)
)

function Get-AutopinChrome {
    $all = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"
    $hit = @()
    foreach ($p in $all) {
        foreach ($pat in $chromeProfilePatterns) {
            if ($p.CommandLine -like $pat) { $hit += $p; break }
        }
    }
    return $hit
}

function Get-BotProcesses {
    $all = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
    $hit = @()
    foreach ($p in $all) {
        foreach ($pat in $patterns) {
            if ($p.CommandLine -like $pat) { $hit += $p; break }
        }
    }
    return $hit
}

$found = Get-BotProcesses
if ($found.Count -eq 0) {
    Write-Output "Tidak ada bot/service yang berjalan."
} else {
    Write-Output "Ditemukan $(@($found).Count) proses:"
    foreach ($p in $found) { Write-Output "  PID $($p.ProcessId)  $($p.CommandLine)" }
    foreach ($p in $found) {
        try {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
            Write-Output "  dihentikan: PID $($p.ProcessId)"
        } catch {
            Write-Output "  GAGAL hentikan PID $($p.ProcessId): $($_.Exception.Message)"
        }
    }
}

# Chrome milik AutoPIN dikenali dari profil khususnya, supaya Chrome pribadi
# operator tidak pernah ikut tertutup.
$chrome = Get-AutopinChrome
if ($chrome) {
    foreach ($c in $chrome) {
        try { Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop } catch {}
    }
    Write-Output "Chrome automation dihentikan: $(@($chrome).Count) proses"
}

# Kunci yatim dibersihkan supaya bot berikutnya tidak tertolak tanpa sebab.
# Dua lokasi, dengan alasan yang sama seperti pola Chrome di atas.
$locks = @(
    (Join-Path $PSScriptRoot '..\.bot.lock'),
    (Join-Path $env:APPDATA 'AI LIVE HOST\.bot.lock')
)
foreach ($lock in $locks) {
    if (Test-Path $lock) { Remove-Item $lock -Force; Write-Output "Kunci dihapus: $lock" }
}

# Pembuktian ulang: angka inilah yang boleh dipercaya, bukan asumsi.
$leftNode = @(Get-BotProcesses).Count
$leftChrome = @(Get-AutopinChrome).Count
Write-Output "VERIFIKASI -> sisa bot/service: $leftNode  sisa chrome autopin: $leftChrome"
if ($leftNode -ne 0 -or $leftChrome -ne 0) {
    Write-Output "BELUM BERSIH. Jangan mulai LIVE test."
    exit 1
}
Write-Output "BERSIH."
