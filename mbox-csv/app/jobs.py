import json
import os
from pathlib import Path
from typing import Dict, Optional

from .config import JOBS_DIR


def _jpath(jid: str) -> Path:
    return JOBS_DIR / f"{jid}.json"


def load_job(jid: str) -> Optional[Dict]:
    p = _jpath(jid)
    if not p.exists():
        return None
    return json.loads(p.read_text())


def save_job(obj: Dict) -> None:
    target = _jpath(obj["id"])
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj))
    os.replace(tmp, target)


def cleanup_job(jid: str, out_path: str) -> None:
    for path in (Path(out_path), _jpath(jid)):
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass
