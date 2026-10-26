import urllib.request
from pathlib import Path

V = "0.172.0"
BASE = f"https://cdn.jsdelivr.net/npm/three@{V}/"
OUT = Path("assets/vendor/three")

FILES = {
    "build/three.module.min.js": "three.module.min.js",
    "build/three.core.min.js": "three.core.min.js",
    "examples/jsm/loaders/GLTFLoader.js": "addons/loaders/GLTFLoader.js",
    "examples/jsm/utils/BufferGeometryUtils.js": "addons/utils/BufferGeometryUtils.js",
}

for src, dst in FILES.items():
    path = OUT / dst
    path.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(BASE + src, path)
    print("OK ", path)