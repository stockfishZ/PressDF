"""
Unit tests for PressDF launcher and port conflict resolution in run.py.
"""

from __future__ import annotations

import http.server
import io
import socket
import threading
import time
import zipfile
from unittest.mock import MagicMock, patch

import pymupdf
import pytest
import webview

from pressdf.app import _JOBS, JobRecord
import run


class DummyHTTPHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status": "ok", "version": "1.0.0"}')
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress server logs during test


class OtherServiceHTTPHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b"<html>Hello from Apache/Nginx</html>")

    def log_message(self, format, *args):
        pass


def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_is_port_in_use_detects_free_and_bound_ports():
    free_port = get_free_port()
    assert not run.is_port_in_use("127.0.0.1", free_port)

    # Bind a socket to free_port
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", free_port))
    s.listen(1)
    try:
        assert run.is_port_in_use("127.0.0.1", free_port)
    finally:
        s.close()

    assert not run.is_port_in_use("127.0.0.1", free_port)


def test_is_pressdf_running():
    free_port = get_free_port()
    # When nothing is running
    assert not run.is_pressdf_running("127.0.0.1", free_port)

    # When PressDF mock is running
    server = http.server.HTTPServer(("127.0.0.1", free_port), DummyHTTPHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    try:
        assert run.is_pressdf_running("127.0.0.1", free_port)
    finally:
        server.shutdown()
        server.server_close()


def test_is_pressdf_running_rejects_other_service():
    free_port = get_free_port()
    server = http.server.HTTPServer(("127.0.0.1", free_port), OtherServiceHTTPHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    try:
        # Other service returns HTML, not {"status": "ok"}
        assert not run.is_pressdf_running("127.0.0.1", free_port)
        # But it IS in use
        assert run.is_port_in_use("127.0.0.1", free_port)
    finally:
        server.shutdown()
        server.server_close()


def test_find_available_port_falls_back():
    port1 = get_free_port()
    port2 = port1 + 1

    # Occupy port1 with a dummy generic socket
    s1 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s1.bind(("127.0.0.1", port1))
    s1.listen(1)

    try:
        # Searching from port1 should detect port1 is occupied and pick port2 (or another free port)
        found_port, is_pressdf = run.find_available_port("127.0.0.1", port1, max_attempts=10)
        assert not is_pressdf
        assert found_port != port1
        assert found_port >= port2
    finally:
        s1.close()


def test_main_already_running_exits_cleanly(capsys):
    free_port = get_free_port()
    server = http.server.HTTPServer(("127.0.0.1", free_port), DummyHTTPHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    try:
        test_args = ["run.py", "--port", str(free_port), "--no-browser"]
        with patch.object(run.sys, "argv", test_args):
            exit_code = run.main()
            assert exit_code == 0

        captured = capsys.readouterr()
        assert f"[INFO] PressDF is already running at http://127.0.0.1:{free_port}/" in captured.out
    finally:
        server.shutdown()
        server.server_close()


def _register_temp_job(tmp_path, job_id: str, output_filename: str) -> JobRecord:
    job_dir = tmp_path / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    orig_path = job_dir / "original.pdf"
    comp_path = job_dir / "compressed.pdf"

    doc = pymupdf.open()
    page = doc.new_page(width=200, height=200)
    page.insert_text(pymupdf.Point(20, 50), f"PDF {job_id}", fontsize=12)
    pdf_bytes = doc.tobytes(garbage=4, clean=True, deflate=True)
    doc.close()

    orig_path.write_bytes(pdf_bytes)
    comp_path.write_bytes(pdf_bytes)

    rec = JobRecord(
        job_id=job_id,
        filename=output_filename.replace("_compressed", ""),
        output_filename=output_filename,
        original_path=orig_path,
        compressed_path=comp_path,
        created_at=time.time(),
        metadata={},
    )
    _JOBS[job_id] = rec
    return rec


def test_bridge_save_file_success_and_cancel(tmp_path):
    rec = _register_temp_job(tmp_path, "bridge_job_1", "alpha_compressed.pdf")
    try:
        bridge = run.PressDFBridge()
        mock_window = MagicMock()
        bridge._window = mock_window

        # Missing job returns structured error
        missing_res = bridge.save_file("does_not_exist")
        assert missing_res["status"] == "error"

        # User cancels dialog
        mock_window.create_file_dialog.return_value = None
        cancel_res = bridge.save_file(rec.job_id)
        assert cancel_res == {"status": "cancelled"}

        # User picks path without .pdf extension
        dest_base = tmp_path / "saved_outputs" / "my_compressed_doc"
        mock_window.create_file_dialog.return_value = (str(dest_base),)
        saved_res = bridge.save_file(rec.job_id)

        expected_path = f"{dest_base}.pdf"
        assert saved_res == {"status": "saved", "path": expected_path}
        assert (tmp_path / "saved_outputs" / "my_compressed_doc.pdf").read_bytes() == rec.compressed_path.read_bytes()
        mock_window.create_file_dialog.assert_called_with(
            webview.FileDialog.SAVE,
            save_filename="alpha_compressed.pdf",
            file_types=("PDF Files (*.pdf)", "All files (*.*)"),
        )
    finally:
        _JOBS.pop(rec.job_id, None)


def test_bridge_save_zip_success_and_cancel(tmp_path):
    rec1 = _register_temp_job(tmp_path, "bridge_zip_1", "one_compressed.pdf")
    rec2 = _register_temp_job(tmp_path, "bridge_zip_2", "two_compressed.pdf")
    try:
        bridge = run.PressDFBridge()
        mock_window = MagicMock()
        bridge._window = mock_window

        # Empty job_ids returns error without opening dialog
        assert bridge.save_zip([])["status"] == "error"
        mock_window.create_file_dialog.assert_not_called()

        # User cancels dialog
        mock_window.create_file_dialog.return_value = None
        assert bridge.save_zip([rec1.job_id, rec2.job_id]) == {"status": "cancelled"}

        # User selects path without .zip extension
        dest_base = tmp_path / "zips" / "bundle"
        mock_window.create_file_dialog.return_value = (str(dest_base),)
        saved_res = bridge.save_zip([rec1.job_id, rec2.job_id])

        expected_zip = f"{dest_base}.zip"
        assert saved_res == {"status": "saved", "path": expected_zip}
        with zipfile.ZipFile(expected_zip, "r") as zf:
            assert sorted(zf.namelist()) == ["one_compressed.pdf", "two_compressed.pdf"]
            assert zf.read("one_compressed.pdf") == rec1.compressed_path.read_bytes()
            assert zf.read("two_compressed.pdf") == rec2.compressed_path.read_bytes()
        mock_window.create_file_dialog.assert_called_with(
            webview.FileDialog.SAVE,
            save_filename="pressdf_batch.zip",
            file_types=("ZIP Archives (*.zip)", "All files (*.*)"),
        )
    finally:
        _JOBS.pop(rec1.job_id, None)
        _JOBS.pop(rec2.job_id, None)


def test_open_native_window_enables_downloads_and_attaches_bridge():
    fake_window = MagicMock()
    with patch.object(run.webview, "create_window", return_value=fake_window) as mock_create, \
         patch.object(run.webview, "start") as mock_start:
        run.open_native_window("http://127.0.0.1:8000")

        assert run.webview.settings["ALLOW_DOWNLOADS"] is True
        mock_create.assert_called_once()
        kwargs = mock_create.call_args.kwargs
        assert isinstance(kwargs["js_api"], run.PressDFBridge)
        assert kwargs["js_api"]._window is fake_window
        mock_start.assert_called_once_with(gui="edgechromium", private_mode=False)
