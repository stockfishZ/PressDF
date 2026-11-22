/**
 * PressDF — Pure-JS Client-Side PDF Compression Engine
 * Uses pdf-lib + HTML5 Canvas + DecompressionStream for 100% browser-local optimization.
 */

(() => {
  "use strict";

  const getPDFLib = () => {
    if (!window.PDFLib) {
      throw new Error("PDFLib failed to load from vendor/pdf-lib.min.js");
    }
    return window.PDFLib;
  };

  /**
   * Resolve a PDFNumber safely from a dictionary entry.
   */
  function getDictNumber(dict, keyName) {
    const { PDFName, PDFNumber } = getPDFLib();
    const val = dict.lookup(PDFName.of(keyName));
    if (val instanceof PDFNumber || (val && typeof val.asNumber === "function")) {
      return val.asNumber();
    }
    return null;
  }

  /**
   * Check whether a ColorSpace object is an unsafe/indexed/special color space.
   * Returns { name, skip, channels }.
   */
  function inspectColorSpace(dict) {
    const { PDFName, PDFArray } = getPDFLib();
    const cs = dict.lookup(PDFName.of("ColorSpace"));
    if (!cs) {
      return { name: "Unknown", skip: false, channels: null };
    }

    let primaryName = null;
    if (cs instanceof PDFName) {
      primaryName = cs.decodeText();
    } else if (cs instanceof PDFArray && cs.size() > 0) {
      const first = cs.lookup(0);
      if (first instanceof PDFName) {
        primaryName = first.decodeText();
      }
    }

    if (!primaryName) {
      return { name: "Unknown", skip: true, channels: null };
    }

    if (
      primaryName === "Indexed" ||
      primaryName === "Pattern" ||
      primaryName === "Separation" ||
      primaryName === "DeviceN"
    ) {
      return { name: primaryName, skip: true, channels: null };
    }

    if (primaryName === "DeviceRGB") {
      return { name: "DeviceRGB", skip: false, channels: 3 };
    }
    if (primaryName === "DeviceGray") {
      return { name: "DeviceGray", skip: false, channels: 1 };
    }
    if (primaryName === "DeviceCMYK") {
      return { name: "DeviceCMYK", skip: false, channels: 4 };
    }

    return { name: primaryName, skip: false, channels: null };
  }

  /**
   * Extract single filter name if simple single-filter stream.
   */
  function getSingleFilterName(dict) {
    const { PDFName, PDFArray } = getPDFLib();
    const filter = dict.lookup(PDFName.of("Filter"));
    if (!filter) return null;
    if (filter instanceof PDFName) {
      return filter.decodeText();
    }
    if (filter instanceof PDFArray) {
      if (filter.size() === 1) {
        const first = filter.lookup(0);
        if (first instanceof PDFName) {
          return first.decodeText();
        }
      }
      return "MULTIPLE";
    }
    return null;
  }

  /**
   * Check whether /DecodeParms uses a PNG/TIFF predictor (> 1).
   */
  function hasNonTrivialPredictor(dict) {
    const { PDFName, PDFDict, PDFArray } = getPDFLib();
    const dp = dict.lookup(PDFName.of("DecodeParms"));
    if (!dp) return false;

    const checkDict = (d) => {
      if (!(d instanceof PDFDict)) return false;
      const pred = getDictNumber(d, "Predictor");
      return pred !== null && pred > 1;
    };

    if (dp instanceof PDFDict) return checkDict(dp);
    if (dp instanceof PDFArray) {
      for (let i = 0; i < dp.size(); i++) {
        if (checkDict(dp.lookup(i))) return true;
      }
    }
    return false;
  }

  /**
   * Decompress zlib-wrapped FlateDecode bytes via browser DecompressionStream.
   */
  async function inflateFlateBytes(bytes) {
    if (typeof DecompressionStream !== "undefined") {
      try {
        const ds = new DecompressionStream("deflate");
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        const ab = await new Response(stream).arrayBuffer();
        return new Uint8Array(ab);
      } catch (_err) {
        // Fallback to raw deflate or pdf-lib decode if non-standard zlib header
      }
    }
    throw new Error("Flate decompression failed");
  }

  /**
   * Multiply two 2D affine PDF transformation matrices [a, b, c, d, e, f].
   */
  function multiplyMatrix(m1, m2) {
    return [
      m1[0] * m2[0] + m1[1] * m2[2],
      m1[0] * m2[1] + m1[1] * m2[3],
      m1[2] * m2[0] + m1[3] * m2[2],
      m1[2] * m2[1] + m1[3] * m2[3],
      m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
      m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
    ];
  }

  /**
   * Best-effort scan of page content streams to estimate placed point sizes (1pt = 1/72in)
   * for direct image XObject placements.
   */
  function buildImagePlacementMap(pdfDoc) {
    const { PDFName, PDFDict, PDFRef, PDFArray, PDFRawStream, decodePDFRawStream } = getPDFLib();
    const map = new Map(); // ref.tag -> { w, h }

    try {
      const pages = pdfDoc.getPages();
      for (const page of pages) {
        const resources = page.node.lookup(PDFName.of("Resources"));
        if (!(resources instanceof PDFDict)) continue;
        const xobjects = resources.lookup(PDFName.of("XObject"));
        if (!(xobjects instanceof PDFDict)) continue;

        const nameToRefTag = new Map();
        for (const [k, v] of xobjects.entries()) {
          if (k instanceof PDFName && v instanceof PDFRef) {
            nameToRefTag.set(k.decodeText(), v.tag);
          }
        }
        if (nameToRefTag.size === 0) continue;

        const contents = page.node.lookup(PDFName.of("Contents"));
        const contentStreams = [];
        if (contents instanceof PDFRawStream) {
          contentStreams.push(contents);
        } else if (contents instanceof PDFArray) {
          for (let i = 0; i < contents.size(); i++) {
            const s = contents.lookup(i);
            if (s instanceof PDFRawStream) contentStreams.push(s);
          }
        }
        if (contentStreams.length === 0) continue;

        let combinedText = "";
        for (const cs of contentStreams) {
          try {
            const decoded = decodePDFRawStream(cs).decode();
            combinedText += "\n" + new TextDecoder("latin1").decode(decoded);
          } catch (_e) {
            // Skip unreadable content stream
          }
        }
        if (!combinedText) continue;

        const tokens = combinedText.match(/\/[^\s\[\]()<>\/%]+|[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z*']+/g);
        if (!tokens) continue;

        const stack = [];
        let ctm = [1, 0, 0, 1, 0, 0];
        const numStack = [];
        let lastName = null;

        for (let i = 0; i < tokens.length; i++) {
          const tok = tokens[i];
          if (tok === "q") {
            stack.push([...ctm]);
            numStack.length = 0;
            lastName = null;
          } else if (tok === "Q") {
            ctm = stack.length > 0 ? stack.pop() : [1, 0, 0, 1, 0, 0];
            numStack.length = 0;
            lastName = null;
          } else if (tok === "cm") {
            if (numStack.length >= 6) {
              const f = numStack.pop();
              const e = numStack.pop();
              const d = numStack.pop();
              const c = numStack.pop();
              const b = numStack.pop();
              const a = numStack.pop();
              ctm = multiplyMatrix([a, b, c, d, e, f], ctm);
            }
            numStack.length = 0;
            lastName = null;
          } else if (tok === "Do") {
            if (lastName && nameToRefTag.has(lastName)) {
              const tag = nameToRefTag.get(lastName);
              const ptsW = Math.hypot(ctm[0], ctm[1]);
              const ptsH = Math.hypot(ctm[2], ctm[3]);
              if (ptsW >= 36 && ptsH >= 36) {
                const prev = map.get(tag);
                if (!prev || ptsW * ptsH > prev.w * prev.h) {
                  map.set(tag, { w: ptsW, h: ptsH });
                }
              }
            }
            numStack.length = 0;
            lastName = null;
          } else if (tok.startsWith("/")) {
            lastName = tok.slice(1);
          } else {
            const n = Number(tok);
            if (!Number.isNaN(n)) {
              numStack.push(n);
              if (numStack.length > 12) numStack.shift();
            } else {
              numStack.length = 0;
              lastName = null;
            }
          }
        }
      }
    } catch (_err) {
      // Best-effort placement extraction; ignore parse issues
    }

    return map;
  }

  /**
   * Compute target pixel dimensions given targetDpi and optional placed point dimensions.
   */
  function computeTargetDimensions(origW, origH, targetDpi, placedPts) {
    if (!targetDpi || targetDpi <= 0) {
      return { targetW: origW, targetH: origH, downsampled: false };
    }

    let scale = 1;
    const maxPx = Math.round(targetDpi * 11);

    if (placedPts && placedPts.w >= 36 && placedPts.h >= 36) {
      const effDpiW = origW / (placedPts.w / 72);
      const effDpiH = origH / (placedPts.h / 72);
      const effDpi = Math.max(effDpiW, effDpiH);
      if (effDpi > targetDpi * 1.1) {
        scale = Math.min(scale, targetDpi / effDpi);
      }
    } else {
      const maxDim = Math.max(origW, origH);
      if (maxDim > maxPx * 1.1) {
        scale = Math.min(scale, maxPx / maxDim);
      }
    }

    if (scale >= 1) {
      return { targetW: origW, targetH: origH, downsampled: false };
    }

    const targetW = Math.max(32, Math.round(origW * scale));
    const targetH = Math.max(32, Math.round(origH * scale));
    const downsampled = targetW < origW || targetH < origH;
    return { targetW, targetH, downsampled };
  }

  /**
   * Convert canvas contents to grayscale in-place via luminance weights.
   */
  function applyGrayscaleToCanvas(ctx, width, height) {
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const y = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      data[i] = y;
      data[i + 1] = y;
      data[i + 2] = y;
    }
    ctx.putImageData(imgData, 0, 0);
  }

  /**
   * Encode an HTMLCanvasElement as JPEG Uint8Array.
   */
  function canvasToJpegBytes(canvas, qualityPct) {
    const q = Math.min(0.98, Math.max(0.05, qualityPct / 100));
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Canvas JPEG encoding failed"));
            return;
          }
          blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject);
        },
        "image/jpeg",
        q
      );
    });
  }

  /**
   * Re-encode an ImageBitmap onto a canvas (optionally resized & grayscaled) as JPEG.
   */
  async function reencodeBitmapAsJpeg(bitmap, targetW, targetH, imageQuality, grayscale) {
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas context unavailable");

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);

    if (grayscale) {
      applyGrayscaleToCanvas(ctx, targetW, targetH);
    }

    return canvasToJpegBytes(canvas, imageQuality);
  }

  /**
   * Fast PDF Analyzer: returns page count, byte size, embedded image count, and metadata presence.
   */
  async function analyzePdf(arrayBuffer) {
    const { PDFDocument, PDFRawStream, PDFName } = getPDFLib();
    const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });

    let imagesCount = 0;
    const subtypeKey = PDFName.of("Subtype");
    const imageName = PDFName.of("Image");

    for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && obj.dict.lookup(subtypeKey) === imageName) {
        imagesCount++;
      }
    }

    const hasMetadata = Boolean(
      pdfDoc.catalog.has(PDFName.of("Metadata")) ||
        pdfDoc.getTitle() ||
        pdfDoc.getAuthor() ||
        pdfDoc.getSubject() ||
        pdfDoc.getKeywords() ||
        pdfDoc.getProducer() ||
        pdfDoc.getCreator()
    );

    return {
      pageCount: pdfDoc.getPageCount(),
      originalSize: bytes.byteLength,
      imagesCount,
      hasMetadata,
    };
  }

  /**
   * Compress a PDF entirely in-browser.
   * Options: { recompressImages, imageQuality, targetDpi, grayscale, losslessOptimize, stripMetadata }
   */
  async function compressPdf(arrayBuffer, options = {}) {
    const t0 = performance.now();
    const { PDFDocument, PDFRawStream, PDFName, PDFNumber, PDFBool } = getPDFLib();

    const originalBytes =
      arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);

    const opts = {
      recompressImages: options.recompressImages !== false,
      imageQuality: Number.isFinite(options.imageQuality) ? options.imageQuality : 75,
      targetDpi: Number.isFinite(options.targetDpi) ? options.targetDpi : 150,
      grayscale: Boolean(options.grayscale),
      losslessOptimize: options.losslessOptimize !== false,
      stripMetadata: options.stripMetadata !== false,
    };

    const pdfDoc = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
    const pageCount = pdfDoc.getPageCount();

    const subtypeKey = PDFName.of("Subtype");
    const imageName = PDFName.of("Image");
    const imageMaskKey = PDFName.of("ImageMask");
    const sMaskKey = PDFName.of("SMask");
    const maskKey = PDFName.of("Mask");
    const filterKey = PDFName.of("Filter");
    const widthKey = PDFName.of("Width");
    const heightKey = PDFName.of("Height");
    const bpcKey = PDFName.of("BitsPerComponent");
    const csKey = PDFName.of("ColorSpace");
    const lengthKey = PDFName.of("Length");
    const decodeParmsKey = PDFName.of("DecodeParms");
    const decodeKey = PDFName.of("Decode");
    const dctName = PDFName.of("DCTDecode");
    const deviceRgbName = PDFName.of("DeviceRGB");

    const placementMap = opts.recompressImages && opts.targetDpi > 0
      ? buildImagePlacementMap(pdfDoc)
      : new Map();

    let imagesFound = 0;
    let imagesRecompressed = 0;
    let imagesDownsampled = 0;

    for (const [ref, obj] of pdfDoc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      const dict = obj.dict;
      if (dict.lookup(subtypeKey) !== imageName) continue;

      imagesFound++;

      if (!opts.recompressImages) continue;

      // Skip 1-bit / stencil masks and masked/alpha images to preserve crisp transparency
      const imgMask = dict.lookup(imageMaskKey);
      if (imgMask === PDFBool.True || (imgMask && typeof imgMask.asBoolean === "function" && imgMask.asBoolean())) {
        continue;
      }
      if (dict.has(sMaskKey) || dict.has(maskKey)) {
        continue;
      }

      const csInfo = inspectColorSpace(dict);
      if (csInfo.skip) {
        continue;
      }

      const width = getDictNumber(dict, "Width");
      const height = getDictNumber(dict, "Height");
      const origImgBytes = obj.contents;

      if (!width || !height || width <= 32 || height <= 32 || !origImgBytes || origImgBytes.length <= 2048) {
        continue;
      }

      const filterName = getSingleFilterName(dict);
      if (filterName !== "DCTDecode" && filterName !== "FlateDecode") {
        continue;
      }

      const placedPts = placementMap.get(ref.tag) || null;
      const { targetW, targetH, downsampled } = computeTargetDimensions(
        width,
        height,
        opts.targetDpi,
        placedPts
      );

      if (filterName === "DCTDecode") {
        // Skip DeviceCMYK JPEGs to avoid browser RGB/CMYK channel inversion
        if (csInfo.name === "DeviceCMYK") continue;

        let bitmap = null;
        try {
          const blob = new Blob([origImgBytes], { type: "image/jpeg" });
          bitmap = await createImageBitmap(blob);
          const newBytes = await reencodeBitmapAsJpeg(
            bitmap,
            targetW,
            targetH,
            opts.imageQuality,
            opts.grayscale
          );

          // Strict per-image size guard
          if (newBytes.length > 0 && newBytes.length < origImgBytes.length) {
            obj.contents = newBytes;
            dict.set(filterKey, dctName);
            dict.set(widthKey, PDFNumber.of(targetW));
            dict.set(heightKey, PDFNumber.of(targetH));
            dict.set(csKey, deviceRgbName);
            dict.set(bpcKey, PDFNumber.of(8));
            dict.set(lengthKey, PDFNumber.of(newBytes.length));
            dict.delete(decodeParmsKey);
            dict.delete(decodeKey);

            imagesRecompressed++;
            if (downsampled) imagesDownsampled++;
          }
        } catch (_err) {
          // Keep original JPEG untouched on decode/encode error
        } finally {
          if (bitmap && typeof bitmap.close === "function") bitmap.close();
        }
      } else if (filterName === "FlateDecode") {
        const bpc = getDictNumber(dict, "BitsPerComponent");
        if (bpc !== 8) continue;
        if (csInfo.name !== "DeviceRGB" && csInfo.name !== "DeviceGray") continue;
        if (hasNonTrivialPredictor(dict)) continue;

        const channels = csInfo.channels;
        const expectedLen = width * height * channels;

        let bitmap = null;
        try {
          const rawPixels = await inflateFlateBytes(origImgBytes);
          if (rawPixels.length !== expectedLen) continue;

          const rgba = new Uint8ClampedArray(width * height * 4);
          if (channels === 3) {
            for (let src = 0, dst = 0; src < rawPixels.length; src += 3, dst += 4) {
              rgba[dst] = rawPixels[src];
              rgba[dst + 1] = rawPixels[src + 1];
              rgba[dst + 2] = rawPixels[src + 2];
              rgba[dst + 3] = 255;
            }
          } else {
            for (let src = 0, dst = 0; src < rawPixels.length; src++, dst += 4) {
              const g = rawPixels[src];
              rgba[dst] = g;
              rgba[dst + 1] = g;
              rgba[dst + 2] = g;
              rgba[dst + 3] = 255;
            }
          }

          const imageData = new ImageData(rgba, width, height);
          bitmap = await createImageBitmap(imageData);
          const newBytes = await reencodeBitmapAsJpeg(
            bitmap,
            targetW,
            targetH,
            opts.imageQuality,
            opts.grayscale
          );

          // Strict per-image size guard
          if (newBytes.length > 0 && newBytes.length < origImgBytes.length) {
            obj.contents = newBytes;
            dict.set(filterKey, dctName);
            dict.set(widthKey, PDFNumber.of(targetW));
            dict.set(heightKey, PDFNumber.of(targetH));
            dict.set(csKey, deviceRgbName);
            dict.set(bpcKey, PDFNumber.of(8));
            dict.set(lengthKey, PDFNumber.of(newBytes.length));
            dict.delete(decodeParmsKey);
            dict.delete(decodeKey);

            imagesRecompressed++;
            if (downsampled) imagesDownsampled++;
          }
        } catch (_err) {
          // Keep original FlateDecode image untouched on error
        } finally {
          if (bitmap && typeof bitmap.close === "function") bitmap.close();
        }
      }
    }

    if (opts.stripMetadata) {
      pdfDoc.setTitle("");
      pdfDoc.setAuthor("");
      pdfDoc.setSubject("");
      pdfDoc.setKeywords([]);
      pdfDoc.setProducer("");
      pdfDoc.setCreator("");
      pdfDoc.catalog.delete(PDFName.of("Metadata"));
      delete pdfDoc.context.trailerInfo.Info;
    }

    const savedPdfBytes = await pdfDoc.save({
      useObjectStreams: Boolean(opts.losslessOptimize),
      addDefaultPage: false,
      updateFieldAppearances: false,
    });

    // Zero-inflation guarantee: never return a larger PDF than the input
    const outputBytes =
      savedPdfBytes.length >= originalBytes.length ? originalBytes : savedPdfBytes;

    const originalSize = originalBytes.length;
    const compressedSize = outputBytes.length;
    const savedBytes = Math.max(0, originalSize - compressedSize);
    const reductionPercent = originalSize > 0 ? (savedBytes / originalSize) * 100 : 0;
    const elapsedMs = Math.max(1, Math.round(performance.now() - t0));

    return {
      outputBytes,
      originalSize,
      compressedSize,
      savedBytes,
      reductionPercent,
      elapsedMs,
      pageCount,
      imagesFound,
      imagesRecompressed,
      imagesDownsampled,
    };
  }

  window.PressDFCompressor = {
    analyzePdf,
    compressPdf,
  };
})();
