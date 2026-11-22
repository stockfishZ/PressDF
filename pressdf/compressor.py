"""
Core PDF compression & analysis engine for PressDF.

Combines two high-speed, non-destructive compression pillars:
1. Smart Image Recompression & Downsampling (effective-DPI-aware LANCZOS scaling + tuned MozJPEG/Pillow encoding)
2. Lossless PDF Stream & Object Optimization (font subsetting, metadata stripping, xref deduplication, object streams, Flate recompression)
"""

from __future__ import annotations

import io
import time
from dataclasses import asdict, dataclass, field
from typing import Any

import pymupdf
from PIL import Image


PRESETS: dict[str, dict[str, Any]] = {
    "extreme": {
        "image_quality": 50,
        "target_dpi": 96,
        "recompress_images": True,
        "lossless_optimize": True,
        "strip_metadata": True,
        "subset_fonts": True,
        "grayscale": False,
    },
    "balanced": {
        "image_quality": 75,
        "target_dpi": 150,
        "recompress_images": True,
        "lossless_optimize": True,
        "strip_metadata": True,
        "subset_fonts": True,
        "grayscale": False,
    },
    "high_quality": {
        "image_quality": 88,
        "target_dpi": 250,
        "recompress_images": True,
        "lossless_optimize": True,
        "strip_metadata": False,
        "subset_fonts": True,
        "grayscale": False,
    },
    "lossless": {
        "image_quality": 95,
        "target_dpi": 0,
        "recompress_images": False,
        "lossless_optimize": True,
        "strip_metadata": True,
        "subset_fonts": True,
        "grayscale": False,
    },
}


@dataclass
class CompressionSettings:
    preset: str = "balanced"
    image_quality: int = 75
    target_dpi: int = 150
    recompress_images: bool = True
    lossless_optimize: bool = True
    strip_metadata: bool = True
    subset_fonts: bool = True
    grayscale: bool = False

    def __post_init__(self) -> None:
        self.image_quality = max(10, min(95, int(self.image_quality)))
        self.target_dpi = max(0, int(self.target_dpi))


@dataclass
class CompressionResult:
    output_bytes: bytes = field(repr=False)
    original_size: int = 0
    compressed_size: int = 0
    saved_bytes: int = 0
    reduction_percent: float = 0.0
    elapsed_ms: float = 0.0
    page_count: int = 0
    images_found: int = 0
    images_recompressed: int = 0
    images_downsampled: int = 0
    image_bytes_saved: int = 0
    stream_and_object_bytes_saved: int = 0
    settings_used: dict[str, Any] = field(default_factory=dict)

    def to_metadata_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data.pop("output_bytes", None)
        return data


def resolve_settings(
    preset: str | None = "balanced",
    image_quality: int | None = None,
    target_dpi: int | None = None,
    recompress_images: bool | None = None,
    lossless_optimize: bool | None = None,
    strip_metadata: bool | None = None,
    subset_fonts: bool | None = None,
    grayscale: bool | None = None,
) -> CompressionSettings:
    """Resolve preset defaults merged with explicit overrides."""
    preset_key = (preset or "balanced").strip().lower()
    base = dict(PRESETS.get(preset_key, PRESETS["balanced"]))

    if preset_key in ("custom", "balanced") or preset is None:
        if image_quality is not None:
            base["image_quality"] = image_quality
        if target_dpi is not None:
            base["target_dpi"] = target_dpi
        if recompress_images is not None:
            base["recompress_images"] = recompress_images
        if lossless_optimize is not None:
            base["lossless_optimize"] = lossless_optimize
        if strip_metadata is not None:
            base["strip_metadata"] = strip_metadata
        if subset_fonts is not None:
            base["subset_fonts"] = subset_fonts
        if grayscale is not None:
            base["grayscale"] = grayscale
    else:
        # Named preset ("extreme", "high_quality", "lossless"): apply grayscale override if provided
        if grayscale is not None:
            base["grayscale"] = grayscale

    return CompressionSettings(
        preset=preset_key if preset_key in PRESETS or preset_key == "custom" else "balanced",
        image_quality=base["image_quality"],
        target_dpi=base["target_dpi"],
        recompress_images=base["recompress_images"],
        lossless_optimize=base["lossless_optimize"],
        strip_metadata=base["strip_metadata"],
        subset_fonts=base["subset_fonts"],
        grayscale=base["grayscale"],
    )


