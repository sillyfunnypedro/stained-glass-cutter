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
import type {
  NumberPosition,
  NumberPositionsRequest,
  NumberPositionsResponse,
  PngRequest,
  SvgRequest,
  SvgVariant,
  WorkerResponse,
} from "./worker";

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

// Cricut ignores SVG <text> on import, so the numbers layer must be real vector
// geometry. We draw each digit with a 7-segment stroke font.
const SEG: Record<string, [[number, number], [number, number]]> = {
  a: [[0, 0], [1, 0]],
  b: [[1, 0], [1, 1]],
  c: [[1, 1], [1, 2]],
  d: [[0, 2], [1, 2]],
  e: [[0, 1], [0, 2]],
  f: [[0, 0], [0, 1]],
  g: [[0, 1], [1, 1]],
};
const DIGIT_SEGS: Record<string, string[]> = {
  "0": ["a", "b", "c", "d", "e", "f"],
  "1": ["b", "c"],
  "2": ["a", "b", "g", "e", "d"],
  "3": ["a", "b", "g", "c", "d"],
  "4": ["f", "g", "b", "c"],
  "5": ["a", "f", "g", "c", "d"],
  "6": ["a", "f", "g", "e", "d", "c"],
  "7": ["a", "b", "c"],
  "8": ["a", "b", "c", "d", "e", "f", "g"],
  "9": ["a", "b", "c", "d", "f", "g"],
};

