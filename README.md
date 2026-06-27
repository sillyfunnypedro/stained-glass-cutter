# Stained Glass Cutter

A 100% client-side React + TypeScript app. Upload a line drawing; it produces an
image where the enclosed "glass piece" cells are filled solid black and the lines
between them (plus the surrounding area) are transparent. Tune it with sliders and
save the result to your photos.

No server, no upload — all image processing runs in your browser (in a Web Worker).

## Run

```bash
npm install
npm run dev      # http://localhost:5173
```

## Build

```bash
npm run build    # type-checks, then bundles to dist/
npm run preview  # serve the production build locally
```

The build is static (`dist/`) and can be hosted on any static host (Netlify,
GitHub Pages, etc.). Asset paths are relative, so it also works from a subfolder.

## How it works

`src/processing.ts` is a TypeScript port of the original Python pipeline:

1. **Line mask** — pixels darker than the threshold are treated as lines.
2. **Despeckle** — drop tiny noise blobs.
3. **Skeletonize** (Zhang-Suen) — reduce strokes to 1px centerlines.
4. **Prune spurs** — trim stray dead-end branches.
5. **Dilate** — regrow lines to a uniform width.
6. **Gaussian smooth** — round off the pixel staircase.
7. **Flood fill from the border** — separate the outside from the enclosed
   cells; fill the cells black, leave everything else transparent.

`src/worker.ts` runs this off the main thread. `src/App.tsx` handles upload,
the live preview (on a transparency checkerboard), the sliders, and saving.

## Saving to Photos

The Save button uses the Web Share API when available (on iOS/Android this
offers **Save Image** straight to Photos). On desktop it falls back to a normal
PNG download.

## Notes

- Large uploads are downscaled to ~1400px on the long edge before processing so
  slider tweaks re-render in about a second.
- EXIF orientation is respected on import.
- Sliders: line thickness, detection sensitivity, smoothing, and spur cleanup.