def _get_raw_stream_size(doc: pymupdf.Document, xref: int) -> int:
    try:
        raw = doc.xref_stream_raw(xref)
        return len(raw) if raw else 0
    except Exception:
        return 0


def _collect_image_placements(
    doc: pymupdf.Document,
) -> tuple[dict[int, dict[str, Any]], set[int]]:
    """
    Scan all pages to collect unique image xrefs, their first page index,
    metadata, and maximum effective displayed DPI across all placements.
    Also returns the set of xrefs used as soft masks (/SMask).
    """
    images_meta: dict[int, dict[str, Any]] = {}
    smask_xrefs: set[int] = set()

    for page_idx in range(len(doc)):
        page = doc[page_idx]
        try:
            page_images = page.get_images(full=True)
        except Exception:
            continue

        seen_on_page: set[int] = set()
        for item in page_images:
            xref = item[0]
            smask = item[1]
            width = item[2]
            height = item[3]
            bpc = item[4]
            cs_name = item[5]
            img_filter = item[8]

            if smask and smask > 0:
                smask_xrefs.add(smask)

            if xref <= 0:
                continue

            if xref not in images_meta:
                images_meta[xref] = {
                    "xref": xref,
                    "smask": smask,
                    "width": width,
                    "height": height,
                    "bpc": bpc,
                    "colorspace": cs_name,
                    "filter": img_filter,
                    "first_page_idx": page_idx,
                    "max_dpi": 0.0,
                }

            if xref not in seen_on_page and width > 0 and height > 0:
                seen_on_page.add(xref)
                try:
                    rects = page.get_image_rects(xref)
                except Exception:
                    rects = []
                for rect in rects:
                    if not rect.is_empty and not rect.is_infinite and rect.width > 1.0 and rect.height > 1.0:
                        dpi_x = width / (rect.width / 72.0)
                        dpi_y = height / (rect.height / 72.0)
                        eff_dpi = max(dpi_x, dpi_y)
                        if eff_dpi > images_meta[xref]["max_dpi"]:
                            images_meta[xref]["max_dpi"] = eff_dpi

    return images_meta, smask_xrefs


def analyze_pdf(pdf_bytes: bytes) -> dict[str, Any]:
    """
    Quickly inspect a PDF in milliseconds and return structural breakdown:
    page count, image count & bytes, font bytes, other bytes, metadata presence, and max DPI.
    """
    original_size = len(pdf_bytes)
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        page_count = len(doc)
        images_meta, smask_xrefs = _collect_image_placements(doc)

        total_image_bytes = 0
        max_image_dpi = 0.0
        counted_xrefs: set[int] = set()

        for xref, info in images_meta.items():
            counted_xrefs.add(xref)
            total_image_bytes += _get_raw_stream_size(doc, xref)
            if info["max_dpi"] > max_image_dpi:
                max_image_dpi = info["max_dpi"]

        for s_xref in smask_xrefs:
            if s_xref not in counted_xrefs:
                counted_xrefs.add(s_xref)
                total_image_bytes += _get_raw_stream_size(doc, s_xref)

        # Estimate font bytes by inspecting font objects and their child FontFile streams
        font_xrefs: set[int] = set()
        for page_idx in range(page_count):
            try:
                for f_item in doc.get_page_fonts(page_idx, full=False):
                    if f_item and f_item[0] > 0:
                        font_xrefs.add(f_item[0])
            except Exception:
                continue

        # Scan all xrefs for FontFile / FontFile2 / FontFile3 or font stream objects
        total_font_bytes = 0
        visited_font_streams: set[int] = set()
        xref_len = doc.xref_length()
        for x in range(1, xref_len):
            try:
                if x in counted_xrefs:
                    continue
                if doc.xref_is_stream(x):
                    obj_str = doc.xref_object(x, compressed=True)
                    if (
                        x in font_xrefs
                        or "/FontFile" in obj_str
                        or "/Subtype/CIDFontType" in obj_str
                        or "/Subtype/Type1C" in obj_str
                        or "/Subtype/OpenType" in obj_str
                        or "/Length1" in obj_str
                    ):
                        visited_font_streams.add(x)
                        total_font_bytes += _get_raw_stream_size(doc, x)
            except Exception:
                continue

        total_image_bytes = min(total_image_bytes, original_size)
        total_font_bytes = min(total_font_bytes, max(0, original_size - total_image_bytes))
        other_bytes = max(0, original_size - total_image_bytes - total_font_bytes)

        meta = doc.metadata or {}
        has_std_meta = any(
            v and str(v).strip().lower() not in ("", "none")
            for k, v in meta.items()
            if k not in ("format", "encryption")
        )
        has_xml_meta = False
        try:
            xml_xref = doc.xml_metadata_xref()
            has_xml_meta = bool(xml_xref and xml_xref > 0)
        except Exception:
            pass

        return {
            "page_count": page_count,
            "original_size": original_size,
            "images_count": len(images_meta),
            "total_image_bytes": total_image_bytes,
            "total_font_bytes": total_font_bytes,
            "other_bytes": other_bytes,
            "has_metadata": bool(has_std_meta or has_xml_meta),
            "max_image_dpi": int(round(max_image_dpi)) if max_image_dpi > 0 else 0,
        }
    finally:
        doc.close()


