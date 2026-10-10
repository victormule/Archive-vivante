"""Écriture d'un maillage texturé en glTF binaire (.glb).

Matériau `KHR_materials_unlit` : la texture photogrammétrique contient déjà
l'éclairage réel, elle doit être affichée telle quelle.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

_FLOAT, _UINT32 = 5126, 5125
_ARRAY_BUFFER, _ELEMENT_ARRAY_BUFFER = 34962, 34963


def _pad4(data: bytes, fill: bytes = b"\x00") -> bytes:
    return data + fill * (-len(data) % 4)


@dataclass(frozen=True)
class MeshPart:
    """Un maillage texturé ; `uvs` en convention glTF (origine en haut à gauche)."""

    positions: np.ndarray
    faces: np.ndarray
    uvs: np.ndarray | None = None
    normals: np.ndarray | None = None
    texture_jpeg: bytes | None = None
    name: str = "mesh"


def write_glb(
    path: Path,
    positions: np.ndarray,
    faces: np.ndarray,
    uvs: np.ndarray | None = None,
    normals: np.ndarray | None = None,
    texture_jpeg: bytes | None = None,
    name: str = "mesh",
) -> None:
    """`uvs` en convention glTF (origine en haut à gauche)."""
    write_glb_parts(path, [MeshPart(positions, faces, uvs, normals, texture_jpeg, name)])


def write_glb_parts(path: Path, parts: list[MeshPart]) -> None:
    """Plusieurs maillages texturés (un nœud, un matériau et une texture chacun) dans un même .glb."""
    blobs: list[bytes] = []
    views: list[dict] = []
    accessors: list[dict] = []

    def add_view(data: bytes, target: int | None = None) -> int:
        offset = sum(len(b) for b in blobs)
        blobs.append(_pad4(data))
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target:
            view["target"] = target
        views.append(view)
        return len(views) - 1

    def add_accessor(array: np.ndarray, kind: str, component: int, target: int, bounds: bool = False) -> int:
        acc = {
            "bufferView": add_view(array.tobytes(), target),
            "componentType": component,
            "count": len(array),
            "type": kind,
        }
        if bounds:
            acc["min"] = array.min(0).tolist()
            acc["max"] = array.max(0).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    nodes, meshes, materials, images, textures = [], [], [], [], []
    for part in parts:
        attributes = {"POSITION": add_accessor(part.positions.astype("<f4"), "VEC3", _FLOAT, _ARRAY_BUFFER, bounds=True)}
        if part.normals is not None:
            attributes["NORMAL"] = add_accessor(part.normals.astype("<f4"), "VEC3", _FLOAT, _ARRAY_BUFFER)
        if part.uvs is not None:
            attributes["TEXCOORD_0"] = add_accessor(part.uvs.astype("<f4"), "VEC2", _FLOAT, _ARRAY_BUFFER)
        indices = add_accessor(part.faces.astype("<u4").reshape(-1), "SCALAR", _UINT32, _ELEMENT_ARRAY_BUFFER)
        material: dict = {
            "name": f"{part.name}_material",
            "extensions": {"KHR_materials_unlit": {}},
            "pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": 1},
            "doubleSided": True,
        }
        if part.texture_jpeg is not None:
            images.append({"bufferView": add_view(part.texture_jpeg), "mimeType": "image/jpeg"})
            textures.append({"source": len(images) - 1, "sampler": 0})
            material["pbrMetallicRoughness"]["baseColorTexture"] = {"index": len(textures) - 1}
        materials.append(material)
        meshes.append({"name": part.name, "primitives": [{"attributes": attributes, "indices": indices, "material": len(materials) - 1}]})
        nodes.append({"mesh": len(meshes) - 1, "name": part.name})

    doc: dict = {
        "asset": {"version": "2.0", "generator": "performance-archive pipeline"},
        "extensionsUsed": ["KHR_materials_unlit"],
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials,
        "accessors": accessors,
        "bufferViews": views,
    }
    if images:
        doc["images"] = images
        doc["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}]
        doc["textures"] = textures

    binary = b"".join(blobs)
    doc["buffers"] = [{"byteLength": len(binary)}]
    json_chunk = _pad4(json.dumps(doc, separators=(",", ":")).encode(), b" ")

    with path.open("wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(json_chunk) + 8 + len(binary)))
        f.write(struct.pack("<I4s", len(json_chunk), b"JSON") + json_chunk)
        f.write(struct.pack("<I4s", len(binary), b"BIN\x00") + binary)
