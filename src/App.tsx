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
  MAX_PROCESS_DIM,
  type Params,
} from "./processing";
import type { WorkerRequest, WorkerResponse } from "./worker";

/** Decode a File, fix EXIF orientation, downscale, and return its pixels. */
async function fileToImageData(file: File): Promise<ImageData> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_PROCESS_DIM / Math.max(bitmap.width, bitmap.height));
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

  const sourceRef = useRef<ImageData | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);

  // Spin up the processing worker once.
  useEffect(() => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const { id, buffer, width, height } = e.data;
      if (id !== reqIdRef.current) return; // a newer request superseded this one
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d")!;
        ctx.clearRect(0, 0, width, height);
        ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0);
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
    const req: WorkerRequest = {
      id,
      buffer: copy.buffer,
      width: src.width,
      height: src.height,
      params: p,
    };
    worker.postMessage(req, [copy.buffer]);
  }, []);

  // Debounced reprocess whenever params change (and we have an image).
  useEffect(() => {
    if (!sourceRef.current) return;
    const t = setTimeout(() => run(sourceRef.current!, params), 180);
    return () => clearTimeout(t);
  }, [params, run]);

  const loadFile = useCallback(
    async (file: File) => {
      setError(null);
      if (!file.type.startsWith("image/")) {
        setError("Please choose an image file.");
        return;
      }
      try {
        setBusy(true);
        const imageData = await fileToImageData(file);
        sourceRef.current = imageData;
        setFileName(file.name);
        run(imageData, params);
      } catch (err) {
        console.error(err);
        setError("Could not read that image.");
        setBusy(false);
      }
    },
    [params, run],
  );

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

  const save = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!blob) return;
    const base = (fileName?.replace(/\.[^.]+$/, "") || "stained-glass") + "-cut.png";
    const file = new File([blob], base, { type: "image/png" });

    // On phones this offers "Save Image" straight to Photos; desktop falls back
    // to a normal download.
    const nav = navigator as Navigator & {
      canShare?: (d: ShareData) => boolean;
    };
    if (nav.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Stained glass cut" });
        return;
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = base;
    a.click();
    URL.revokeObjectURL(url);
  }, [fileName]);

  const set = <K extends keyof Params>(key: K) => (e: ChangeEvent<HTMLInputElement>) =>
    setParams((p) => ({ ...p, [key]: Number(e.target.value) }));

  const reset = () => setParams(DEFAULT_PARAMS);

  const sliders = useMemo(
    () => [
      { key: "lineWidth" as const, label: "Line thickness", min: 2, max: 30, step: 1, value: params.lineWidth },
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
            <span>or drag an image here</span>
          </div>
        </label>
      ) : (
        <div className="workspace">
          <div className="stage">
            <div className="checker">
              <canvas ref={canvasRef} className="result" />
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

            <div className="buttons">
              <button className="primary" onClick={save} disabled={!hasResult || busy}>
                Save to Photos
              </button>
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
    </div>
  );
}