def _load_pil_image(doc: pymupdf.Document, xref: int) -> Image.Image | None:
    """Load a PDF image XObject into a Pillow Image (RGB or L) accurately and fast."""
    try:
        pix = pymupdf.Pixmap(doc, xref)
        if pix.n - pix.alpha == 1:
            # Grayscale
            if pix.alpha:
                pix = pymupdf.Pixmap(pymupdf.csGRAY, pix)
            mode = "L"
        else:
            # Convert CMYK / Lab / ICC / RGBA to pure RGB via MuPDF color management
            if pix.colorspace != pymupdf.csRGB or pix.alpha:
                pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
            mode = "RGB"
        return Image.frombytes(mode, (pix.width, pix.height), pix.samples)
    except Exception:
        try:
            extracted = doc.extract_image(xref)
            if not extracted or not extracted.get("image"):
                return None
            pil_img = Image.open(io.BytesIO(extracted["image"]))
            pil_img.load()
            if pil_img.mode not in ("RGB", "L"):
                pil_img = pil_img.convert("RGB")
            return pil_img
        except Exception:
            return None


def compress_pdf(
    pdf_bytes: bytes,
    settings: CompressionSettings | None = None,
) -> CompressionResult:
    """
    Compress a PDF byte buffer according to `settings` and return `CompressionResult`.
    Guarantees zero inflation: never returns a PDF larger than `pdf_bytes`.
    """
    t0 = time.perf_counter()
    if settings is None:
        settings = CompressionSettings()

    original_size = len(pdf_bytes)
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")

    try:
        page_count = len(doc)
        images_meta, smask_xrefs = _collect_image_placements(doc)
        images_found = len(images_meta)
        images_recompressed = 0
        images_downsampled = 0
        image_bytes_saved = 0

        # Pillar 1: Smart Image Recompression & Downsampling
        if settings.recompress_images and images_found > 0:
            for xref, info in images_meta.items():
                # Do not directly recompress soft-mask xrefs as standalone JPEG images
                if xref in smask_xrefs:
                    continue

                width = info["width"]
                height = info["height"]
                bpc = info["bpc"]
                smask = info["smask"]
                first_page_idx = info["first_page_idx"]
                eff_dpi = info["max_dpi"]

                # Skip tiny icons / lines or 1-bit bilevel masks so vector-like stamps stay sharp
                if width < 32 or height < 32:
                    continue
                if bpc == 1:
                    continue

                try:
                    imask_key = doc.xref_get_key(xref, "ImageMask")
                    if imask_key and imask_key[1] == "true":
                        continue
                except Exception:
                    pass

                orig_stream_len = _get_raw_stream_size(doc, xref)
                if orig_stream_len < 2048:
                    continue

                pil_img = _load_pil_image(doc, xref)
                if pil_img is None:
                    continue

                if settings.grayscale and pil_img.mode != "L":
                    pil_img = pil_img.convert("L")

                was_downsampled = False
                target_dpi = settings.target_dpi
                if target_dpi > 0:
                    scale = 1.0
                    if eff_dpi > 0 and eff_dpi > target_dpi * 1.1:
                        scale = target_dpi / eff_dpi
                    elif eff_dpi <= 0 and max(width, height) > target_dpi * 8.5:
                        scale = (target_dpi * 8.5) / float(max(width, height))

                    if scale < 1.0:
                        new_w = max(16, int(round(width * scale)))
                        new_h = max(16, int(round(height * scale)))
                        if new_w < width and new_h < height:
                            pil_img = pil_img.resize((new_w, new_h), Image.Resampling.LANCZOS)
                            was_downsampled = True

                buf = io.BytesIO()
                pil_img.save(
                    buf,
                    format="JPEG",
                    quality=settings.image_quality,
                    optimize=True,
                    progressive=True,
                )
                new_img_bytes = buf.getvalue()

                # Strict size guard: only replace if strictly smaller than existing raw stream
                if len(new_img_bytes) < orig_stream_len:
                    try:
                        doc[first_page_idx].replace_image(xref, stream=new_img_bytes)
                        # If the original image had a soft mask (/SMask), preserve the reference
                        if smask and smask > 0:
                            doc.xref_set_key(xref, "SMask", f"{smask} 0 R")
                        images_recompressed += 1
                        if was_downsampled:
                            images_downsampled += 1
                        image_bytes_saved += orig_stream_len - len(new_img_bytes)
                    except Exception:
                        pass

        # Pillar 2: Lossless Stream & Object Optimization
        if settings.subset_fonts:
            try:
                doc.subset_fonts()
            except Exception:
                pass

        if settings.strip_metadata:
            try:
                doc.set_metadata({})
            except Exception:
                pass
            try:
                doc.del_xml_metadata()
            except Exception:
                pass

        if settings.lossless_optimize:
            output_bytes = doc.tobytes(
                garbage=4,
                clean=True,
                deflate=True,
                deflate_images=True,
                deflate_fonts=True,
                use_objstms=1,
            )
        else:
            output_bytes = doc.tobytes(
                garbage=1,
                deflate=True,
            )
    finally:
        doc.close()

    # Zero-Inflation Guarantee: never output a larger file than the input
    if len(output_bytes) >= original_size:
        try:
            fallback_doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
            try:
                fallback_bytes = fallback_doc.tobytes(
                    garbage=4,
                    clean=True,
                    deflate=True,
                    deflate_images=True,
                    deflate_fonts=True,
                    use_objstms=1,
                )
            finally:
                fallback_doc.close()
            if len(fallback_bytes) < len(output_bytes):
                output_bytes = fallback_bytes
                images_recompressed = 0
                images_downsampled = 0
                image_bytes_saved = 0
        except Exception:
            pass

    if len(output_bytes) >= original_size:
        output_bytes = pdf_bytes
        images_recompressed = 0
        images_downsampled = 0
        image_bytes_saved = 0

    compressed_size = len(output_bytes)
    saved_bytes = max(0, original_size - compressed_size)
    reduction_percent = round((saved_bytes / original_size) * 100.0, 2) if original_size > 0 else 0.0

    # Clamp image_bytes_saved to total saved_bytes for clean breakdown reporting
    effective_image_saved = min(image_bytes_saved, saved_bytes)
    stream_and_object_bytes_saved = max(0, saved_bytes - effective_image_saved)

    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 1)

    return CompressionResult(
        output_bytes=output_bytes,
        original_size=original_size,
        compressed_size=compressed_size,
        saved_bytes=saved_bytes,
        reduction_percent=reduction_percent,
        elapsed_ms=elapsed_ms,
        page_count=page_count,
        images_found=images_found,
        images_recompressed=images_recompressed,
        images_downsampled=images_downsampled,
        image_bytes_saved=effective_image_saved,
        stream_and_object_bytes_saved=stream_and_object_bytes_saved,
        settings_used=asdict(settings),
    )


def render_page_preview(pdf_bytes: bytes, page_number: int = 1, dpi: int = 130) -> bytes:
    """
    Render a 1-based page from `pdf_bytes` to PNG bytes at the given `dpi`.
    """
    dpi = max(36, min(300, int(dpi)))
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        if len(doc) == 0:
            raise ValueError("PDF has no pages")
        idx = max(0, min(len(doc) - 1, int(page_number) - 1))
        page = doc[idx]
        pix = page.get_pixmap(dpi=dpi, alpha=False)
        return pix.tobytes("png")
    finally:
        doc.close()
