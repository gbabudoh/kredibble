"""Optional server-side text extraction for authenticated API clients.

The web client does NOT use this endpoint: it parses documents in the browser
so content never reaches the server. This exists for on-premises integrations.
Files are processed in memory and never written to disk.
"""
import io
import logging

import pypdf
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel

from app.config import settings
from app.routers.auth import CurrentUser, get_current_user

router = APIRouter()
logger = logging.getLogger("kredibble.documents")

ALLOWED_EXTENSIONS = (".pdf", ".txt", ".md", ".csv", ".json")


class DocumentParseResponse(BaseModel):
    filename: str
    character_count: int
    page_count: int
    extracted_text: str


async def _read_limited(file: UploadFile, limit: int) -> bytes:
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds the {limit // (1024 * 1024)} MB limit.",
        )
    return data


@router.post("/parse", response_model=DocumentParseResponse)
async def parse_document(file: UploadFile = File(...), user: CurrentUser = Depends(get_current_user)):
    filename = file.filename or "upload"
    if not filename.lower().endswith(ALLOWED_EXTENSIONS):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported format. Allowed: {', '.join(ALLOWED_EXTENSIONS)}.",
        )

    data = await _read_limited(file, settings.MAX_UPLOAD_BYTES)
    page_count = 1
    try:
        if filename.lower().endswith(".pdf"):
            reader = pypdf.PdfReader(io.BytesIO(data))
            page_count = len(reader.pages)
            chunks = [(page.extract_text() or "").strip() for page in reader.pages]
            text = "\n\n".join(c for c in chunks if c)
        else:
            text = data.decode("utf-8", errors="replace").strip()
    except Exception:
        # Log the cause server-side; never echo parser internals to the client.
        logger.exception("Document parse failed for user %s", user.email)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The document could not be parsed.",
        )
    finally:
        del data

    return DocumentParseResponse(
        filename=filename,
        character_count=len(text),
        page_count=page_count,
        extracted_text=text,
    )
