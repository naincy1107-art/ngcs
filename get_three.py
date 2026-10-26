import urllib.request 
from pathlib import Path 
BASE = "https://cdn.jsdelivr.net/npm/three@0.172.0/" 
OUT = Path("assets/vendor/three") 
FILES = {"build/three.module.min.js": "three.module.min.js", "build/three.core.min.js": "three.core.min.js", "examples/jsm/loaders/GLTFLoader.js": "addons/loaders/GLTFLoader.js", "examples/jsm/utils/BufferGeometryUtils.js": "addons/utils/BufferGeometryUtils.js"} 
for src, dst in FILES.items(): 
    p = OUT / dst; p.parent.mkdir(parents=True, exist_ok=True); urllib.request.urlretrieve(BASE + src, p); print("OK", p) 
