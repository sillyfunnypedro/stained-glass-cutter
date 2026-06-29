import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  DEFAULT_PARAMS,
  PROCESS_DIM,
  type Params,
} from "./processing";
import type { PngRequest, SvgRequest, SvgVariant, WorkerResponse } from "./worker";

/** Decode a File, fix EXIF orientation, downscale to maxDim, and return pixels. */
async function fileToImageData(file: File, maxDim: number): Promise<ImageData> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return ctx.getImageData(0, 0, w, h);
}

export default function App() {
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [busy, setBusy] = useState(false);
  const [hasResult, setHasResult] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [highRes, setHighRes] = useState(false);
  const [showNumbers, setShowNumbers] = useState(false);
  const [numbersUrl, setNumbersUrl] = useState<string | null>(null);
  const numbersUrlRef = useRef<string | null>(null);

  const paramsRef = useRef(params);
  paramsRef.current = params;
  const fileRef = useRef<File | null>(null);
  const sourceRef = useRef<ImageData | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0); // latest live-preview (png) request
  const svgIdRef = useRef(0);
  const svgPending = useRef(new Map<number, (svg: string) => void>());

  // Spin up the processing worker once.
  useEffect(() => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.kind === "svg") {
        const resolve = svgPending.current.get(msg.id);
        if (resolve) {
          svgPending.current.delete(msg.id);
          resolve(msg.svg);
        }
        return;
      }
      if (msg.id !== reqIdRef.current) return; // a newer request superseded this one
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = msg.width;
        canvas.height = msg.height;
        const ctx = canvas.getContext("2d")!;
        ctx.clearRect(0, 0, msg.width, msg.height);
        ctx.putImageData(
          new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height),
          0,
          0,
        );
      }
      setHasResult(true);
      setBusy(false);
    };
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  const run = useCallback((src: ImageData, p: Params) => {
    const worker = workerRef.current;
    if (!worker) return;
    setBusy(true);
    const id = ++reqIdRef.current;
    // Copy the buffer so the source survives transfer (we reprocess on every tweak).
    const copy = src.data.slice();
    const req: PngRequest = {
      kind: "png",
      id,
      buffer: copy.buffer,
      width: src.width,
      height: src.height,
      params: p,
    };
    worker.postMessage(req, [copy.buffer]);
  }, []);

  // Ask the worker to vectorize the current image into an SVG string.
  const requestSvg = useCallback(
    (variant: SvgVariant) =>
      new Promise<string>((resolve, reject) => {
        const worker = workerRef.current;
        const src = sourceRef.current;
        if (!worker || !src) {
          reject(new Error("no image"));
          return;
        }
        const id = ++svgIdRef.current;
        svgPending.current.set(id, resolve);
        const copy = src.data.slice();
        const req: SvgRequest = {
          kind: "svg",
          variant,
          id,
          buffer: copy.buffer,
          width: src.width,
          height: src.height,
          params,
        };
        worker.postMessage(req, [copy.buffer]);
      }),
    [params],
  );

  // Debounced reprocess whenever params change (and we have an image).
  useEffect(() => {
    if (!sourceRef.current) return;
    const t = setTimeout(() => run(sourceRef.current!, params), 180);
    return () => clearTimeout(t);
  }, [params, run]);

  // Decode the stored file at the chosen resolution and kick off processing.
  const decodeAndRun = useCallback(
    async (file: File, hi: boolean) => {
      setError(null);
      try {
        setBusy(true);
        const maxDim = hi ? PROCESS_DIM.high : PROCESS_DIM.standard;
        const imageData = await fileToImageData(file, maxDim);
        sourceRef.current = imageData;
        run(imageData, paramsRef.current);
      } catch (err) {
        console.error(err);
        setError("Could not read that image.");
        setBusy(false);
      }
    },
    [run],
  );

  const loadFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        setError("Please choose an image file.");
        return;
      }
      fileRef.current = file;
      setFileName(file.name);
      await decodeAndRun(file, highRes);
    },
    [decodeAndRun, highRes],
  );

  // Accept a pasted image (⌘V / Ctrl+V) from anywhere on the page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const file = it.getAsFile();
          if (file) {
            e.preventDefault();
            void loadFile(file);
            return;
          }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [loadFile]);

  // Re-decode at the new resolution when the High-res toggle flips.
  const didMountRes = useRef(false);
  useEffect(() => {
    if (!didMountRes.current) {
      didMountRes.current = true;
      return;
    }
    if (fileRef.current) void decodeAndRun(fileRef.current, highRes);
  }, [highRes, decodeAndRun]);

  // Turn off numbers preview when leaving cells mode.
  useEffect(() => {
    if (params.mode !== "cells") setShowNumbers(false);
  }, [params.mode]);

  // Fetch/refresh the numbers overlay whenever the toggle is on and params change.
  useEffect(() => {
    if (!showNumbers || !hasResult) return;
    const t = setTimeout(async () => {
      try {
        const svg = await requestSvg("cells-numbers");
        const blob = new Blob([svg], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        if (numbersUrlRef.current) URL.revokeObjectURL(numbersUrlRef.current);
        numbersUrlRef.current = url;
        setNumbersUrl(url);
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(t);
  }, [showNumbers, hasResult, requestSvg]);

  // Clean up blob URL when the toggle is turned off.
  useEffect(() => {
    if (!showNumbers && numbersUrlRef.current) {
      URL.revokeObjectURL(numbersUrlRef.current);
      numbersUrlRef.current = null;
      setNumbersUrl(null);
    }
  }, [showNumbers]);

  const onFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void loadFile(file);
    e.target.value = "";
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void loadFile(file);
  };

  const baseName = useMemo(
    () => fileName?.replace(/\.[^.]+$/, "") || "stained-glass",
    [fileName],
  );

  // Hand a file to the OS: on touch devices the share sheet (Mail, Save to
  // Files, Cricut, Photos for PNG); on desktop a plain download. Desktop Chrome
  // on macOS can crash when sharing files, so share is gated to touch devices.
  const deliver = useCallback(async (blob: Blob, filename: string) => {
    const isMobile =
      typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (isMobile && nav.canShare) {
      const file = new File([blob], filename, { type: blob.type });
      if (nav.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: filename });
          return;
        } catch (err) {
          if ((err as DOMException)?.name === "AbortError") return;
          // otherwise fall through to a download
        }
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const savePng = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (blob) await deliver(blob, `${baseName}.png`);
  }, [deliver, baseName]);

  const [svgBusy, setSvgBusy] = useState(false);
  const saveSvg = useCallback(
    async (variant: SvgVariant) => {
      setSvgBusy(true);
      try {
        const svg = await requestSvg(variant);
        const suffix =
          variant === "cells" ? "pieces" :
          variant === "cells-numbers" ? "numbers" :
          variant === "lines-outline" ? "lines-outline" : "lines";
        const blob = new Blob([svg], { type: "image/svg+xml" });
        await deliver(blob, `${baseName}-${suffix}.svg`);
      } catch {
        setError("Could not create the SVG.");
      } finally {
        setSvgBusy(false);
      }
    },
    [requestSvg, deliver, baseName],
  );

  const set = <K extends keyof Params>(key: K) => (e: ChangeEvent<HTMLInputElement>) =>
    setParams((p) => ({ ...p, [key]: Number(e.target.value) }));

  const reset = () => setParams(DEFAULT_PARAMS);

  // On touch devices saving uses the share sheet; on desktop it downloads.
  const isMobile = useMemo(
    () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches,
    [],
  );
  const pngLabel = isMobile ? "Save / Email PNG" : "Download PNG";

  const sliders = useMemo(
    () => [
      { key: "lineWidth" as const, label: "Line thickness", min: 1, max: 30, step: 1, value: params.lineWidth },
      { key: "bgThresh" as const, label: "Detection sensitivity", min: 150, max: 250, step: 1, value: params.bgThresh },
      { key: "smoothSigma" as const, label: "Smoothing", min: 0, max: 5, step: 0.5, value: params.smoothSigma },
      { key: "pruneLen" as const, label: "Spur cleanup", min: 0, max: 40, step: 1, value: params.pruneLen },
    ],
    [params],
  );

  return (
    <div className="app">
      <header>
        <h1>Stained Glass Cutter</h1>
        <p className="sub">
          Upload a line drawing &rarr; get black glass-piece cells on a transparent
          background, ready to save.
        </p>
      </header>

      {!sourceRef.current && !busy ? (
        <label
          className={`dropzone${dragging ? " dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input type="file" accept="image/*" onChange={onFileInput} hidden />
          <div className="dz-inner">
            <div className="dz-icon">＋</div>
            <strong>Tap to choose a photo</strong>
            <span>or drag an image here · or paste (⌘V / Ctrl+V)</span>
          </div>
        </label>
      ) : (
        <div className="workspace">
          <div className="stage">
            <div className="checker">
              <div style={{ position: "relative", display: "flex", maxWidth: "100%" }}>
                <canvas ref={canvasRef} className="result" />
                {numbersUrl && (
                  <img
                    src={numbersUrl}
                    alt=""
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%",
                      pointerEvents: "none",
                    }}
                  />
                )}
              </div>
            </div>
            {busy && <div className="spinner" aria-label="Processing" />}
          </div>

          <div className="controls">
            <div className="modes" role="group" aria-label="Output style">
              <button
                className={params.mode === "cells" ? "active" : ""}
                onClick={() => setParams((p) => ({ ...p, mode: "cells" }))}
              >
                Glass pieces
              </button>
              <button
                className={params.mode === "lines" ? "active" : ""}
                onClick={() => setParams((p) => ({ ...p, mode: "lines" }))}
              >
                Line drawing
              </button>
            </div>

            {sliders.map((s) => (
              <div className="control" key={s.key}>
                <label>
                  {s.label}
                  <span className="val">{s.value}</span>
                </label>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={s.value}
                  onChange={set(s.key)}
                />
              </div>
            ))}

            {params.mode === "cells" && hasResult && (
              <label className="reso">
                <input
                  type="checkbox"
                  checked={showNumbers}
                  onChange={(e) => setShowNumbers(e.target.checked)}
                  disabled={busy}
                />
                <span>
                  Preview numbers
                  <small>overlay cell numbers on the preview</small>
                </span>
              </label>
            )}

            <label className="reso">
              <input
                type="checkbox"
                checked={highRes}
                onChange={(e) => setHighRes(e.target.checked)}
                disabled={busy}
              />
              <span>
                High resolution
                <small>cleaner, thinner gaps · slower</small>
              </span>
            </label>

            <div className="buttons">
              <button className="primary" onClick={savePng} disabled={!hasResult || busy}>
                {pngLabel}
              </button>

              {params.mode === "cells" ? (
                <>
                  <button onClick={() => saveSvg("cells")} disabled={!hasResult || busy || svgBusy}>
                    {svgBusy ? "Working…" : "SVG · glass pieces (Cricut)"}
                  </button>
                  <button onClick={() => saveSvg("cells-numbers")} disabled={!hasResult || busy || svgBusy}>
                    {svgBusy ? "Working…" : "SVG · numbers layer (Cricut)"}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => saveSvg("lines-centerline")}
                    disabled={!hasResult || busy || svgBusy}
                  >
                    {svgBusy ? "Working…" : "SVG · single line"}
                  </button>
                  <button
                    onClick={() => saveSvg("lines-outline")}
                    disabled={!hasResult || busy || svgBusy}
                  >
                    {svgBusy ? "Working…" : "SVG · outlined lines"}
                  </button>
                </>
              )}

              {isMobile && (
                <p className="hint">
                  Saving opens the share sheet — pick <strong>Mail</strong> to email it to
                  yourself, <strong>Save to Files</strong>, or send to Cricut. (SVGs can’t go
                  to the camera roll.)
                </p>
              )}

              <button onClick={reset} disabled={busy}>Reset</button>
              <label className="link-btn">
                New photo
                <input type="file" accept="image/*" onChange={onFileInput} hidden />
              </label>
            </div>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      <details className="about">
        <summary>About this app</summary>
        <div className="about-body">
          <p>
            Upload, drag, or paste a line drawing and this app turns it into a
            clean image you can save or cut. It finds the drawn lines, reduces
            each one to its centerline, rebuilds them at a uniform width, and
            then either fills the enclosed “glass piece” cells (Glass pieces
            mode) or draws the smoothed centerlines (Line drawing mode) — black
            on a transparent background. You can save a PNG or export an SVG for
            cutting machines like Cricut.
          </p>
          <p>
            Everything runs entirely in your browser — your image is never
            uploaded to a server.
          </p>
          <p className="warn">
            <strong>No guarantees.</strong> Results are provided strictly as-is
            and are <strong>in no way guaranteed</strong> to be accurate, usable,
            or suitable for any purpose. Always check the output yourself before
            cutting, printing, or relying on it.
          </p>
          <p>
            Free and open source under{" "}
            <a
              href="https://creativecommons.org/publicdomain/zero/1.0/"
              target="_blank"
              rel="noreferrer"
            >
              Creative Commons CC0 1.0
            </a>{" "}
            (public domain) — use it however you like; attribution appreciated
            but not required.{" "}
            <a
              href="https://github.com/sillyfunnypedro/stained-glass-cutter"
              target="_blank"
              rel="noreferrer"
            >
              View the source on GitHub
            </a>
            .
          </p>
        </div>
      </details>

      <footer className="build">
        build {__BUILD_ID__} · {__BUILD_TIME__} UTC
      </footer>
    </div>
  );
}
