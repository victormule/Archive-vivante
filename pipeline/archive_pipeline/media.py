"""Traitements média : ffmpeg (audio, images), Node + Spark (splats)."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

TRANSCODE_SPZ = Path(__file__).resolve().parents[1] / "scripts" / "transcode_spz.mjs"


def require_tool(name: str) -> str:
    exe = shutil.which(name)
    if exe is None:
        raise RuntimeError(f"{name} introuvable dans le PATH")
    return exe


def require_ffmpeg() -> str:
    return require_tool("ffmpeg")


def extract_audio(video: Path, output: Path) -> None:
    """Extrait la piste audio AAC sans ré-encodage dans un conteneur .m4a web."""
    subprocess.run(
        [
            require_ffmpeg(), "-y", "-loglevel", "error",
            "-i", str(video),
            "-vn", "-c:a", "copy", "-movflags", "+faststart",
            str(output),
        ],
        check=True,
    )


def encode_jpeg(image: Path, quality: int = 3) -> bytes:
    """Ré-encode une image en JPEG (qualité ffmpeg 2–31, plus bas = meilleur)."""
    result = subprocess.run(
        [
            require_ffmpeg(), "-loglevel", "error",
            "-i", str(image),
            "-q:v", str(quality), "-f", "image2pipe", "-c:v", "mjpeg", "-pix_fmt", "yuvj444p", "-",
        ],
        check=True,
        capture_output=True,
    )
    return result.stdout


def encode_web_image(image: Path, output: Path, max_size: int = 1600, quality: int = 4) -> tuple[int, int]:
    """Image web : JPEG, plus grand côté ≤ max_size, orientation EXIF appliquée.

    Retourne (largeur, hauteur) de l'image produite.
    """
    scale = f"scale='if(gt(iw,ih),min({max_size},iw),-2)':'if(gt(iw,ih),-2,min({max_size},ih))'"
    subprocess.run(
        [
            require_ffmpeg(), "-y", "-loglevel", "error",
            "-i", str(image),
            "-vf", scale, "-q:v", str(quality), "-frames:v", "1",
            str(output),
        ],
        check=True,
    )
    probe = subprocess.run(
        [require_tool("ffprobe"), "-v", "error", "-show_entries", "stream=width,height",
         "-of", "csv=p=0", str(output)],
        check=True, capture_output=True, text=True,
    )
    width, height = (int(v) for v in probe.stdout.strip().split(",")[:2])
    return width, height


def encode_web_video(video: Path, output: Path) -> tuple[int, int, float]:
    """Vidéo d'annotation : H.264 sans piste son (lecture muette en boucle), prête à lire.

    Le flux vidéo est recopié s'il est déjà en H.264, ré-encodé sinon.
    Retourne (largeur, hauteur, durée en s).
    """
    ffprobe = require_tool("ffprobe")
    codec = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name",
         "-of", "csv=p=0", str(video)],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    video_codec = ["-c:v", "copy"] if codec == "h264" else ["-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p"]
    subprocess.run(
        [require_ffmpeg(), "-y", "-loglevel", "error", "-i", str(video),
         "-map", "0:v:0", *video_codec, "-an", "-movflags", "+faststart", str(output)],
        check=True,
    )
    probe = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
         "-of", "json", str(output)],
        check=True, capture_output=True, text=True,
    )
    info = json.loads(probe.stdout)
    stream = info["streams"][0]
    return int(stream["width"]), int(stream["height"]), float(info["format"]["duration"])


def extract_poster(video: Path, output: Path, at: float = 0.5, max_size: int = 800) -> tuple[int, int]:
    """Image d'attente d'une vidéo (JPEG)."""
    scale = f"scale='if(gt(iw,ih),min({max_size},iw),-2)':'if(gt(iw,ih),-2,min({max_size},ih))'"
    subprocess.run(
        [require_ffmpeg(), "-y", "-loglevel", "error", "-ss", str(at), "-i", str(video),
         "-vf", scale, "-q:v", "4", "-frames:v", "1", str(output)],
        check=True,
    )
    return _image_size(output)


def render_pdf_thumbnail(pdf: Path, output: Path, max_size: int = 800) -> tuple[int, int, int]:
    """Première page d'un PDF en JPEG. Retourne (largeur, hauteur, nombre de pages)."""
    try:
        import pymupdf
    except ImportError as exc:  # pragma: no cover - dépendance du pipeline
        raise RuntimeError("pymupdf requis pour les documents PDF (pip install -r pipeline/requirements.txt)") from exc
    with pymupdf.open(pdf) as document:
        page = document[0]
        zoom = max_size / max(page.rect.width, page.rect.height)
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        pixmap.save(output, jpg_quality=85)
        return pixmap.width, pixmap.height, document.page_count


def _image_size(path: Path) -> tuple[int, int]:
    probe = subprocess.run(
        [require_tool("ffprobe"), "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    )
    width, height = (int(v) for v in probe.stdout.strip().split(",")[:2])
    return width, height


def transcode_spz(ply: Path, output: Path, max_sh: int = 3) -> tuple[int, int]:
    """Gaussian splat PLY -> SPZ compressé (voir scripts/transcode_spz.mjs).

    Retourne (octets en entrée, octets en sortie).
    """
    result = subprocess.run(
        [require_tool("node"), str(TRANSCODE_SPZ), str(ply), str(output), "--max-sh", str(max_sh)],
        check=True, capture_output=True, text=True,
    )
    sizes = json.loads(result.stdout.strip().splitlines()[-1])
    return sizes["input"], sizes["output"]
