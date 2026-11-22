"""
CLI & native desktop window launcher for PressDF.
Starts the local FastAPI / Uvicorn server in a background daemon thread
and presents PressDF in a genuine native desktop window via pywebview (Edge WebView2),
with automatic port conflict resolution and clean lifecycle management.
"""

from __future__ import annotations

import argparse
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

import uvicorn
import webview

from pressdf.app import app, build_zip_bytes, get_job_record


def is_pressdf_running(host: str, port: int, timeout: float = 0.8) -> bool:
    """
    Check if an active PressDF instance is responding on host:port/api/health.
    """
    check_host = "127.0.0.1" if host in ("0.0.0.0", "", "::") else host
    url = f"http://{check_host}:{port}/api/health"
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "PressDF-HealthChecker"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                payload = resp.read().decode("utf-8")
                data = json.loads(payload)
                return isinstance(data, dict) and data.get("status") == "ok"
    except Exception:
        return False
    return False


def is_port_in_use(host: str, port: int) -> bool:
    """
    Check if a port is in use on host.
    Performs both an active connect probe and a bind test to handle Windows socket sharing semantics.
    """
    check_host = "127.0.0.1" if host in ("0.0.0.0", "", "::") else host

    # 1. Active connection check: if a service is actively listening, connect() succeeds
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        try:
            s.connect((check_host, port))
            return True
        except OSError:
            pass

    # 2. Bind test: test if the socket address can be bound
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
        except OSError:
            return True

    return False


def find_available_port(host: str, start_port: int, max_attempts: int = 50) -> tuple[int, bool]:
    """
    Search for an available port starting from start_port up to start_port + max_attempts.
    Returns (port, is_pressdf).
    If an existing PressDF instance is detected, returns (port, True).
    If an open available port is found, returns (port, False).
    """
    for offset in range(max_attempts + 1):
        candidate = start_port + offset
        if is_pressdf_running(host, candidate):
            return candidate, True
        if not is_port_in_use(host, candidate):
            return candidate, False

    raise RuntimeError(
        f"Could not find an available port in range {start_port} to {start_port + max_attempts}."
    )


class PressDFBridge:
    """Native pywebview JS API bridge for reliable Save As file dialogs."""

    def __init__(self) -> None:
        self._window: webview.Window | None = None

    def _prompt_save_path(
        self,
        save_filename: str,
        file_types: tuple[str, ...],
        required_ext: str,
    ) -> str | None:
        if self._window is None:
            raise RuntimeError("Native window is not attached.")

        result = self._window.create_file_dialog(
            webview.FileDialog.SAVE,
            save_filename=save_filename,
            file_types=file_types,
        )
        if not result:
            return None

        dest_path = result[0] if isinstance(result, (list, tuple)) else str(result)
        if not dest_path:
            return None

        if required_ext and not dest_path.lower().endswith(required_ext.lower()):
            dest_path = f"{dest_path}{required_ext}"
        return dest_path

    def save_file(self, job_id: str) -> dict[str, str]:
        """Prompt the user to save a single compressed PDF via native Save As dialog."""
        record = get_job_record(job_id)
        if not record:
            return {"status": "error", "detail": "Compressed PDF job not found or expired."}

        dest_path = self._prompt_save_path(
            save_filename=record.output_filename,
            file_types=("PDF Files (*.pdf)", "All files (*.*)"),
            required_ext=".pdf",
        )
        if not dest_path:
            return {"status": "cancelled"}

        Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(record.compressed_path, dest_path)
        return {"status": "saved", "path": dest_path}

    def save_zip(self, job_ids: list[str]) -> dict[str, str]:
        """Package completed PDFs into a ZIP and save via native Save As dialog."""
        try:
            zip_bytes = build_zip_bytes(job_ids)
        except (ValueError, FileNotFoundError) as exc:
            return {"status": "error", "detail": str(exc)}

        dest_path = self._prompt_save_path(
            save_filename="pressdf_batch.zip",
            file_types=("ZIP Archives (*.zip)", "All files (*.*)"),
            required_ext=".zip",
        )
        if not dest_path:
            return {"status": "cancelled"}

        Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
        Path(dest_path).write_bytes(zip_bytes)
        return {"status": "saved", "path": dest_path}


def open_native_window(url: str) -> None:
    """
    Create and start the native pywebview desktop window.
    """
    webview.settings["ALLOW_DOWNLOADS"] = True
    bridge = PressDFBridge()
    window = webview.create_window(
        title="PressDF",
        url=url,
        js_api=bridge,
        width=960,
        height=700,
        min_size=(760, 520),
        background_color="#08090a",
        text_select=True,
    )
    bridge._window = window
    try:
        webview.start(gui="edgechromium", private_mode=False)
    except Exception:
        # Fallback to default webview GUI provider on system
        webview.start(private_mode=False)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the PressDF native desktop application.")
    parser.add_argument("--host", default="127.0.0.1", help="Host interface to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000)")
    parser.add_argument("--no-window", "--no-browser", "--cli", dest="no_window", action="store_true",
                        help="Run server in headless/CLI mode without opening native desktop window")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload for development (non-frozen only)")
    args = parser.parse_args()

    display_host = "127.0.0.1" if args.host in ("0.0.0.0", "", "::") else args.host

    # 1. Check if an existing PressDF instance is already running on the target port
    if is_pressdf_running(args.host, args.port):
        print(f"[INFO] PressDF is already running at http://{display_host}:{args.port}/")
        if not args.no_window:
            open_native_window(f"http://{display_host}:{args.port}")
        return 0

    # 2. Check if the requested port is in use by another application
    target_port = args.port
    if is_port_in_use(args.host, args.port):
        target_port, is_pressdf = find_available_port(args.host, args.port + 1, max_attempts=50)
        if is_pressdf:
            print(f"[INFO] PressDF is already running at http://{display_host}:{target_port}/")
            if not args.no_window:
                open_native_window(f"http://{display_host}:{target_port}")
            return 0

        print(f"[INFO] Port {args.port} is occupied by another process. Automatically using port {target_port}.")

    url = f"http://{display_host}:{target_port}"

    # 3. Start Uvicorn server in a background daemon thread
    config = uvicorn.Config(
        app,
        host=args.host,
        port=target_port,
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config)
    server_thread = threading.Thread(target=server.run, daemon=True)
    server_thread.start()

    # 4. Wait for server to respond on /api/health before launching window
    start_time = time.time()
    server_ready = False
    while time.time() - start_time < 12.0:
        if is_pressdf_running(args.host, target_port, timeout=0.25):
            server_ready = True
            break
        time.sleep(0.05)

    if not server_ready:
        print("[ERROR] Timed out waiting for PressDF local server to start.", file=sys.stderr)
        server.should_exit = True
        return 1

    # 5. Launch native desktop window (or wait in headless mode)
    if args.no_window:
        print(f"[INFO] PressDF server active at {url}")
        try:
            while server_thread.is_alive():
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass
        finally:
            server.should_exit = True
        return 0

    try:
        open_native_window(url)
    finally:
        server.should_exit = True

    return 0


if __name__ == "__main__":
    multiprocessing.freeze_support()
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
    except SystemExit:
        raise
    except Exception as exc:
        print(f"\n[ERROR] PressDF encountered an error: {exc}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)
