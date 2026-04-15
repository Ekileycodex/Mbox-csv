import csv
import io
import mailbox
import zipfile
from pathlib import Path
from typing import Any, Dict, Generator, Optional, Tuple
from email.parser import BytesHeaderParser, BytesParser
from email import policy

from .config import BODY_LIMIT, OUT_DIR
from .jobs import load_job, save_job


# ---------------------------------------------------------------------------
# Header helpers
# ---------------------------------------------------------------------------

def _coerce_header_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    for attr in ("value", "_value"):
        attr_value = getattr(value, attr, None)
        if isinstance(attr_value, str):
            return attr_value
    addresses = None
    if hasattr(value, "addresses"):
        try:
            addresses = value.addresses
        except Exception:
            addresses = None
    if addresses:
        rendered = []
        for addr in addresses:
            addr_spec   = getattr(addr, "addr_spec", "") or ""
            display     = getattr(addr, "display_name", "") or ""
            if display and addr_spec:
                rendered.append(f"{display} <{addr_spec}>")
            elif addr_spec:
                rendered.append(addr_spec)
            else:
                fallback = getattr(addr, "value", None)
                if isinstance(fallback, str) and fallback:
                    rendered.append(fallback)
        if rendered:
            return ", ".join(rendered)
    encode = getattr(value, "encode", None)
    if callable(encode):
        try:
            encoded = encode()
            if isinstance(encoded, str):
                return encoded
        except Exception:
            pass
    try:
        return str(value)
    except Exception:
        return ""


def _header_value(msg, name: str) -> str:
    try:
        return _coerce_header_value(msg.get(name))
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Body extraction
# ---------------------------------------------------------------------------

def _extract_body_text(message) -> str:
    try:
        if message.is_multipart():
            for part in message.walk():
                if part.get_filename():
                    continue
                if part.get_content_type() == "text/plain":
                    try:
                        text = part.get_content()
                    except Exception:
                        payload = part.get_payload(decode=True) or b""
                        charset = part.get_content_charset() or "utf-8"
                        text = payload.decode(charset, errors="replace")
                    text = text.strip()
                    if text:
                        return text[:BODY_LIMIT]
        else:
            if message.get_content_type() == "text/plain":
                try:
                    text = message.get_content()
                except Exception:
                    payload = message.get_payload(decode=True) or b""
                    charset = message.get_content_charset() or "utf-8"
                    text = payload.decode(charset, errors="replace")
                return text.strip()[:BODY_LIMIT]
    except Exception:
        return ""
    return ""


# ---------------------------------------------------------------------------
# Attachment rows
# ---------------------------------------------------------------------------

def _iter_attachment_rows(
    message, message_id: str
) -> Generator[Tuple, None, None]:
    if not hasattr(message, "iter_attachments"):
        return
    for index, part in enumerate(message.iter_attachments(), 1):
        filename     = part.get_filename() or f"attachment-{index}"
        content_type = part.get_content_type() or ""
        size_bytes   = 0
        try:
            payload = part.get_payload(decode=True)
            if payload:
                size_bytes = len(payload)
        except Exception:
            pass
        yield (message_id, filename, content_type, size_bytes)


# ---------------------------------------------------------------------------
# Option normalisation
# ---------------------------------------------------------------------------

def _normalize_options(options: Optional[Dict]) -> Dict[str, bool]:
    options = options or {}
    return {
        "include_body":        True if options.get("include_body") is None else bool(options.get("include_body")),
        "include_thread_id":   bool(options.get("include_thread_id")),
        "include_attachments": bool(options.get("include_attachments")),
    }


# ---------------------------------------------------------------------------
# Main parse worker (runs in thread pool)
# ---------------------------------------------------------------------------

def parse_job(jid: str) -> None:
    j = load_job(jid)
    if not j:
        return

    j["status"]    = "processing"
    j["processed"] = 0
    j.setdefault("total_messages", 0)
    save_job(j)

    src     = Path(j["in_path"])
    out_zip = OUT_DIR / f"{jid}-emails.zip"
    options = _normalize_options(j.get("options"))

    include_body        = options["include_body"]
    include_thread      = options["include_thread_id"]
    include_attachments = options["include_attachments"]

    header_fields = ["date", "from", "to", "cc", "bcc", "subject", "message_id"]
    if include_thread:
        header_fields.append("thread_id")
    if include_body:
        header_fields.append("body")

    attachments_fields = ["message_id", "filename", "content_type", "size_bytes"]

    try:
        mbox_obj      = mailbox.mbox(str(src))
        header_parser = BytesHeaderParser()
        full_parser   = BytesParser(policy=policy.default)
        processed     = 0

        try:
            total_messages = len(mbox_obj)
        except Exception:
            total_messages = 0

        j["total_messages"] = total_messages
        j["processed"]      = 0
        save_job(j)

        update_interval = max(1, total_messages // 200) if total_messages else 50_000

        try:
            with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                with zf.open("emails.csv", "w") as emails_member:
                    with io.TextIOWrapper(emails_member, encoding="utf-8", newline="") as emails_txt:
                        writer = csv.writer(emails_txt)
                        writer.writerow(header_fields)

                        attachments_txt    = None
                        attachments_writer = None
                        if include_attachments:
                            att_member         = zf.open("attachments.csv", "w")
                            attachments_txt    = io.TextIOWrapper(att_member, encoding="utf-8", newline="")
                            attachments_writer = csv.writer(attachments_txt)
                            attachments_writer.writerow(attachments_fields)

                        try:
                            for idx, key in enumerate(mbox_obj.iterkeys(), 1):
                                with mbox_obj.get_file(key) as msg_fp:
                                    if include_body or include_attachments:
                                        msg = full_parser.parse(msg_fp)
                                    else:
                                        msg = header_parser.parse(msg_fp, headersonly=True)

                                message_id = _header_value(msg, "Message-Id")
                                row = [
                                    _header_value(msg, "Date"),
                                    _header_value(msg, "From"),
                                    _header_value(msg, "To"),
                                    _header_value(msg, "Cc"),
                                    _header_value(msg, "Bcc"),
                                    _header_value(msg, "Subject"),
                                    message_id,
                                ]
                                if include_thread:
                                    row.append(_header_value(msg, "X-GM-THRID"))
                                if include_body:
                                    row.append(_extract_body_text(msg))
                                writer.writerow(row)

                                if include_attachments and attachments_writer:
                                    for att_row in _iter_attachment_rows(msg, message_id):
                                        attachments_writer.writerow(att_row)

                                processed = idx
                                if processed % update_interval == 0:
                                    j["processed"] = processed
                                    save_job(j)
                        finally:
                            if attachments_txt:
                                attachments_txt.flush()
                                attachments_txt.close()

            j["status"]         = "done"
            j["processed"]      = processed
            j["total_messages"] = total_messages
            j["out_path"]       = str(out_zip)
            save_job(j)

        finally:
            try:
                mbox_obj.close()
            except Exception:
                pass

    except Exception as exc:
        j["status"] = "error"
        j["error"]  = str(exc)
        save_job(j)

    finally:
        try:
            src.unlink(missing_ok=True)
        except Exception:
            pass
