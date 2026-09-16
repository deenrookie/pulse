# tar.gz release archives with explicit 0o755 on the binary
import os
import tarfile

VER = "0.3.8"
OUT = r"C:/Users/Deen/Documents/GitHub/pulse/dist-release"
REPO = r"C:/Users/Deen/Documents/GitHub/pulse"

BINS = {"linux_amd64": "pulse-linux-amd64", "darwin_arm64": "pulse-darwin-arm64"}
for plat in ("linux_amd64", "darwin_arm64"):
    src = os.path.join(OUT, BINS[plat])
    path = os.path.join(OUT, f"pulse_{VER}_{plat}.tar.gz")
    with tarfile.open(path, "w:gz") as tf:
        ti = tf.gettarinfo(src, arcname="pulse")
        ti.mode = 0o755
        ti.mtime = int(os.path.getmtime(src))
        with open(src, "rb") as f:
            tf.addfile(ti, f)
        tf.add(os.path.join(REPO, "README.md"), arcname="README.md")
    print("wrote", path, os.path.getsize(path))
