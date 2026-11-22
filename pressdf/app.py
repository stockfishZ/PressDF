"""
FastAPI web application for PressDF — fast, local PDF compression engine.
"""

from __future__ import annotations

import asyncio
import io
import os
import re
import shutil
import sys
import tempfile
import time
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from pressdf import __version__
from pressdf.compressor import (
    analyze_pdf,
    compress_pdf,
    render_page_preview,
    resolve_settings,
)


@dataclass
class JobRecord:
    job_id: str
    filename: str
    output_filename: str
    original_path: Path
    compressed_path: Path
    created_at: float
    metadata: dict[str, Any]


STORAGE_ROOT = Path(tempfile.mkdtemp(prefix="pressdf_jobs_"))
MAX_JOBS = 200
JOB_TTL_SECONDS = 7200  # 2 hours

_JOBS: dict[str, JobRecord] = {}


def _cleanup_old_jobs() -> None:
    now = time.time()
    expired = [
        jid
        for jid, rec in _JOBS.items()
        if now - rec.created_at > JOB_TTL_SECONDS
    ]
    for jid in expired:
        rec = _JOBS.pop(jid, None)
        if rec:
            shutil.rmtree(rec.original_path.parent, ignore_errors=True)

    if len(_JOBS) > MAX_JOBS:
        sorted_ids = sorted(_JOBS.keys(), key=lambda k: _JOBS[k].created_at)
        for jid in sorted_ids[: len(_JOBS) - MAX_JOBS]:
            rec = _JOBS.pop(jid, None)
            if rec:
                shutil.rmtree(rec.original_path.parent, ignore_errors=True)


def _make_output_filename(filename: str) -> str:
    base = os.path.basename(filename or "document.pdf")
    stem, ext = os.path.splitext(base)
    safe_stem = re.sub(r"[^\w\-. ()\[\]]+", "_", stem).strip() or "document"
    if safe_stem.endswith("_compressed"):
        return f"{safe_stem}.pdf"
    return f"{safe_stem}_compressed.pdf"


app = FastAPI(
    title="PressDF",
    description="Fast, local PDF compressor combining smart image downsampling and lossless object optimization.",
    version=__version__,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


@app.post("/api/analyze")
async def api_analyze(file: UploadFile = File(...)) -> dict[str, Any]:
    pdf_bytes = await file.read()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    try:
        info = await asyncio.to_thread(analyze_pdf, pdf_bytes)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Could not read PDF file: {exc}",
        ) from exc

    return {
        "filename": file.filename or "document.pdf",
        **info,
    }


@app.post("/api/compress")
async def api_compress(
    file: UploadFile = File(...),
    preset: str = Form("balanced"),
    image_quality: int | None = Form(None),
    target_dpi: int | None = Form(None),
    recompress_images: bool | None = Form(None),
    lossless_optimize: bool | None = Form(None),
    strip_metadata: bool | None = Form(None),
    subset_fonts: bool | None = Form(None),
    grayscale: bool | None = Form(None),
) -> dict[str, Any]:
    pdf_bytes = await file.read()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    settings = resolve_settings(
        preset=preset,
        image_quality=image_quality,
        target_dpi=target_dpi,
        recompress_images=recompress_images,
        lossless_optimize=lossless_optimize,
        strip_metadata=strip_metadata,
        subset_fonts=subset_fonts,
        grayscale=grayscale,
    )

    try:
        result = await asyncio.to_thread(compress_pdf, pdf_bytes, settings)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to compress PDF: {exc}",
        ) from exc

    _cleanup_old_jobs()

    job_id = uuid.uuid4().hex[:12]
    job_dir = STORAGE_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    original_path = job_dir / "original.pdf"
    compressed_path = job_dir / "compressed.pdf"
    original_path.write_bytes(pdf_bytes)
    compressed_path.write_bytes(result.output_bytes)

    orig_filename = file.filename or "document.pdf"
    output_filename = _make_output_filename(orig_filename)

    meta = result.to_metadata_dict()
    response_payload = {
        "job_id": job_id,
        "filename": orig_filename,
        "output_filename": output_filename,
        "download_url": f"/api/download/{job_id}",
        **meta,
    }

    _JOBS[job_id] = JobRecord(
        job_id=job_id,
        filename=orig_filename,
        output_filename=output_filename,
        original_path=original_path,
        compressed_path=compressed_path,
        created_at=time.time(),
        metadata=response_payload,
    )

    return response_payload


