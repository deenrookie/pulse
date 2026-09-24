# Build the three release archives (same layout as previous releases):
#   pulse_<ver>_windows_amd64.zip      pulse.exe + README.md
#   pulse_<ver>_linux_amd64.tar.gz     pulse    + README.md (0o755)
#   pulse_<ver>_darwin_arm64.tar.gz    pulse    + README.md (0o755)
$ErrorActionPreference = "Stop"
$ver = "0.3.11"
$repo = "C:/Users/Deen/Documents/GitHub/pulse"
$out = "$repo/dist-release"
Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $out | Out-Null

$targets = @(
    @{ Goos = "windows"; Goarch = "amd64"; Ext = ".exe"; Archive = "pulse_${ver}_windows_amd64.zip" },
    @{ Goos = "linux";   Goarch = "amd64"; Ext = "";     Archive = "pulse_${ver}_linux_amd64.tar.gz" },
    @{ Goos = "darwin";  Goarch = "arm64"; Ext = "";     Archive = "pulse_${ver}_darwin_arm64.tar.gz" }
)
foreach ($t in $targets) {
    $bin = "$out/pulse-$($t.Goos)-$($t.Goarch)$($t.Ext)"
    $env:GOOS = $t.Goos; $env:GOARCH = $t.Goarch
    go build -ldflags "-s -w" -o $bin ./cmd/pulse
    if ($LASTEXITCODE -ne 0) { throw "build failed for $($t.Goos)/$($t.Goarch)" }
}

# windows zip (archive carries the plain pulse.exe name, matching the README install command)
Copy-Item "$out/pulse-windows-amd64.exe" "$out/pulse.exe" -Force
Compress-Archive -Path "$out/pulse.exe", "$repo/README.md" -DestinationPath "$out/pulse_${ver}_windows_amd64.zip" -Force
Remove-Item "$out/pulse.exe"

# tar.gz with explicit 0o755 on the binary (Compress/Tar lose the mode)
python - @'
import tarfile, sys, os
ver = "0.3.11"
out = r"C:/Users/Deen/Documents/GitHub/pulse/dist-release"
repo = r"C:/Users/Deen/Documents/GitHub/pulse"
for plat in ("linux_amd64", "darwin_arm64"):
    path = os.path.join(out, f"pulse_{ver}_{plat}.tar.gz")
    with tarfile.open(path, "w:gz") as tf:
        bin = {"linux_amd64": "pulse-linux-amd64", "darwin_arm64": "pulse-darwin-arm64"}[plat]
        ti = tf.gettarinfo(os.path.join(out, bin), arcname="pulse")
        ti.mode = 0o755
        with open(os.path.join(out, bin), "rb") as f:
            tf.addfile(ti, f)
        tf.add(os.path.join(repo, "README.md"), arcname="README.md")
    print("wrote", path)
'@

Get-ChildItem $out | Select-Object Name, Length | Format-Table
