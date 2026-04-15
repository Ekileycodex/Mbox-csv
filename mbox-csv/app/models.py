from typing import Optional
from pydantic import BaseModel


class UploadInit(BaseModel):
    filename: str
    size: int
    sha256: Optional[str] = None
    include_body: bool = True
    include_thread_id: bool = False
    include_attachments: bool = False
