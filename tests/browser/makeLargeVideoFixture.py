"""Generate a synthetic, non-personal 160 MiB MP4; requires local ffmpeg."""
from pathlib import Path
import struct
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
destination = root / "public" / "test-fixtures.local" / "large.mp4"
destination.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="vaultphotos-fixture-") as temporary:
    source = Path(temporary) / "video.mp4"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
        "testsrc2=size=320x180:rate=24", "-t", "2", "-c:v", "libx264",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", str(source),
    ], check=True)
    data = source.read_bytes()
    size = 160 * 1024 * 1024
    # A standard MP4 free box exercises all upload bytes/chunks without
    # creating 160 MiB of high-resolution decoded frames or personal media.
    with destination.open("wb") as output:
        output.write(data)
        output.write(struct.pack(">I4s", size - len(data), b"free"))
        output.seek(size - 1)
        output.write(b"\0")
print(f"Generated synthetic fixture: {destination}")