def get_job_record(job_id: str) -> JobRecord | None:
    """Return a valid JobRecord for job_id if present and its compressed file exists."""
    record = _JOBS.get(job_id)
    if not record or not record.compressed_path.exists():
        return None
    return record


def build_zip_bytes(job_ids: list[str]) -> bytes:
    """Package compressed PDFs for the given job_ids into an in-memory ZIP archive."""
    if not job_ids:
        raise ValueError("No job_ids provided.")

    valid_records: list[JobRecord] = []
    for jid in job_ids:
        rec = get_job_record(jid)
        if rec:
            valid_records.append(rec)

    if not valid_records:
        raise FileNotFoundError("No valid compressed files found for the given job_ids.")

    zip_buffer = io.BytesIO()
    used_names: dict[str, int] = {}

    with zipfile.ZipFile(zip_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for rec in valid_records:
            arcname = rec.output_filename
            if arcname in used_names:
                used_names[arcname] += 1
                stem, ext = os.path.splitext(arcname)
                arcname = f"{stem}_{used_names[rec.output_filename]}{ext}"
            else:
                used_names[arcname] = 1
            zf.write(rec.compressed_path, arcname=arcname)

    return zip_buffer.getvalue()


@app.get("/api/download/{job_id}")
async def api_download(job_id: str) -> FileResponse:
    record = get_job_record(job_id)
    if not record:
        raise HTTPException(status_code=404, detail="Compressed PDF job not found or expired.")

    return FileResponse(
        path=record.compressed_path,
        media_type="application/pdf",
        filename=record.output_filename,
    )


class BatchZipRequest(BaseModel):
    job_ids: list[str]


@app.post("/api/download-zip")
async def api_download_zip(body: BatchZipRequest) -> StreamingResponse:
    try:
        zip_bytes = build_zip_bytes(body.job_ids)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    headers = {
        "Content-Disposition": 'attachment; filename="pressdf_batch.zip"'
    }
    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers=headers,
    )


@app.get("/api/preview/{job_id}")
async def api_preview(
    job_id: str,
    page: int = Query(1, ge=1),
    version: str = Query("compressed"),
    dpi: int = Query(130, ge=36, le=300),
) -> Response:
    record = _JOBS.get(job_id)
    if not record:
        raise HTTPException(status_code=404, detail="Job not found.")

    target_path = (
        record.original_path
        if version.strip().lower() == "original"
        else record.compressed_path
    )
    if not target_path.exists():
        raise HTTPException(status_code=404, detail="PDF file for preview not found.")

    try:
        pdf_bytes = target_path.read_bytes()
        png_bytes = await asyncio.to_thread(render_page_preview, pdf_bytes, page, dpi)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Preview rendering failed: {exc}") from exc

    return Response(content=png_bytes, media_type="image/png")


def _resolve_static_dir() -> Path:
    """Resolve the static assets directory in both normal and PyInstaller bundled environments."""
    # 1. PyInstaller onefile temp bundle
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        meipass_static = Path(sys._MEIPASS) / "static"
        if meipass_static.exists():
            return meipass_static

    # 2. PyInstaller onedir or adjacent to executable
    if getattr(sys, "frozen", False):
        exe_static = Path(sys.executable).resolve().parent / "static"
        if exe_static.exists():
            return exe_static

    # 3. Source directory: parent of pressdf/ (i.e. project root / static)
    source_static = Path(__file__).resolve().parent.parent / "static"
    if source_static.exists():
        return source_static

    # 4. Fallback to current working directory static
    cwd_static = Path.cwd() / "static"
    if cwd_static.exists():
        return cwd_static

    return source_static


STATIC_DIR = _resolve_static_dir()
STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static_prefixed")
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
