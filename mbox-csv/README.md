# MBOX → CSV Converter

A self-hosted FastAPI web app that converts MBOX email archives to CSV spreadsheets.
Accepts files up to 20 GB via resumable, SHA-256-verified chunked uploads, parses
every message server-side, and delivers a `emails.zip` download — then deletes all
temporary files automatically.

Live at [mbox-csv.com](https://mbox-csv.com).

---

## Features

- **20 GB upload limit** with resumable chunked transfers (16 MB chunks)
- **Per-chunk SHA-256 verification** — corrupt uploads are rejected before parsing
- **Server-side MBOX parsing** using Python's stdlib `mailbox` module
- **CSV output columns:** `date`, `from`, `to`, `cc`, `bcc`, `subject`, `message_id`, `body`
- Optional `thread_id` (Gmail `X-GM-THRID`) and `attachments.csv` sidecar
- **Auto-cleanup** — uploaded and output files are deleted after download
- **Progress polling** — frontend polls `/status/{job_id}` every 1.5 s
- Legacy single-request `/upload` endpoint for small files / scripted use

---

## Project Structure

```
mbox-csv/
├── app/
│   ├── __init__.py
│   ├── config.py       # Constants, paths, thread pool
│   ├── models.py       # Pydantic request models
│   ├── jobs.py         # Job state: load / save / cleanup
│   ├── parser.py       # MBOX → CSV conversion worker
│   └── main.py         # FastAPI app and all routes
├── pages/
│   ├── index.html      # Home page (served at /)
│   ├── how-to.html
│   ├── faq.html
│   ├── privacy.html
│   ├── terms.html
│   ├── contact.html
│   ├── support.html
│   ├── robots.txt
│   └── sitemap.xml
├── static/
│   ├── app.css
│   ├── ads.txt
│   └── csv-preview.svg
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
└── .gitignore
```

---

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/your-org/mbox-csv.git
cd mbox-csv
docker compose up --build
```

The app will be available at `http://localhost:8000`.

Data is stored in two named Docker volumes:

| Volume           | Purpose                          |
|------------------|----------------------------------|
| `mbox_data`      | In-progress uploads + job state  |
| `mbox_downloads` | Completed ZIP files (pre-delete) |

### Local development

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Create the runtime directories expected by config.py
mkdir -p /data/uploads /data/jobs /downloads

uvicorn app.main:app --reload --port 8000
```

---

## API Reference

### `POST /upload/init`

Initialise a chunked upload job.

**Body (JSON):**

```json
{
  "filename": "archive.mbox",
  "size": 1073741824,
  "sha256": "abc123...",        
  "include_body": true,
  "include_thread_id": false,
  "include_attachments": false
}
```

**Response:**

```json
{ "job_id": "<hex>", "chunk_size": 16777216 }
```

---

### `POST /upload/chunk`

Upload one chunk (multipart/form-data).

| Field        | Type    | Description                        |
|--------------|---------|------------------------------------|
| `job_id`     | string  | From `/upload/init`                |
| `index`      | int     | Zero-based chunk index             |
| `total`      | int     | Total number of chunks             |
| `final`      | bool    | `true` on the last chunk           |
| `chunk_hash` | string  | SHA-256 hex of this chunk's bytes  |
| `chunk`      | file    | Raw chunk bytes                    |

---

### `GET /status/{job_id}`

Poll conversion progress.

```json
{
  "status": "processing",
  "processed": 4200,
  "total_messages": 12000,
  "received": 1073741824,
  "size": 1073741824,
  "error": null
}
```

Status values: `uploading` → `queued` → `processing` → `done` | `error`

---

### `GET /download/{job_id}`

Download the finished `emails.zip`. Triggers background cleanup of all job files.

---

### `POST /upload` *(legacy)*

Single-request upload for files that fit in memory. Accepts a multipart `file` field.
Returns `{ "job_id": "<hex>" }`.

---

## Configuration

All tunables live in `app/config.py`:

| Constant      | Default  | Description                        |
|---------------|----------|------------------------------------|
| `MAX_BYTES`   | 20 GB    | Maximum accepted upload size       |
| `CHUNK_SIZE`  | 16 MB    | Chunk size advertised to clients   |
| `BODY_LIMIT`  | 32 000   | Max characters kept per email body |
| `POOL`        | 2 workers| Thread pool size for parse jobs    |

Runtime paths (`/data`, `/downloads`) are Docker volume mount points. Override
`DATA_DIR` and `OUT_DIR` in `config.py` for bare-metal deployments.

---

## Deploying Behind a Reverse Proxy

Set your proxy's client body size limit to at least **20 GB**. Example for nginx:

```nginx
client_max_body_size 20g;

location / {
    proxy_pass         http://127.0.0.1:8000;
    proxy_read_timeout 3600;
    proxy_send_timeout 3600;
}
```

---

## License

MIT