/** SVG path data for a number centered at (cx, cy) with digit height `size`. */
function numberSegmentPath(label: number, cx: number, cy: number, size: number): string {
  const str = String(label);
  const digitH = size;
  const digitW = size * 0.55;
  const gap = size * 0.25;
  const total = str.length * digitW + (str.length - 1) * gap;
  const x0 = cx - total / 2;
  const y0 = cy - digitH / 2;
  const out: string[] = [];
  for (let i = 0; i < str.length; i++) {
    const dx = x0 + i * (digitW + gap);
    for (const s of DIGIT_SEGS[str[i]] ?? []) {
      const [p, q] = SEG[s];
      const ax = dx + p[0] * digitW;
      const ay = y0 + (p[1] / 2) * digitH;
      const bx = dx + q[0] * digitW;
      const by = y0 + (q[1] / 2) * digitH;
      out.push(`M ${ax.toFixed(1)},${ay.toFixed(1)} L ${bx.toFixed(1)},${by.toFixed(1)}`);
    }
  }
  return out.join(" ");
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
  const [numberSize, setNumberSize] = useState(28);
  const [numPositions, setNumPositions] = useState<NumberPosition[] | null>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const overlayRef = useRef<SVGSVGElement | null>(null);

  const paramsRef = useRef(params);
  paramsRef.current = params;
  const fileRef = useRef<File | null>(null);
  const sourceRef = useRef<ImageData | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0); // latest live-preview (png) request
  const svgIdRef = useRef(0);
  const svgPending = useRef(new Map<number, (svg: string) => void>());
  const numPosPending = useRef(new Map<number, (p: NumberPosition[]) => void>());

  // Spin up the processing worker once.
  useEffect(() => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.kind === "svg") {
        const resolve = svgPending.current.get(msg.id);
        if (resolve) { svgPending.current.delete(msg.id); resolve(msg.svg); }
        return;
      }
      if (msg.kind === "number-positions") {
        const resolve = numPosPending.current.get(msg.id);
        if (resolve) { numPosPending.current.delete(msg.id); resolve((msg as NumberPositionsResponse).positions); }
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

  const requestNumberPositions = useCallback(
    () =>
      new Promise<NumberPosition[]>((resolve, reject) => {
        const worker = workerRef.current;
        const src = sourceRef.current;
        if (!worker || !src) { reject(new Error("no image")); return; }
        const id = ++svgIdRef.current;
        numPosPending.current.set(id, resolve);
        const copy = src.data.slice();
        const req: NumberPositionsRequest = {
          kind: "number-positions",
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

  // Compute positions once when the overlay is first turned on, then leave them
  // put — changing a parameter must not move (or reset) the numbers. Toggle the
  // overlay off/on to re-place them from scratch.
  useEffect(() => {
    if (!showNumbers || !hasResult || numPositions) return;
    const t = setTimeout(async () => {
      try {
        setNumPositions(await requestNumberPositions());
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(t);
  }, [showNumbers, hasResult, numPositions, requestNumberPositions]);

  // Clear positions when the overlay is hidden.
  useEffect(() => {
    if (!showNumbers) setNumPositions(null);
  }, [showNumbers]);

  // Drag positions in SVG coordinate space.
  useEffect(() => {
    if (draggingIdx === null) return;
    const svg = overlayRef.current;
    if (!svg) return;
    const move = (e: MouseEvent | TouchEvent) => {
      e.preventDefault();
      const client = "touches" in e ? (e as TouchEvent).touches[0] : (e as MouseEvent);
      const pt = svg.createSVGPoint();
      pt.x = client.clientX;
      pt.y = client.clientY;
      const svgPt = pt.matrixTransform(svg.getScreenCTM()!.inverse());
      setNumPositions((prev) =>
        prev ? prev.map((p, i) => (i === draggingIdx ? { ...p, x: svgPt.x, y: svgPt.y } : p)) : prev,
      );
    };
    const up = () => setDraggingIdx(null);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
    };
  }, [draggingIdx]);

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
          variant === "cells" ? "pieces" : variant === "lines-outline" ? "lines-outline" : "lines";
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

  const saveNumbersSvg = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSvgBusy(true);
    try {
      // Use current dragged positions if the preview is open, otherwise fetch fresh.
      const positions = numPositions ?? await requestNumberPositions();
      const { w, h } = { w: canvas.width, h: canvas.height };
      // Real vector strokes (Cricut ignores <text>). One <path> per number so
      // each is its own object; set them to "Draw"/Pen or "Cut" in Cricut.
      const strokeW = Math.max(1, Math.round(numberSize * 0.12));
      const paths = positions.map(
        ({ x, y, label }) =>
          `  <path d="${numberSegmentPath(label, x, y, numberSize)}"/>`,
      );
      const svg =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n` +
        `  <g fill="none" stroke="#000000" stroke-width="${strokeW}" ` +
        `stroke-linecap="round" stroke-linejoin="round">\n` +
        paths.join("\n") +
        `\n  </g>\n</svg>\n`;
      const blob = new Blob([svg], { type: "image/svg+xml" });
      await deliver(blob, `${baseName}-numbers.svg`);
    } catch {
      setError("Could not create the SVG.");
    } finally {
      setSvgBusy(false);
    }
  }, [numPositions, requestNumberPositions, deliver, baseName, numberSize]);

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
                {numPositions && (() => {
                  const canvas = canvasRef.current;
                  const svgW = canvas?.width ?? 0;
                  const svgH = canvas?.height ?? 0;
                  return (
                    <svg
                      ref={overlayRef}
                      viewBox={`0 0 ${svgW} ${svgH}`}
                      style={{
                        position: "absolute",
                        inset: 0,
                        width: "100%",
                        height: "100%",
                        cursor: draggingIdx !== null ? "grabbing" : "default",
                        overflow: "visible",
                      }}
                    >
                      {numPositions.map((pos, i) => {
                        // Same 7-segment geometry as the export, so the preview
                        // matches what Cricut receives. A transparent box gives
                        // an easy drag target around the thin strokes.
                        const str = String(pos.label);
                        const digitW = numberSize * 0.55;
                        const gap = numberSize * 0.25;
                        const boxW = str.length * digitW + (str.length - 1) * gap;
                        const pad = numberSize * 0.3;
                        return (
                          <g
                            key={pos.label}
                            style={{ cursor: "grab" }}
                            onMouseDown={(e) => { e.preventDefault(); setDraggingIdx(i); }}
                            onTouchStart={(e) => { e.preventDefault(); setDraggingIdx(i); }}
                          >
                            <rect
                              x={pos.x - boxW / 2 - pad}
                              y={pos.y - numberSize / 2 - pad}
                              width={boxW + pad * 2}
                              height={numberSize + pad * 2}
                              fill="transparent"
                            />
                            <path
                              d={numberSegmentPath(pos.label, pos.x, pos.y, numberSize)}
                              fill="none"
                              stroke={params.mode === "cells" ? "#ffffff" : "#000000"}
                              strokeWidth={Math.max(1, numberSize * 0.12)}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              style={{ pointerEvents: "none" }}
                            />
                          </g>
                        );
                      })}
                    </svg>
                  );
                })()}
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

            {hasResult && (
              <label className="reso">
                <input
                  type="checkbox"
                  checked={showNumbers}
                  onChange={(e) => setShowNumbers(e.target.checked)}
                  disabled={busy}
                />
                <span>
                  Preview numbers
                  <small>overlay piece numbers on the preview</small>
                </span>
              </label>
            )}

            {hasResult && showNumbers && (
              <div className="control">
                <label>
                  Number size
                  <span className="val">{numberSize}</span>
                </label>
                <input
                  type="range"
                  min={10}
                  max={90}
                  step={1}
                  value={numberSize}
                  onChange={(e) => setNumberSize(Number(e.target.value))}
                />
              </div>
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
                <button onClick={() => saveSvg("cells")} disabled={!hasResult || busy || svgBusy}>
                  {svgBusy ? "Working…" : "SVG · glass pieces (Cricut)"}
                </button>
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

              {/* Numbers layer works from the enclosed regions, so it's
                  available in both modes. */}
              <button onClick={saveNumbersSvg} disabled={!hasResult || busy || svgBusy}>
                {svgBusy ? "Working…" : "SVG · numbers layer (Cricut)"}
              </button>

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
