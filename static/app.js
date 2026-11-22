/**
 * PressDF — Native Linear Desktop App Controller
 * Zero-build, fast, responsive JavaScript controller.
 */

(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Preset Definitions
  // ---------------------------------------------------------------------------
  const PRESET_PROFILES = {
    extreme: {
      label: "MAXIMUM",
      recompress_images: true,
      image_quality: 50,
      target_dpi: 96,
      grayscale: false,
      lossless_optimize: true,
      subset_fonts: true,
      strip_metadata: true,
    },
    balanced: {
      label: "BALANCED",
      recompress_images: true,
      image_quality: 75,
      target_dpi: 150,
      grayscale: false,
      lossless_optimize: true,
      subset_fonts: true,
      strip_metadata: true,
    },
    high_quality: {
      label: "HIGH QUALITY",
      recompress_images: true,
      image_quality: 88,
      target_dpi: 250,
      grayscale: false,
      lossless_optimize: true,
      subset_fonts: true,
      strip_metadata: false,
    },
    lossless: {
      label: "LOSSLESS",
      recompress_images: false,
      image_quality: 95,
      target_dpi: 0,
      grayscale: false,
      lossless_optimize: true,
      subset_fonts: true,
      strip_metadata: true,
    },
  };

  // ---------------------------------------------------------------------------
  // Application State
  // ---------------------------------------------------------------------------
  const state = {
    preset: "balanced",
    settings: { ...PRESET_PROFILES.balanced },
    settingsDirty: false,
    customPanelOpen: false,
    items: [], // Array of { id, file, status: 'processing'|'done'|'error', analysis, result, error }
    inspector: {
      open: false,
      itemId: null,
      page: 1,
      pageCount: 1,
      zoom: 100,
      viewMode: "split", // 'split' | 'flip'
      flipShowingOriginal: false,
    },
  };

  // ---------------------------------------------------------------------------
  // DOM Elements
  // ---------------------------------------------------------------------------
  const dom = {
    // Presets & Custom Drawer
    presetPills: Array.from(document.querySelectorAll(".preset-pill")),
    customToggleBtn: document.getElementById("customToggleBtn"),
    customPanel: document.getElementById("customPanel"),
    sliderQuality: document.getElementById("sliderQuality"),
    qualityReadout: document.getElementById("qualityReadout"),
    dpiPills: Array.from(document.querySelectorAll(".dpi-pill")),
    dpiReadout: document.getElementById("dpiReadout"),
    toggleRecompressImages: document.getElementById("toggleRecompressImages"),
    toggleGrayscale: document.getElementById("toggleGrayscale"),
    toggleLosslessOptimize: document.getElementById("toggleLosslessOptimize"),
    toggleSubsetFonts: document.getElementById("toggleSubsetFonts"),
    toggleStripMetadata: document.getElementById("toggleStripMetadata"),

    // Dropzone & File Ingestion
    dropzone: document.getElementById("dropzone"),
    fileInput: document.getElementById("fileInput"),
    fileList: document.getElementById("fileList"),

    // Bottom Action Bar
    bottomBar: document.getElementById("bottomBar"),
    summaryStat: document.getElementById("summaryStat"),
    settingsDirtyPill: document.getElementById("settingsDirtyPill"),
    recompressAllBtn: document.getElementById("recompressAllBtn"),
    downloadZipBtn: document.getElementById("downloadZipBtn"),
    downloadZipLabel: document.getElementById("downloadZipLabel"),
    clearQueueBtn: document.getElementById("clearQueueBtn"),

    // Quality Inspector Modal
    inspectorModal: document.getElementById("inspectorModal"),
    inspectorTitle: document.getElementById("inspectorTitle"),
    inspectorTelemetryPill: document.getElementById("inspectorTelemetryPill"),
    viewModeSplitBtn: document.getElementById("viewModeSplitBtn"),
    viewModeFlipBtn: document.getElementById("viewModeFlipBtn"),
    prevPageBtn: document.getElementById("prevPageBtn"),
    nextPageBtn: document.getElementById("nextPageBtn"),
    pageIndicator: document.getElementById("pageIndicator"),
    zoomBtns: Array.from(document.querySelectorAll(".zoom-btn")),
    inspectorDownloadBtn: document.getElementById("inspectorDownloadBtn"),
    closeInspectorBtn: document.getElementById("closeInspectorBtn"),
    flipModeBanner: document.getElementById("flipModeBanner"),
    flipStateLabel: document.getElementById("flipStateLabel"),
    flipToggleBtn: document.getElementById("flipToggleBtn"),
    inspectorStage: document.getElementById("inspectorStage"),
    paneOriginal: document.getElementById("paneOriginal"),
    paneCompressed: document.getElementById("paneCompressed"),
    paneOriginalSize: document.getElementById("paneOriginalSize"),
    paneCompressedSize: document.getElementById("paneCompressedSize"),
    scrollOriginal: document.getElementById("scrollOriginal"),
    scrollCompressed: document.getElementById("scrollCompressed"),
    loaderOriginal: document.getElementById("loaderOriginal"),
    loaderCompressed: document.getElementById("loaderCompressed"),
    imgOriginal: document.getElementById("imgOriginal"),
    imgCompressed: document.getElementById("imgCompressed"),

    toastContainer: document.getElementById("toastContainer"),
  };

  // ---------------------------------------------------------------------------
  // Helper Utilities
  // ---------------------------------------------------------------------------
  function formatBytes(bytes) {
    if (bytes === undefined || bytes === null || isNaN(bytes)) return "0 B";
    const sign = bytes < 0 ? "-" : "";
    const abs = Math.abs(bytes);
    if (abs < 1024) return `${sign}${abs} B`;
    if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`;
    return `${sign}${(abs / (1024 * 1024)).toFixed(2)} MB`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  function showToast(message, isError = false) {
    const toast = document.createElement("div");
    toast.className = `toast ${isError ? "toast-error" : ""}`;
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 3600);
  }

  function hasPywebviewBridge() {
    return Boolean(
      window.pywebview &&
        window.pywebview.api &&
        typeof window.pywebview.api.save_file === "function" &&
        typeof window.pywebview.api.save_zip === "function"
    );
  }

  function flashButtonSaved(btn, labelEl, fallbackText) {
    const target = labelEl || (btn ? btn.querySelector("span") : null);
    if (!target) return;
    const originalText = fallbackText || target.textContent;
    if (btn && btn._savedTimer) {
      clearTimeout(btn._savedTimer);
    }
    target.textContent = "Saved!";
    if (btn) {
      btn._savedTimer = setTimeout(() => {
        if (target.isConnected) {
          target.textContent = originalText;
        }
        btn._savedTimer = null;
      }, 2000);
    }
  }

  function triggerBrowserDownload(url, filename) {
    const a = document.createElement("a");
    a.href = url;
    if (filename) a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function downloadSingleItem(item, triggerBtn = null) {
    if (!item || !item.result || !item.result.job_id) return;
    const resData = item.result;

    if (!hasPywebviewBridge()) {
      triggerBrowserDownload(resData.download_url, resData.output_filename);
      return;
    }

    if (triggerBtn) triggerBtn.disabled = true;
    try {
      const result = await window.pywebview.api.save_file(resData.job_id);
      if (result && result.status === "saved") {
        flashButtonSaved(triggerBtn, null, "Download");
      } else if (result && result.status === "error") {
        showToast(result.detail || "Failed to save PDF", true);
      }
    } catch (err) {
      showToast((err && err.message) || "Failed to save PDF", true);
    } finally {
      if (triggerBtn) triggerBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Presets & Custom Panel Controller
  // ---------------------------------------------------------------------------
  function syncSettingsUI() {
    const s = state.settings;

    // Presets active highlight
    dom.presetPills.forEach((btn) => {
      const p = btn.getAttribute("data-preset");
      btn.classList.toggle("active", state.preset === p);
    });

    // Custom controls
    dom.sliderQuality.value = s.image_quality;
    dom.qualityReadout.textContent = `${s.image_quality}%`;

    dom.dpiPills.forEach((pill) => {
      const val = parseInt(pill.getAttribute("data-dpi"), 10);
      pill.classList.toggle("active", val === s.target_dpi);
    });
    dom.dpiReadout.textContent = s.target_dpi === 0 ? "Orig" : `${s.target_dpi} DPI`;

    dom.toggleRecompressImages.checked = s.recompress_images;
    dom.toggleGrayscale.checked = s.grayscale;
    dom.toggleLosslessOptimize.checked = s.lossless_optimize;
    dom.toggleSubsetFonts.checked = s.subset_fonts;
    dom.toggleStripMetadata.checked = s.strip_metadata;

    // Dirty state
    const hasItems = state.items.length > 0;
    dom.settingsDirtyPill.classList.toggle("hidden", !(hasItems && state.settingsDirty));
    dom.recompressAllBtn.classList.toggle("hidden", !(hasItems && state.settingsDirty));
  }

  function markCustomModified() {
    state.preset = "custom";
    if (state.items.length > 0) {
      state.settingsDirty = true;
    }
    syncSettingsUI();
  }

  // Toggle Custom Panel
  dom.customToggleBtn.addEventListener("click", () => {
    state.customPanelOpen = !state.customPanelOpen;
    dom.customPanel.hidden = !state.customPanelOpen;
    dom.customToggleBtn.classList.toggle("open", state.customPanelOpen);
    dom.customToggleBtn.setAttribute("aria-expanded", String(state.customPanelOpen));
  });

  // Preset tab clicks
  dom.presetPills.forEach((btn) => {
    btn.addEventListener("click", () => {
      const presetKey = btn.getAttribute("data-preset");
      const profile = PRESET_PROFILES[presetKey];
      if (!profile) return;

      state.preset = presetKey;
      state.settings = { ...profile };
      if (state.items.length > 0) {
        state.settingsDirty = true;
      }
      syncSettingsUI();
    });
  });

  // Sliders and Checkboxes
  dom.sliderQuality.addEventListener("input", (e) => {
    state.settings.image_quality = parseInt(e.target.value, 10);
    dom.qualityReadout.textContent = `${state.settings.image_quality}%`;
    markCustomModified();
  });

  dom.dpiPills.forEach((pill) => {
    pill.addEventListener("click", () => {
      state.settings.target_dpi = parseInt(pill.getAttribute("data-dpi"), 10);
      markCustomModified();
    });
  });

  dom.toggleRecompressImages.addEventListener("change", (e) => {
    state.settings.recompress_images = e.target.checked;
    markCustomModified();
  });

  dom.toggleGrayscale.addEventListener("change", (e) => {
    state.settings.grayscale = e.target.checked;
    markCustomModified();
  });

  dom.toggleLosslessOptimize.addEventListener("change", (e) => {
    state.settings.lossless_optimize = e.target.checked;
    markCustomModified();
  });

  dom.toggleSubsetFonts.addEventListener("change", (e) => {
    state.settings.subset_fonts = e.target.checked;
    markCustomModified();
  });

  dom.toggleStripMetadata.addEventListener("change", (e) => {
    state.settings.strip_metadata = e.target.checked;
    markCustomModified();
  });

  dom.recompressAllBtn.addEventListener("click", () => {
    recompressAllItems();
  });

  // ---------------------------------------------------------------------------
  // Dropzone & File Handling
  // ---------------------------------------------------------------------------
  dom.dropzone.addEventListener("click", () => dom.fileInput.click());

  dom.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      dom.fileInput.click();
    }
  });

  dom.fileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(Array.from(e.target.files));
      dom.fileInput.value = "";
    }
  });

  ["dragenter", "dragover"].forEach((evt) => {
    dom.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dom.dropzone.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach((evt) => {
    dom.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dom.dropzone.classList.remove("drag-over");
    });
  });

  dom.dropzone.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length > 0) {
      handleFiles(Array.from(dt.files));
    }
  });

  function handleFiles(fileArray) {
    const pdfFiles = fileArray.filter(
      (f) => f.name.toLowerCase().endsWith(".pdf") || f.type === "application/pdf"
    );

    if (pdfFiles.length === 0) {
      showToast("Please select valid .pdf files.", true);
      return;
    }

    const newItems = pdfFiles.map((file) => ({
      id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      file,
      status: "processing",
      analysis: null,
      result: null,
      error: null,
    }));

    state.items = [...newItems, ...state.items];
    renderFileList();
    syncSettingsUI();

    newItems.forEach((item) => processSingleItem(item, true));
  }

  // ---------------------------------------------------------------------------
  // Compression Execution
  // ---------------------------------------------------------------------------
  async function processSingleItem(item, runAnalysis = false) {
    item.status = "processing";
    item.error = null;
    updateCardDOM(item);
    updateBottomSummary();

    try {
      const s = state.settings;
      const compressForm = new FormData();
      compressForm.append("file", item.file);
      compressForm.append("preset", state.preset);
      compressForm.append("image_quality", String(s.image_quality));
      compressForm.append("target_dpi", String(s.target_dpi));
      compressForm.append("recompress_images", String(s.recompress_images));
      compressForm.append("lossless_optimize", String(s.lossless_optimize));
      compressForm.append("strip_metadata", String(s.strip_metadata));
      compressForm.append("subset_fonts", String(s.subset_fonts));
      compressForm.append("grayscale", String(s.grayscale));

      const tasks = [
        fetch("/api/compress", {
          method: "POST",
          body: compressForm,
        }),
      ];

      if (runAnalysis || !item.analysis) {
        const analyzeForm = new FormData();
        analyzeForm.append("file", item.file);
        tasks.push(
          fetch("/api/analyze", {
            method: "POST",
            body: analyzeForm,
          })
        );
      }

      const responses = await Promise.all(tasks);
      const compressRes = responses[0];
      if (!compressRes.ok) {
        const errBody = await compressRes.json().catch(() => ({}));
        throw new Error(errBody.detail || `Compression failed (${compressRes.status})`);
      }

      item.result = await compressRes.json();

      if (responses[1] && responses[1].ok) {
        item.analysis = await responses[1].json();
      }

      item.status = "done";
    } catch (err) {
      item.status = "error";
      item.error = err.message || "Failed to process PDF";
      showToast(`${item.file.name}: ${item.error}`, true);
    }

    updateCardDOM(item);
    updateBottomSummary();

    if (state.inspector.open && state.inspector.itemId === item.id && item.result) {
      loadInspectorItem(item.id, state.inspector.page);
    }
  }

  async function recompressAllItems() {
    if (state.items.length === 0) return;
    state.settingsDirty = false;
    syncSettingsUI();

    await Promise.all(
      state.items.map((item) => processSingleItem(item, false))
    );
    showToast(`Re-compressed ${state.items.length} file(s).`);
  }

  // ---------------------------------------------------------------------------
  // File Cards & Queue Rendering (Linear Single-Column Card Design)
  // ---------------------------------------------------------------------------
  function buildCardInnerHtml(item) {
    const filename = escapeHtml(item.file.name);
    const origBytes = item.result ? item.result.original_size : item.file.size;

    if (item.status === "processing") {
      return `
        <div class="file-info-col">
          <div class="file-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
          </div>
          <div class="file-titles">
            <div class="file-name" title="${filename}">${filename}</div>
            <div class="file-meta mono">${formatBytes(origBytes)}</div>
          </div>
        </div>
        <div class="processing-state">
          <div class="spinner"></div>
          <span>Compressing...</span>
        </div>
      `;
    }

    if (item.status === "error") {
      return `
        <div class="file-info-col">
          <div class="file-icon" style="color: var(--accent-danger);">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <div class="file-titles">
            <div class="file-name" title="${filename}">${filename}</div>
            <div class="error-msg">${escapeHtml(item.error)}</div>
          </div>
        </div>
        <div class="file-actions-col">
          <button type="button" class="btn btn-secondary btn-sm" data-action="retry" data-id="${item.id}">Retry</button>
          <button type="button" class="btn-icon-subtle remove-btn" data-action="remove" data-id="${item.id}" title="Remove file">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      `;
    }

    // Done state
    const res = item.result;
    const ana = item.analysis;
    const pageCount = res.page_count || (ana && ana.page_count) || 1;
    const elapsedSec = (res.elapsed_ms / 1000).toFixed(1);
    const reductionPct = res.reduction_percent.toFixed(0);
    const isMinimal = res.reduction_percent < 1.0;

    return `
      <div class="file-info-col">
        <div class="file-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
        </div>
        <div class="file-titles">
          <div class="file-name" title="${filename}">${filename}</div>
          <div class="file-meta mono">${pageCount} ${pageCount === 1 ? "page" : "pages"} · ${elapsedSec}s</div>
        </div>
      </div>

      <div class="file-telemetry-col">
        <div class="size-transition mono">
          <span class="size-orig">${formatBytes(res.original_size)}</span>
          <span class="size-arrow">→</span>
          <span class="size-comp">${formatBytes(res.compressed_size)}</span>
        </div>
        <span class="reduction-badge mono ${isMinimal ? "minimal" : ""}">
          ${res.saved_bytes > 0 ? `-${reductionPct}%` : "Optimal"}
        </span>
      </div>

      <div class="file-actions-col">
        <button type="button" class="btn btn-secondary btn-sm" data-action="inspect" data-id="${item.id}" title="Inspect quality proofing">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          <span>View</span>
        </button>

        <button type="button" class="btn btn-primary btn-sm" data-action="download" data-id="${item.id}" title="Download compressed PDF">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span>Download</span>
        </button>

        <button type="button" class="btn-icon-subtle remove-btn" data-action="remove" data-id="${item.id}" title="Remove file">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    `;
  }

  function updateCardDOM(item) {
    const card = document.getElementById(`card-${item.id}`);
    if (!card) return;
    card.className = `file-card status-${item.status}`;
    card.innerHTML = buildCardInnerHtml(item);
  }

  function renderFileList() {
    dom.fileList.innerHTML = "";
    state.items.forEach((item) => {
      const card = document.createElement("div");
      card.id = `card-${item.id}`;
      card.className = `file-card status-${item.status}`;
      card.innerHTML = buildCardInnerHtml(item);
      dom.fileList.appendChild(card);
    });
    updateBottomSummary();
  }

  function removeSingleItem(itemId) {
    state.items = state.items.filter((it) => it.id !== itemId);
    const cardEl = document.getElementById(`card-${itemId}`);
    if (cardEl) cardEl.remove();
    updateBottomSummary();
    syncSettingsUI();
  }

  // Delegated clicks on file list
  dom.fileList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const itemId = btn.getAttribute("data-id");
    const item = state.items.find((it) => it.id === itemId);
    if (!item) return;

    if (action === "remove") {
      removeSingleItem(itemId);
    } else if (action === "retry") {
      processSingleItem(item, true);
    } else if (action === "inspect") {
      openInspectorModal(itemId);
    } else if (action === "download") {
      downloadSingleItem(item, btn);
    }
  });

  // ---------------------------------------------------------------------------
  // Bottom Action Bar & Summary
  // ---------------------------------------------------------------------------
  function updateBottomSummary() {
    const totalCount = state.items.length;
    dom.bottomBar.classList.toggle("hidden", totalCount === 0);

    const doneItems = state.items.filter((it) => it.status === "done" && it.result);
    const totalSaved = doneItems.reduce((acc, it) => acc + (it.result.saved_bytes || 0), 0);
    const totalOrig = doneItems.reduce((acc, it) => acc + (it.result.original_size || 0), 0);
    const avgReduction = totalOrig > 0 ? (totalSaved / totalOrig) * 100 : 0;

    dom.summaryStat.textContent = `${totalCount} ${totalCount === 1 ? "file" : "files"} • ${formatBytes(totalSaved)} saved (${avgReduction.toFixed(0)}%)`;

    // Download ZIP button visibility
    const canZip = doneItems.length >= 2;
    dom.downloadZipBtn.classList.toggle("hidden", !canZip);
    if (canZip) {
      dom.downloadZipLabel.textContent = `Download All (${doneItems.length} PDFs .ZIP)`;
    }
  }

  dom.clearQueueBtn.addEventListener("click", () => {
    state.items = [];
    state.settingsDirty = false;
    renderFileList();
    syncSettingsUI();
  });

  dom.downloadZipBtn.addEventListener("click", async () => {
    const completedJobIds = state.items
      .filter((it) => it.status === "done" && it.result && it.result.job_id)
      .map((it) => it.result.job_id);

    if (completedJobIds.length === 0) return;

    if (dom.downloadZipBtn._savedTimer) {
      clearTimeout(dom.downloadZipBtn._savedTimer);
      dom.downloadZipBtn._savedTimer = null;
    }

    const origLabel = `Download All (${completedJobIds.length} PDFs .ZIP)`;
    dom.downloadZipBtn.disabled = true;
    dom.downloadZipLabel.textContent = "Packaging ZIP...";

    try {
      if (hasPywebviewBridge()) {
        const result = await window.pywebview.api.save_zip(completedJobIds);
        if (result && result.status === "saved") {
          dom.downloadZipBtn.disabled = false;
          flashButtonSaved(dom.downloadZipBtn, dom.downloadZipLabel, origLabel);
          return;
        }
        if (result && result.status === "error") {
          showToast(result.detail || "ZIP save failed", true);
        }
        dom.downloadZipLabel.textContent = origLabel;
      } else {
        const res = await fetch("/api/download-zip", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ job_ids: completedJobIds }),
        });

        if (!res.ok) throw new Error("Failed to build batch ZIP archive");

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        triggerBrowserDownload(url, "pressdf_batch.zip");
        URL.revokeObjectURL(url);
        dom.downloadZipLabel.textContent = origLabel;
      }
    } catch (err) {
      showToast((err && err.message) || "ZIP download failed", true);
      dom.downloadZipLabel.textContent = origLabel;
    } finally {
      dom.downloadZipBtn.disabled = false;
    }
  });

  // ---------------------------------------------------------------------------
  // Interactive Quality Inspector Modal
  // ---------------------------------------------------------------------------
  function openInspectorModal(itemId) {
    const item = state.items.find((it) => it.id === itemId);
    if (!item || !item.result) return;

    state.inspector.open = true;
    state.inspector.itemId = itemId;
    state.inspector.page = 1;
    state.inspector.pageCount = Math.max(1, item.result.page_count || 1);
    state.inspector.flipShowingOriginal = false;

    dom.inspectorModal.classList.remove("hidden");
    loadInspectorItem(itemId, 1);
  }

  function closeInspectorModal() {
    state.inspector.open = false;
    state.inspector.itemId = null;
    dom.inspectorModal.classList.add("hidden");
  }

  function loadInspectorItem(itemId, pageNumber) {
    const item = state.items.find((it) => it.id === itemId);
    if (!item || !item.result) return;

    const res = item.result;
    state.inspector.page = Math.min(Math.max(1, pageNumber), state.inspector.pageCount);

    dom.inspectorTitle.textContent = item.file.name;
    dom.inspectorTelemetryPill.textContent = `${formatBytes(res.original_size)} → ${formatBytes(res.compressed_size)} (-${res.reduction_percent.toFixed(0)}%)`;
    dom.paneOriginalSize.textContent = formatBytes(res.original_size);
    dom.paneCompressedSize.textContent = `${formatBytes(res.compressed_size)} (-${res.reduction_percent.toFixed(0)}%)`;

    if (dom.inspectorDownloadBtn._savedTimer) {
      clearTimeout(dom.inspectorDownloadBtn._savedTimer);
      dom.inspectorDownloadBtn._savedTimer = null;
    }
    const inspectorDlLabel = dom.inspectorDownloadBtn.querySelector("span");
    if (inspectorDlLabel) inspectorDlLabel.textContent = "Download";

    dom.pageIndicator.textContent = `Page ${state.inspector.page} / ${state.inspector.pageCount}`;
    dom.prevPageBtn.disabled = state.inspector.page <= 1;
    dom.nextPageBtn.disabled = state.inspector.page >= state.inspector.pageCount;

    const renderDpi = state.inspector.zoom >= 200 ? 200 : state.inspector.zoom >= 150 ? 160 : 130;
    const cacheBuster = `${res.job_id}_p${state.inspector.page}_d${renderDpi}`;

    dom.loaderOriginal.classList.remove("hidden");
    dom.loaderCompressed.classList.remove("hidden");

    const origUrl = `/api/preview/${encodeURIComponent(res.job_id)}?page=${state.inspector.page}&version=original&dpi=${renderDpi}&_=${cacheBuster}`;
    const compUrl = `/api/preview/${encodeURIComponent(res.job_id)}?page=${state.inspector.page}&version=compressed&dpi=${renderDpi}&_=${cacheBuster}`;

    dom.imgOriginal.onload = () => {
      dom.loaderOriginal.classList.add("hidden");
      applyZoomWidth();
    };
    dom.imgCompressed.onload = () => {
      dom.loaderCompressed.classList.add("hidden");
      applyZoomWidth();
    };

    dom.imgOriginal.src = origUrl;
    dom.imgCompressed.src = compUrl;

    syncInspectorViewMode();
  }

  function applyZoomWidth() {
    const zoomFactor = state.inspector.zoom / 100;
    const baseWidth = 520;
    const targetPx = Math.round(baseWidth * zoomFactor);

    dom.imgOriginal.style.width = `${targetPx}px`;
    dom.imgOriginal.style.maxWidth = "none";
    dom.imgCompressed.style.width = `${targetPx}px`;
    dom.imgCompressed.style.maxWidth = "none";
  }

  function syncInspectorViewMode() {
    const isSplit = state.inspector.viewMode === "split";
    dom.viewModeSplitBtn.classList.toggle("active", isSplit);
    dom.viewModeFlipBtn.classList.toggle("active", !isSplit);
    dom.inspectorStage.classList.toggle("mode-flip", !isSplit);
    dom.flipModeBanner.classList.toggle("hidden", isSplit);

    if (isSplit) {
      dom.paneOriginal.classList.remove("hidden");
      dom.paneCompressed.classList.remove("hidden");
    } else {
      const showOrig = state.inspector.flipShowingOriginal;
      dom.paneOriginal.classList.toggle("hidden", !showOrig);
      dom.paneCompressed.classList.toggle("hidden", showOrig);
      dom.flipStateLabel.textContent = showOrig
        ? "VIEWING: ORIGINAL"
        : "VIEWING: COMPRESSED";
    }
  }

  dom.closeInspectorBtn.addEventListener("click", closeInspectorModal);
  dom.inspectorDownloadBtn.addEventListener("click", () => {
    const item = state.items.find((it) => it.id === state.inspector.itemId);
    if (item) {
      downloadSingleItem(item, dom.inspectorDownloadBtn);
    }
  });
  dom.inspectorModal.addEventListener("click", (e) => {
    if (e.target === dom.inspectorModal) closeInspectorModal();
  });

  dom.prevPageBtn.addEventListener("click", () => {
    if (state.inspector.page > 1) {
      loadInspectorItem(state.inspector.itemId, state.inspector.page - 1);
    }
  });

  dom.nextPageBtn.addEventListener("click", () => {
    if (state.inspector.page < state.inspector.pageCount) {
      loadInspectorItem(state.inspector.itemId, state.inspector.page + 1);
    }
  });

  dom.viewModeSplitBtn.addEventListener("click", () => {
    state.inspector.viewMode = "split";
    syncInspectorViewMode();
  });

  dom.viewModeFlipBtn.addEventListener("click", () => {
    state.inspector.viewMode = "flip";
    state.inspector.flipShowingOriginal = false;
    syncInspectorViewMode();
  });

  dom.flipToggleBtn.addEventListener("click", () => {
    state.inspector.flipShowingOriginal = !state.inspector.flipShowingOriginal;
    syncInspectorViewMode();
  });

  dom.zoomBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const z = parseInt(btn.getAttribute("data-zoom"), 10);
      state.inspector.zoom = z;
      dom.zoomBtns.forEach((b) => b.classList.toggle("active", b === btn));
      loadInspectorItem(state.inspector.itemId, state.inspector.page);
    });
  });

  // Synchronized scroll between panes
  let isSyncing = false;
  dom.scrollOriginal.addEventListener("scroll", () => {
    if (isSyncing) return;
    isSyncing = true;
    dom.scrollCompressed.scrollTop = dom.scrollOriginal.scrollTop;
    dom.scrollCompressed.scrollLeft = dom.scrollOriginal.scrollLeft;
    requestAnimationFrame(() => (isSyncing = false));
  });

  dom.scrollCompressed.addEventListener("scroll", () => {
    if (isSyncing) return;
    isSyncing = true;
    dom.scrollOriginal.scrollTop = dom.scrollCompressed.scrollTop;
    dom.scrollOriginal.scrollLeft = dom.scrollCompressed.scrollLeft;
    requestAnimationFrame(() => (isSyncing = false));
  });

  // Keyboard Shortcuts in Inspector
  window.addEventListener("keydown", (e) => {
    if (!state.inspector.open) return;

    if (e.key === "Escape") {
      e.preventDefault();
      closeInspectorModal();
    } else if (e.key === "ArrowLeft" && state.inspector.page > 1) {
      e.preventDefault();
      loadInspectorItem(state.inspector.itemId, state.inspector.page - 1);
    } else if (e.key === "ArrowRight" && state.inspector.page < state.inspector.pageCount) {
      e.preventDefault();
      loadInspectorItem(state.inspector.itemId, state.inspector.page + 1);
    } else if (e.code === "Space" && state.inspector.viewMode === "flip") {
      e.preventDefault();
      state.inspector.flipShowingOriginal = !state.inspector.flipShowingOriginal;
      syncInspectorViewMode();
    }
  });

  // ---------------------------------------------------------------------------
  // Initialize App
  // ---------------------------------------------------------------------------
  syncSettingsUI();
  renderFileList();
})();
