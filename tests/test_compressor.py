"""
Comprehensive unit and API integration tests for PressDF.
"""

from __future__ import annotations

import io
import zipfile

import pymupdf
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from pressdf.app import app, build_zip_bytes, get_job_record
from pressdf.compressor import (
    CompressionSettings,
    analyze_pdf,
    compress_pdf,
    render_page_preview,
    resolve_settings,
)


def _create_high_res_image_bytes(width: int = 1800, height: int = 1200, fmt: str = "PNG") -> bytes:
    """Create a rich synthetic photographic-style gradient + shapes raster image."""
    img = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(img)
    # Draw gradient bands and geometric patterns so it has realistic entropy
    for y in range(0, height, 4):
        r = int((y / height) * 220)
        g = int(((height - y) / height) * 180)
        b = 140
        draw.rectangle([0, y, width, min(height, y + 4)], fill=(r, g, b))
    for i in range(0, width, 60):
        draw.ellipse([i, i % (height // 2), i + 120, (i % (height // 2)) + 120], outline=(255, 255, 255), width=3)
    buf = io.BytesIO()
    if fmt.upper() == "JPEG":
        img.save(buf, format="JPEG", quality=98)
    else:
        img.save(buf, format="PNG", compress_level=1)
    return buf.getvalue()


def _create_sample_heavy_pdf(pages: int = 3) -> bytes:
    """
    Create a multi-page PDF with:
    - High-DPI raster images (1800x1200 placed in a 360x240 pt box -> 360 DPI)
    - Embedded text and vector shapes
    - Document metadata & XML metadata
    """
    doc = pymupdf.open()
    img_bytes_1 = _create_high_res_image_bytes(1800, 1200, fmt="PNG")
    img_bytes_2 = _create_high_res_image_bytes(1500, 1000, fmt="JPEG")

    for i in range(pages):
        page = doc.new_page(width=595, height=842)  # A4
        page.insert_text(
            pymupdf.Point(50, 50),
            f"PressDF Benchmark Document - Page {i + 1} of {pages}",
            fontsize=16,
        )
        page.insert_text(
            pymupdf.Point(50, 80),
            "Vector text and vector paths remain 100% sharp and selectable after compression.",
            fontsize=11,
        )
        # Draw vector rectangle
        shape = page.new_shape()
        shape.draw_rect(pymupdf.Rect(45, 30, 550, 95))
        shape.finish(color=(0.1, 0.4, 0.8), width=1.5)
        shape.commit()

        # Place 1800x1200 image in 360x240 pt rect -> effective DPI = 1800 / (360/72) = 360 DPI
        rect1 = pymupdf.Rect(50, 120, 410, 360)
        page.insert_image(rect1, stream=img_bytes_1)

        # Place 1500x1000 image in 300x200 pt rect -> effective DPI = 1500 / (300/72) = 360 DPI
        rect2 = pymupdf.Rect(50, 390, 350, 590)
        page.insert_image(rect2, stream=img_bytes_2)

    doc.set_metadata(
        {
            "title": "PressDF Heavy Test Document",
            "author": "PressDF Test Suite",
            "subject": "High-DPI PDF Compression Verification",
            "keywords": "pdf, compression, pymupdf, pillow",
            "creator": "PressDF Synthetic Generator",
        }
    )
    doc.set_xml_metadata(
        '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>'
        "<x:xmpmeta xmlns:x='adobe:ns:meta/'>" + ("<!-- padding -->" * 200) + "</x:xmpmeta>"
        '<?xpacket end="w"?>'
    )
    # Save uncompressed initially to simulate bloated PDF exports
    raw_pdf = doc.tobytes(garbage=0, deflate=False)
    doc.close()
    return raw_pdf


def _create_tiny_already_optimal_pdf() -> bytes:
    """Create a tiny, maximally compressed 1-page PDF to test Zero-Inflation Guarantee."""
    doc = pymupdf.open()
    page = doc.new_page(width=200, height=200)
    page.insert_text(pymupdf.Point(20, 50), "Tiny PDF", fontsize=12)
    out = doc.tobytes(garbage=4, clean=True, deflate=True, use_objstms=1)
    doc.close()
    return out


def test_analyze_pdf():
    pdf_bytes = _create_sample_heavy_pdf(pages=2)
    analysis = analyze_pdf(pdf_bytes)

    assert analysis["page_count"] == 2
    assert analysis["original_size"] == len(pdf_bytes)
    assert analysis["images_count"] >= 2
    assert analysis["total_image_bytes"] > 50_000
    assert analysis["has_metadata"] is True
    assert analysis["max_image_dpi"] >= 350


def test_compress_presets_hierarchy_and_text_preservation():
    pdf_bytes = _create_sample_heavy_pdf(pages=2)

    res_extreme = compress_pdf(pdf_bytes, resolve_settings("extreme"))
    res_balanced = compress_pdf(pdf_bytes, resolve_settings("balanced"))
    res_hq = compress_pdf(pdf_bytes, resolve_settings("high_quality"))
    res_lossless = compress_pdf(pdf_bytes, resolve_settings("lossless"))

    # All modes must significantly reduce the bloated PDF
    assert res_extreme.compressed_size < res_balanced.compressed_size
    assert res_balanced.compressed_size < res_hq.compressed_size
    assert res_hq.compressed_size < res_lossless.compressed_size
    assert res_lossless.compressed_size < len(pdf_bytes)

    assert res_balanced.reduction_percent > 60.0
    assert res_balanced.images_recompressed >= 2
    assert res_balanced.images_downsampled >= 2

    # Verify text is 100% preserved and readable in compressed output
    out_doc = pymupdf.open(stream=res_balanced.output_bytes, filetype="pdf")
    try:
        assert len(out_doc) == 2
        text_p1 = out_doc[0].get_text()
        assert "PressDF Benchmark Document - Page 1 of 2" in text_p1
        assert "Vector text and vector paths remain 100% sharp" in text_p1
    finally:
        out_doc.close()


def test_transparent_image_smask_preservation():
    """Verify RGBA PNG images with /SMask transparency are compressed safely without losing alpha mask."""
    img = Image.new("RGBA", (1200, 800), (30, 140, 220, 180))
    draw = ImageDraw.Draw(img)
    draw.ellipse([100, 100, 900, 700], fill=(255, 80, 60, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=1)

    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_image(pymupdf.Rect(50, 50, 290, 210), stream=buf.getvalue())
    raw_pdf = doc.tobytes(garbage=0, deflate=False)
    doc.close()

    res = compress_pdf(raw_pdf, resolve_settings("balanced"))
    assert res.compressed_size < len(raw_pdf)
    out_doc = pymupdf.open(stream=res.output_bytes, filetype="pdf")
    try:
        imgs = out_doc[0].get_images(full=True)
        assert len(imgs) == 1
        # Soft mask reference should remain valid
        assert imgs[0][1] > 0
    finally:
        out_doc.close()


def test_grayscale_conversion():
    pdf_bytes = _create_sample_heavy_pdf(pages=1)
    settings_color = CompressionSettings(preset="balanced", grayscale=False)
    settings_gray = CompressionSettings(preset="balanced", grayscale=True)

    res_color = compress_pdf(pdf_bytes, settings_color)
    res_gray = compress_pdf(pdf_bytes, settings_gray)

    assert res_gray.compressed_size < res_color.compressed_size


def test_zero_inflation_guarantee():
    tiny_pdf = _create_tiny_already_optimal_pdf()
    res = compress_pdf(tiny_pdf, resolve_settings("balanced"))
    assert res.compressed_size <= len(tiny_pdf)
    assert res.saved_bytes >= 0


def test_render_page_preview():
    pdf_bytes = _create_sample_heavy_pdf(pages=1)
    png_bytes = render_page_preview(pdf_bytes, page_number=1, dpi=96)
    assert png_bytes.startswith(b"\x89PNG")
    img = Image.open(io.BytesIO(png_bytes))
    assert img.width > 100 and img.height > 100


def test_fastapi_endpoints():
    client = TestClient(app)

    # 1. Health check
    r_health = client.get("/api/health")
    assert r_health.status_code == 200
    assert r_health.json()["status"] == "ok"

    pdf_bytes = _create_sample_heavy_pdf(pages=2)

    # 2. Analyze endpoint
    r_analyze = client.post(
        "/api/analyze",
        files={"file": ("report.pdf", pdf_bytes, "application/pdf")},
    )
    assert r_analyze.status_code == 200
    data_analyze = r_analyze.json()
    assert data_analyze["filename"] == "report.pdf"
    assert data_analyze["page_count"] == 2
    assert data_analyze["images_count"] >= 2

    # 3. Compress endpoint
    r_compress = client.post(
        "/api/compress",
        files={"file": ("report.pdf", pdf_bytes, "application/pdf")},
        data={
            "preset": "balanced",
            "image_quality": "75",
            "target_dpi": "150",
            "recompress_images": "true",
            "lossless_optimize": "true",
            "strip_metadata": "true",
            "subset_fonts": "true",
            "grayscale": "false",
        },
    )
    assert r_compress.status_code == 200
    data_comp = r_compress.json()
    job_id = data_comp["job_id"]
    assert data_comp["output_filename"] == "report_compressed.pdf"
    assert data_comp["compressed_size"] < data_comp["original_size"]
    assert data_comp["reduction_percent"] > 60.0

    # 4. Preview endpoint (both original and compressed)
    r_prev_orig = client.get(f"/api/preview/{job_id}?page=1&version=original&dpi=96")
    assert r_prev_orig.status_code == 200
    assert r_prev_orig.headers["content-type"] == "image/png"
    assert r_prev_orig.content.startswith(b"\x89PNG")

    r_prev_comp = client.get(f"/api/preview/{job_id}?page=1&version=compressed&dpi=96")
    assert r_prev_comp.status_code == 200
    assert r_prev_comp.content.startswith(b"\x89PNG")

    # 5. Single file download endpoint
    r_dl = client.get(f"/api/download/{job_id}")
    assert r_dl.status_code == 200
    assert r_dl.headers["content-type"] == "application/pdf"
    assert len(r_dl.content) == data_comp["compressed_size"]

    # 6. Batch ZIP download endpoint (with duplicate job_id to verify filename deduplication)
    r_zip = client.post("/api/download-zip", json={"job_ids": [job_id, job_id]})
    assert r_zip.status_code == 200
    assert r_zip.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(r_zip.content), "r") as zf:
        names = zf.namelist()
        assert "report_compressed.pdf" in names
        assert "report_compressed_2.pdf" in names


def test_get_job_record_and_build_zip_bytes(tmp_path):
    client = TestClient(app)
    pdf_bytes = _create_sample_heavy_pdf(pages=1)

    r_comp = client.post(
        "/api/compress",
        files={"file": ("sample.pdf", pdf_bytes, "application/pdf")},
        data={"preset": "balanced"},
    )
    assert r_comp.status_code == 200
    job_id = r_comp.json()["job_id"]

    rec = get_job_record(job_id)
    assert rec is not None
    assert rec.output_filename == "sample_compressed.pdf"
    assert get_job_record("nonexistent_job_id") is None

    zip_bytes = build_zip_bytes([job_id, "nonexistent_job_id", job_id])
    with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
        names = zf.namelist()
        assert names == ["sample_compressed.pdf", "sample_compressed_2.pdf"]
        assert zf.read("sample_compressed.pdf") == rec.compressed_path.read_bytes()

    with pytest.raises(ValueError):
        build_zip_bytes([])

    with pytest.raises(FileNotFoundError):
        build_zip_bytes(["missing_1", "missing_2"])

    # Verify missing compressed file on disk causes get_job_record to return None
    backup_bytes = rec.compressed_path.read_bytes()
    rec.compressed_path.unlink()
    try:
        assert get_job_record(job_id) is None
    finally:
        rec.compressed_path.write_bytes(backup_bytes)


def test_index_html_omits_offline_badge():
    client = TestClient(app)
    resp = client.get("/")
    assert resp.status_code == 200
    assert "offline-badge" not in resp.text
    assert "100% Offline" not in resp.text
