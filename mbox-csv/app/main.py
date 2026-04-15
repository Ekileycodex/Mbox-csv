import hashlib
import math
import uuid
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    Response,
)

from .config import CHUNK_SIZE, MAX_BYTES, PAGES_DIR, POOL, STATIC_DIR, UPLOADS_DIR
from .jobs import cleanup_job, load_job, save_job
from .models import UploadInit
from .parser import parse_job

app = FastAPI(title="MBOX → CSV Converter")


# ---------------------------------------------------------------------------
# Page / static helpers
# ---------------------------------------------------------------------------

def _read_page(name: str) -> str:
    path = PAGES_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Page not found")
    return path.read_text(encoding="utf-8")


def _read_static(name: str) -> str:
    path = STATIC_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")
    return path.read_text(encoding="utf-8")


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fp:
        for chunk in iter(lambda: fp.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# HTML pages
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
def home():
    return _read_page("index.html")

@app.head("/")
def home_head():
    return Response(status_code=200)


@app.get("/how-to", response_class=HTMLResponse)
def how_to():
    return _read_page("how-to.html")

@app.head("/how-to")
def how_to_head():
    return Response(status_code=200)


@app.get("/faq", response_class=HTMLResponse)
def faq():
    return _read_page("faq.html")

@app.head("/faq")
def faq_head():
    return Response(status_code=200)


@app.get("/privacy", response_class=HTMLResponse)
def privacy():
    return _read_page("privacy.html")

@app.head("/privacy")
def privacy_head():
    return Response(status_code=200)


@app.get("/terms", response_class=HTMLResponse)
def terms():
    return _read_page("terms.html")

@app.head("/terms")
def terms_head():
    return Response(status_code=200)


@app.get("/contact", response_class=HTMLResponse)
def contact():
    return _read_page("contact.html")

@app.head("/contact")
def contact_head():
    return Response(status_code=200)


@app.get("/support", response_class=HTMLResponse)
def support():
    return _read_page("support.html")

@app.head("/support")
def support_head():
    return Response(status_code=200)


# ---------------------------------------------------------------------------
# Static / SEO files
# ---------------------------------------------------------------------------

@app.get("/robots.txt")
def robots():
    return Response(
        _read_page("robots.txt"),
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )

@app.head("/robots.txt")
def robots_head():
    return Response(status_code=200)


@app.get("/sitemap.xml")
def sitemap():
    return Response(
        _read_page("sitemap.xml"),
        media_type="application/xml; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )

@app.head("/sitemap.xml")
def sitemap_head():
    return Response(status_code=200)


@app.get("/ads.txt", response_class=PlainTextResponse)
def ads_txt():
    return _read_static("ads.txt")

@app.head("/ads.txt")
def ads_head():
    return Response(status_code=200)


@app.get("/static/{filename}")
def static_file(filename: str):
    path = (STATIC_DIR / filename).resolve()
    if not path.is_relative_to(STATIC_DIR.resolve()) or not path.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(str(path))


# ---------------------------------------------------------------------------
# Upload — chunked (primary)
# ---------------------------------------------------------------------------

@app.post("/upload/init")
async def upload_init(payload: UploadInit):
    if payload.size <= 0:
        raise HTTPException(400, "File is empty")
    if payload.size > MAX_BYTES:
        raise HTTPException(413, "File too large (max 20 GB)")

    jid = uuid.uuid4().hex
    dst = UPLOADS_DIR / f"{jid}.upload"
    dst.write_bytes(b"")

    job = {
        "id":              jid,
        "status":          "uploading",
        "size":            payload.size,
        "filename":        payload.filename,
        "in_path":         str(dst),
        "received":        0,
        "next_index":      0,
        "expected_chunks": max(1, math.ceil(payload.size / CHUNK_SIZE)),
        "sha256":          payload.sha256,
        "total_messages":  0,
        "options": {
            "include_body":        payload.include_body,
            "include_thread_id":   payload.include_thread_id,
            "include_attachments": payload.include_attachments,
        },
    }
    save_job(job)
    return JSONResponse({"job_id": jid, "chunk_size": CHUNK_SIZE})


@app.post("/upload/chunk")
async def upload_chunk(
    job_id:     str        = Form(...),
    index:      int        = Form(...),
    total:      int        = Form(...),
    final:      bool       = Form(False),
    chunk_hash: str        = Form(...),
    chunk:      UploadFile = File(...),
):
    job = load_job(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")
    if job.get("status") not in {"uploading", "queued"}:
        raise HTTPException(409, "Job no longer accepts chunks")

    expected_index = job.get("next_index", 0)
    if index != expected_index:
        raise HTTPException(409, f"Unexpected chunk index {index}, expected {expected_index}")

    data = await chunk.read()
    if not data:
        raise HTTPException(400, "Empty chunk")

    digest = hashlib.sha256(data).hexdigest()
    if digest != chunk_hash:
        raise HTTPException(400, "Checksum mismatch")

    received = job.get("received", 0) + len(data)
    if received > job.get("size", MAX_BYTES):
        raise HTTPException(400, "Received more data than declared")

    with open(job["in_path"], "ab") as dest:
        dest.write(data)

    job["received"]        = received
    job["next_index"]      = index + 1
    job["expected_chunks"] = total
    save_job(job)

    if final:
        if received != job.get("size"):
            raise HTTPException(400, "Size mismatch on finalize")
        if job.get("sha256"):
            file_hash = _sha256_file(Path(job["in_path"]))
            if file_hash != job["sha256"]:
                raise HTTPException(400, "Final checksum mismatch")

        final_path = Path(job["in_path"]).with_suffix(".mbox")
        Path(job["in_path"]).rename(final_path)
        job["in_path"] = str(final_path)
        job["status"]  = "queued"
        save_job(job)
        POOL.submit(parse_job, job_id)
        return JSONResponse({"status": "queued"})

    return JSONResponse({"status": "partial", "received": received})


# ---------------------------------------------------------------------------
# Upload — legacy single-request (compatibility)
# ---------------------------------------------------------------------------

@app.post("/upload")
async def legacy_upload(file: UploadFile = File(...)):
    jid = uuid.uuid4().hex
    dst = UPLOADS_DIR / f"{jid}.mbox"
    total = 0

    with dst.open("wb") as fp:
        while True:
            chunk = await file.read(CHUNK_SIZE)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_BYTES:
                dst.unlink(missing_ok=True)
                raise HTTPException(413, "File too large (max 20 GB)")
            fp.write(chunk)

    job = {
        "id":             jid,
        "status":         "queued",
        "size":           total,
        "filename":       file.filename or "upload.mbox",
        "in_path":        str(dst),
        "total_messages": 0,
        "options": {
            "include_body":        True,
            "include_thread_id":   False,
            "include_attachments": False,
        },
    }
    save_job(job)
    POOL.submit(parse_job, jid)
    return JSONResponse({"job_id": jid})


# ---------------------------------------------------------------------------
# Job status & download
# ---------------------------------------------------------------------------

@app.get("/status/{jid}")
def status(jid: str):
    j = load_job(jid)
    if not j:
        return JSONResponse({"status": "unknown"}, status_code=404)
    return JSONResponse({
        "status":         j["status"],
        "processed":      j.get("processed"),
        "received":       j.get("received"),
        "size":           j.get("size"),
        "total_messages": j.get("total_messages"),
        "error":          j.get("error"),
    })


@app.get("/download/{jid}")
def download(jid: str, background_tasks: BackgroundTasks):
    j = load_job(jid)
    if not j or j.get("status") != "done" or "out_path" not in j:
        raise HTTPException(404, "Not ready")
    j["status"] = "downloaded"
    save_job(j)
    background_tasks.add_task(cleanup_job, jid, j["out_path"])
    return FileResponse(j["out_path"], filename="emails.zip", media_type="application/zip")
