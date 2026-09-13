# tar.gz release archives with explicit 0o755 on the binary
import os
import tarfile

VER = "0.3.6"
OUT = r"C:/Users/Deen/Documents/GitHub/pulse/dist-release"
REPO = r"C:/Users/Deen/Documents/GitHub/pulse"

for plat in ("linux_amd64", "darwin_arm64"):
    path = os.path.join(OUT, f"pulse_{VER}_{plat}.tar.gz")
    with tarfile.open(path, "w:gz") as tf:
        ti = tf.gettarinfo(os.path.join(OUT, "pulse"), arcname="pulse")
        ti.mode = 0o755
        ti.mtime = int(os.path.getmtime(os.path.join(OUT, "pulse")))
        with open(os.path.join(OUT, "pulse"), "rb") as f:
            tf.addfile(ti, f)
        tf.add(os.path.join(REPO, "README.md"), arcname="README.md")
    print("wrote", path, os.path.getsize(path))
