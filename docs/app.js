/**
 * PressDF — Client-Side Browser Controller
 * 100% browser-local PDF compression, batch ZIP export, and pdf.js Before/After Inspector.
 */

(() => {
  "use strict";

  // Configure pdf.js worker
  if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  }

  // ---------------------------------------------------------------------------
  // Preset Definitions
  // ---------------------------------------------------------------------------
  const PRESET_PROFILES = {
    balanced: {
      label: "BALANCED",
      recompressImages: true,
      imageQuality: 75,
      targetDpi: 150,
      grayscale: false,
      losslessOptimize: true,
      stripMetadata: true,
    },
    extreme: {
      label: "MAXIMUM",
      recompressImages: true,
      imageQuality: 50,
      targetDpi: 96,
      grayscale: false,
      losslessOptimize: true,
      stripMetadata: true,
    },
    high_quality: {
      label: "HIGH QUALITY",
      recompressImages: true,
      imageQuality: 88,
      targetDpi: 250,
      grayscale: false,
      losslessOptimize: true,
      stripMetadata: false,
    },
    lossless: {
      label: "LOSSLESS",
      recompressImages: false,
      imageQuality: 95,
      targetDpi: 0,
      grayscale: false,
      losslessOptimize: true,
      stripMetadata: true,
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
    items: [], // { id, file, originalBytes, status, analysis, result, downloadUrl, outputFilename, error, pdfDocs }
    inspector: {
      open: false,
      itemId: null,
      page: 1,
      pageCount: 1,
      zoom: 100,
      viewMode: "split", // 'split' | 'flip'
      flipShowingOriginal: false,
      renderTasks: { original: null, compressed: null },
      renderSeq: 0,
    },
  };

  // ---------------------------------------------------------------------------
  // DOM Elements
  // ---------------------------------------------------------------------------
  const dom = {
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
    toggleStripMetadata: document.getElementById("toggleStripMetadata"),

    dropzone: document.getElementById("dropzone"),
    fileInput: document.getElementById("fileInput"),
    fileList: document.getElementById("fileList"),

    bottomBar: document.getElementById("bottomBar"),
    summaryStat: document.getElementById("summaryStat"),
    settingsDirtyPill: document.getElementById("settingsDirtyPill"),
    recompressAllBtn: document.getElementById("recompressAllBtn"),
    downloadZipBtn: document.getElementById("downloadZipBtn"),
    downloadZipLabel: document.getElementById("downloadZipLabel"),
    clearQueueBtn: document.getElementById("clearQueueBtn"),

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
    canvasOriginal: document.getElementById("canvasOriginal"),
    canvasCompressed: document.getElementById("canvasCompressed"),

    toastContainer: document.getElementById("toastContainer"),
  };

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  function formatBytes(bytes) {
    if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return "0 B";
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

  function buildOutputFilename(origName) {
    const idx = origName.toLowerCase().lastIndexOf(".pdf");
    if (idx > 0) {
      return `${origName.slice(0, idx)}_compressed.pdf`;
    }
    return `${origName}_compressed.pdf`;
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

  function cleanupItemResources(item) {
    if (item.downloadUrl) {
      URL.revokeObjectURL(item.downloadUrl);
      item.downloadUrl = null;
    }
    if (item.pdfDocs) {
      if (item.pdfDocs.original && typeof item.pdfDocs.original.destroy === "function") {
        item.pdfDocs.original.destroy().catch(() => {});
      }
      if (item.pdfDocs.compressed && typeof item.pdfDocs.compressed.destroy === "function") {
        item.pdfDocs.compressed.destroy().catch(() => {});
      }
      item.pdfDocs = null;
    }
  }

  function cleanupCompressedDocOnly(item) {
    if (item.downloadUrl) {
      URL.revokeObjectURL(item.downloadUrl);
      item.downloadUrl = null;
    }
    if (item.pdfDocs && item.pdfDocs.compressed) {
      if (typeof item.pdfDocs.compressed.destroy === "function") {
        item.pdfDocs.compressed.destroy().catch(() => {});
      }
      item.pdfDocs.compressed = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Presets & Advanced Options Controller
  // ---------------------------------------------------------------------------
  function syncSettingsUI() {
    const s = state.settings;

    dom.presetPills.forEach((btn) => {
      const p = btn.getAttribute("data-preset");
      btn.classList.toggle("active", state.preset === p);
    });

    dom.sliderQuality.value = s.imageQuality;
    dom.qualityReadout.textContent = `${s.imageQuality}%`;

    dom.dpiPills.forEach((pill) => {
      const val = parseInt(pill.getAttribute("data-dpi"), 10);
      pill.classList.toggle("active", val === s.targetDpi);
    });
    dom.dpiReadout.textContent = s.targetDpi === 0 ? "Orig" : `${s.targetDpi} DPI`;

    dom.toggleRecompressImages.checked = s.recompressImages;
    dom.toggleGrayscale.checked = s.grayscale;
    dom.toggleLosslessOptimize.checked = s.losslessOptimize;
    dom.toggleStripMetadata.checked = s.stripMetadata;

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

  dom.customToggleBtn.addEventListener("click", () => {
    state.customPanelOpen = !state.customPanelOpen;
    dom.customPanel.hidden = !state.customPanelOpen;
    dom.customToggleBtn.classList.toggle("open", state.customPanelOpen);
    dom.customToggleBtn.setAttribute("aria-expanded", String(state.customPanelOpen));
  });

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

  dom.sliderQuality.addEventListener("input", (e) => {
    state.settings.imageQuality = parseInt(e.target.value, 10);
    state.settings.recompressImages = true;
    dom.qualityReadout.textContent = `${state.settings.imageQuality}%`;
    markCustomModified();
  });

  dom.dpiPills.forEach((pill) => {
    pill.addEventListener("click", () => {
      state.settings.targetDpi = parseInt(pill.getAttribute("data-dpi"), 10);
      state.settings.recompressImages = true;
      markCustomModified();
    });
  });

  dom.toggleRecompressImages.addEventListener("change", (e) => {
    state.settings.recompressImages = e.target.checked;
    markCustomModified();
  });

  dom.toggleGrayscale.addEventListener("change", (e) => {
    state.settings.grayscale = e.target.checked;
    if (e.target.checked) state.settings.recompressImages = true;
    markCustomModified();
  });

  dom.toggleLosslessOptimize.addEventListener("change", (e) => {
    state.settings.losslessOptimize = e.target.checked;
    markCustomModified();
  });

  dom.toggleStripMetadata.addEventListener("change", (e) => {
    state.settings.stripMetadata = e.target.checked;
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
      originalBytes: null,
      status: "processing",
      analysis: null,
      result: null,
      downloadUrl: null,
      outputFilename: buildOutputFilename(file.name),
      error: null,
      pdfDocs: null,
    }));

    state.items = [...newItems, ...state.items];
    renderFileList();
    syncSettingsUI();

    newItems.forEach((item) => processSingleItem(item, true));
  }

  // ---------------------------------------------------------------------------
  // Compression Execution (100% Client-Side)
  // ---------------------------------------------------------------------------
  async function processSingleItem(item, runAnalysis = false) {
    item.status = "processing";
    item.error = null;
    cleanupCompressedDocOnly(item);
    updateCardDOM(item);
    updateBottomSummary();

    try {
      if (!item.originalBytes) {
        const ab = await item.file.arrayBuffer();
        item.originalBytes = new Uint8Array(ab);
      }

      if (runAnalysis || !item.analysis) {
        item.analysis = await window.PressDFCompressor.analyzePdf(item.originalBytes);
      }

      const result = await window.PressDFCompressor.compressPdf(
        item.originalBytes,
        state.settings
      );

      item.result = result;
      const blob = new Blob([result.outputBytes], { type: "application/pdf" });
      item.downloadUrl = URL.createObjectURL(blob);
      item.status = "done";
    } catch (err) {
      item.status = "error";
      item.error = (err && err.message) || "Failed to process PDF";
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

    for (const item of state.items) {
      await processSingleItem(item, false);
    }
    showToast(`Re-compressed ${state.items.length} file(s).`);
  }

  // ---------------------------------------------------------------------------
  // File Cards & Queue Rendering
  // ---------------------------------------------------------------------------
  function buildCardInnerHtml(item) {
    const filename = escapeHtml(item.file.name);
    const origBytes = item.result ? item.result.originalSize : item.file.size;

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
          <button type="button" class="btn-icon-subtle remove-btn" data-action="remove" data-id="${item.id}" title="Remove file" aria-label="Remove file">✕</button>
        </div>
      `;
    }

    const res = item.result;
    const ana = item.analysis;
    const pageCount = res.pageCount || (ana && ana.pageCount) || 1;
    const elapsedSec = (res.elapsedMs / 1000).toFixed(1);
    const reductionPct = res.reductionPercent.toFixed(0);
    const isMinimal = res.reductionPercent < 1.0;

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
          <span class="size-orig">${formatBytes(res.originalSize)}</span>
          <span class="size-arrow">→</span>
          <span class="size-comp">${formatBytes(res.compressedSize)}</span>
        </div>
        <span class="reduction-badge mono ${isMinimal ? "minimal" : ""}">
          ${res.savedBytes > 0 ? `-${reductionPct}%` : "Optimal"}
        </span>
      </div>

      <div class="file-actions-col">
        <button type="button" class="btn btn-secondary btn-sm" data-action="inspect" data-id="${item.id}" title="Inspect quality proofing">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          <span>View</span>
        </button>

        <a href="${item.downloadUrl}" download="${escapeHtml(item.outputFilename)}" class="btn btn-primary btn-sm" title="Download compressed PDF">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span>Download</span>
        </a>

        <button type="button" class="btn-icon-subtle remove-btn" data-action="remove" data-id="${item.id}" title="Remove file" aria-label="Remove file">✕</button>
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
    const item = state.items.find((it) => it.id === itemId);
    if (item) {
      cleanupItemResources(item);
    }
    if (state.inspector.open && state.inspector.itemId === itemId) {
      closeInspectorModal();
    }
    state.items = state.items.filter((it) => it.id !== itemId);
    const cardEl = document.getElementById(`card-${itemId}`);
    if (cardEl) cardEl.remove();
    updateBottomSummary();
    syncSettingsUI();
  }

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
    }
  });

  // ---------------------------------------------------------------------------
  // Bottom Action Bar & Batch ZIP Export (JSZip)
  // ---------------------------------------------------------------------------
  function updateBottomSummary() {
    const totalCount = state.items.length;
    dom.bottomBar.classList.toggle("hidden", totalCount === 0);

    const doneItems = state.items.filter((it) => it.status === "done" && it.result);
    const totalSaved = doneItems.reduce((acc, it) => acc + (it.result.savedBytes || 0), 0);
    const totalOrig = doneItems.reduce((acc, it) => acc + (it.result.originalSize || 0), 0);
    const avgReduction = totalOrig > 0 ? (totalSaved / totalOrig) * 100 : 0;

    dom.summaryStat.textContent = `${totalCount} ${totalCount === 1 ? "file" : "files"} · ${formatBytes(totalSaved)} saved (${avgReduction.toFixed(0)}%)`;

    const canZip = doneItems.length >= 1;
    dom.downloadZipBtn.classList.toggle("hidden", !canZip);
    if (canZip) {
      dom.downloadZipLabel.textContent =
        doneItems.length === 1
          ? "Download All (.ZIP)"
          : `Download All (${doneItems.length} .ZIP)`;
    }
  }

  dom.clearQueueBtn.addEventListener("click", () => {
    state.items.forEach(cleanupItemResources);
    state.items = [];
    state.settingsDirty = false;
    if (state.inspector.open) closeInspectorModal();
    renderFileList();
    syncSettingsUI();
  });

  dom.downloadZipBtn.addEventListener("click", async () => {
    const doneItems = state.items.filter((it) => it.status === "done" && it.result);
    if (doneItems.length === 0) return;

    if (!window.JSZip) {
      showToast("JSZip failed to load", true);
      return;
    }

    const origLabel = dom.downloadZipLabel.textContent;
    dom.downloadZipBtn.disabled = true;
    dom.downloadZipLabel.textContent = "Packaging ZIP...";

    try {
      const zip = new window.JSZip();
      const usedNames = new Set();

      for (const item of doneItems) {
        let name = item.outputFilename;
        if (usedNames.has(name)) {
          const dot = name.lastIndexOf(".");
          const base = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : "";
          let counter = 2;
          while (usedNames.has(`${base}_${counter}${ext}`)) counter++;
          name = `${base}_${counter}${ext}`;
        }
        usedNames.add(name);
        zip.file(name, item.result.outputBytes);
      }

      const zipBlob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "pressdf_batch.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      showToast((err && err.message) || "ZIP packaging failed", true);
    } finally {
      dom.downloadZipBtn.disabled = false;
      dom.downloadZipLabel.textContent = origLabel;
    }
  });

  // ---------------------------------------------------------------------------
  // Interactive Quality Inspector Modal (pdf.js Canvas Rendering)
  // ---------------------------------------------------------------------------
  async function ensurePdfDocs(item) {
    if (!window.pdfjsLib) {
      throw new Error("pdf.js library not loaded");
    }
    if (!item.pdfDocs) {
      item.pdfDocs = { original: null, compressed: null };
    }
    if (!item.pdfDocs.original) {
      const task = window.pdfjsLib.getDocument({ data: item.originalBytes.slice() });
      item.pdfDocs.original = await task.promise;
    }
    if (!item.pdfDocs.compressed) {
      const task = window.pdfjsLib.getDocument({ data: item.result.outputBytes.slice() });
      item.pdfDocs.compressed = await task.promise;
    }
    return item.pdfDocs;
  }

  async function renderPdfPageToCanvas(pdfDoc, pageNum, canvas, loaderEl, which, seq) {
    const existingTask = state.inspector.renderTasks[which];
    if (existingTask && typeof existingTask.cancel === "function") {
      try {
        existingTask.cancel();
      } catch (_e) {}
    }

    loaderEl.classList.remove("hidden");

    const page = await pdfDoc.getPage(pageNum);
    if (seq !== state.inspector.renderSeq || !state.inspector.open) return;

    const baseWidth = 520;
    const zoomFactor = state.inspector.zoom / 100;
    const targetCssWidth = Math.round(baseWidth * zoomFactor);

    const unscaledViewport = page.getViewport({ scale: 1 });
    const cssScale = targetCssWidth / unscaledViewport.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const renderViewport = page.getViewport({ scale: cssScale * dpr });
    const cssViewport = page.getViewport({ scale: cssScale });

    canvas.width = Math.max(1, Math.floor(renderViewport.width));
    canvas.height = Math.max(1, Math.floor(renderViewport.height));
    canvas.style.width = `${Math.floor(cssViewport.width)}px`;
    canvas.style.height = `${Math.floor(cssViewport.height)}px`;

    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const renderTask = page.render({
      canvasContext: ctx,
      viewport: renderViewport,
    });
    state.inspector.renderTasks[which] = renderTask;

    try {
      await renderTask.promise;
      if (seq === state.inspector.renderSeq) {
        loaderEl.classList.add("hidden");
      }
    } catch (err) {
      if (err && err.name === "RenderingCancelledException") {
        return;
      }
      loaderEl.classList.add("hidden");
      throw err;
    } finally {
      if (state.inspector.renderTasks[which] === renderTask) {
        state.inspector.renderTasks[which] = null;
      }
    }
  }

  function openInspectorModal(itemId) {
    const item = state.items.find((it) => it.id === itemId);
    if (!item || !item.result) return;

    state.inspector.open = true;
    state.inspector.itemId = itemId;
    state.inspector.page = 1;
    state.inspector.pageCount = Math.max(1, item.result.pageCount || 1);
    state.inspector.flipShowingOriginal = false;

    dom.inspectorModal.classList.remove("hidden");
    loadInspectorItem(itemId, 1);
  }

  function closeInspectorModal() {
    state.inspector.open = false;
    state.inspector.itemId = null;
    ["original", "compressed"].forEach((k) => {
      const t = state.inspector.renderTasks[k];
      if (t && typeof t.cancel === "function") {
        try { t.cancel(); } catch (_e) {}
      }
      state.inspector.renderTasks[k] = null;
    });
    dom.inspectorModal.classList.add("hidden");
  }

  async function loadInspectorItem(itemId, pageNumber) {
    const item = state.items.find((it) => it.id === itemId);
    if (!item || !item.result) return;

    const res = item.result;
    state.inspector.page = Math.min(Math.max(1, pageNumber), state.inspector.pageCount);
    const seq = ++state.inspector.renderSeq;

    dom.inspectorTitle.textContent = item.file.name;
    const redLabel = res.savedBytes > 0 ? `-${res.reductionPercent.toFixed(0)}%` : "Optimal";
    dom.inspectorTelemetryPill.textContent = `${formatBytes(res.originalSize)} → ${formatBytes(res.compressedSize)} (${redLabel})`;
    dom.paneOriginalSize.textContent = formatBytes(res.originalSize);
    dom.paneCompressedSize.textContent = `${formatBytes(res.compressedSize)} (${redLabel})`;

    dom.inspectorDownloadBtn.href = item.downloadUrl;
    dom.inspectorDownloadBtn.setAttribute("download", item.outputFilename);

    dom.pageIndicator.textContent = `Page ${state.inspector.page} / ${state.inspector.pageCount}`;
    dom.prevPageBtn.disabled = state.inspector.page <= 1;
    dom.nextPageBtn.disabled = state.inspector.page >= state.inspector.pageCount;

    syncInspectorViewMode();

    try {
      const docs = await ensurePdfDocs(item);
      if (seq !== state.inspector.renderSeq || !state.inspector.open) return;

      await Promise.all([
        renderPdfPageToCanvas(
          docs.original,
          state.inspector.page,
          dom.canvasOriginal,
          dom.loaderOriginal,
          "original",
          seq
        ),
        renderPdfPageToCanvas(
          docs.compressed,
          state.inspector.page,
          dom.canvasCompressed,
          dom.loaderCompressed,
          "compressed",
          seq
        ),
      ]);
    } catch (err) {
      if (seq === state.inspector.renderSeq) {
        dom.loaderOriginal.classList.add("hidden");
        dom.loaderCompressed.classList.add("hidden");
        showToast(`Preview failed: ${(err && err.message) || "Unable to render PDF"}`, true);
      }
    }
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

  // Keyboard shortcuts in Inspector
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
