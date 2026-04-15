from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

BASE_DIR = Path(__file__).resolve().parent.parent

PAGES_DIR  = BASE_DIR / "pages"
STATIC_DIR = BASE_DIR / "static"

DATA_DIR    = Path("/data")
UPLOADS_DIR = DATA_DIR / "uploads"
JOBS_DIR    = DATA_DIR / "jobs"
OUT_DIR     = Path("/downloads")

for _p in (DATA_DIR, UPLOADS_DIR, JOBS_DIR, OUT_DIR):
    _p.mkdir(parents=True, exist_ok=True)

MAX_BYTES   = 20 * 1024 * 1024 * 1024   # 20 GB
CHUNK_SIZE  = 16 * 1024 * 1024           # 16 MB
BODY_LIMIT  = 32_000                     # chars

POOL = ThreadPoolExecutor(max_workers=2)
