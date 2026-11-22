# PressDF

Precision local PDF compression studio with two editions: a **100% client-side Browser Edition** ready for GitHub Pages and a **Desktop / Local Server Edition** powered by FastAPI, PyMuPDF, Pillow, and `pywebview`.

## Editions

### 1. Browser Edition (`docs/`)
- **100% Client-Side**: Runs entirely in your browser with zero server uploads.
- **Pure-JS Stack**: Built with [`pdf-lib`](docs/vendor/pdf-lib.min.js), [`PDF.js`](docs/vendor/pdf.min.js), and [`JSZip`](docs/vendor/jszip.min.js) (`DecompressionStream` + HTML5 Canvas).
- **Capabilities**: Image recompression & DPI downsampling, optional grayscale conversion, metadata stripping, PDF object streams, batch ZIP export, zero-inflation guard, and a Before/After visual quality inspector (Split & Flip views).
- **GitHub Pages**: Serve directly from `/docs` on `main` (e.g., `https://stockfishz.github.io/PressDF/`).

### 2. Desktop / Local Server Edition (`pressdf/`, `run.py`, `static/`)
- **Engine**: FastAPI + PyMuPDF (`pymupdf`) + Pillow + `pywebview` (Edge WebView2) native desktop window.
- **Smart Image Optimization**: Effective-DPI-aware `LANCZOS` downsampling and progressive JPEG recompression with strict per-image size guards and soft-mask (`/SMask`) preservation.
- **Lossless Structural Optimization**: Font subsetting (`doc.subset_fonts()`), metadata & XMP stripping, xref garbage collection (`garbage=4`), stream cleaning (`clean=True`), Flate deflation, and object streams (`use_objstms=1`).
- **Zero-Inflation Guarantee**: Never outputs a file larger than the original PDF.
- **Desktop UX**: Native Save As dialogs for single PDFs and batch ZIP exports, plus a Before/After page comparison inspector (`Split` & `Flip` modes).

## Compression Presets

| Preset | Quality | Target DPI | Image Recompression | Metadata Strip |
| --- | --- | --- | --- | --- |
| **Balanced** *(Default)* | 75% | 150 DPI | On | On |
| **Maximum** (`extreme`) | 50% | 96 DPI | On | On |
| **High Quality** | 88% | 250 DPI | On | Off |
| **Lossless** | — | Original | Off | On |

Custom overrides for quality, target DPI, grayscale conversion, font subsetting, and lossless optimization are available under **Advanced options**.

## Quickstart (Desktop / Local Server)

### Prerequisites
- Python 3.11+

### Install Dependencies
```bash
pip install -r requirements.txt
pip install pywebview
```

### Run from Source
Launch the native desktop window (with automatic port conflict resolution):
```bash
python run.py
```

Run in headless local server mode (no native window):
```bash
python run.py --no-window
# alias: python run.py --no-browser
```

Optional server flags:
```bash
python run.py --host 127.0.0.1 --port 8000
```

### Run Tests
```bash
pytest
```

### Build Windows Executable
Build the standalone `dist/PressDF.exe` with PyInstaller:
```bash
pip install pyinstaller
pyinstaller PressDF.spec
```

## Project Layout

```text
PressDF/
├── docs/                  # Browser Edition (GitHub Pages root)
│   ├── index.html
│   ├── app.js
│   ├── compressor.js
│   ├── styles.css
│   └── vendor/            # Bundled pdf-lib, PDF.js, JSZip
├── pressdf/               # FastAPI backend & PyMuPDF compression engine
│   ├── app.py
│   └── compressor.py
├── static/                # Frontend assets for Desktop / Local Server Edition
├── tests/                 # Pytest unit & integration tests
├── run.py                 # CLI & pywebview desktop launcher
├── PressDF.spec           # PyInstaller build spec
├── pressdf.ico            # Application icon
├── requirements.txt
└── pyproject.toml
```
