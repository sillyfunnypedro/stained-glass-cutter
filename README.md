# Stained Glass Cutter

**Turn a line drawing into a clean, cut-ready image — right in your browser.**

👉 **Live app: https://sillyfunnypedro.github.io/stained-glass-cutter/**

## What it's for

If you have a stained-glass-style pattern or any line drawing (a photo of a
sketch, an exported template, etc.), this app converts it into an image where:

- the **enclosed cells** — the individual "glass pieces" — are filled **solid black**, and
- the **lines between the pieces** and the **area outside the design** are **transparent**.

That makes it easy to drop into a cutting workflow (e.g. a Cricut) or to use as a
clean stencil/silhouette. When you like the result, save it straight to your
photos.

Everything runs **100% in your browser** — your image is never uploaded to a
server.

## How to use it

1. Open the [app](https://sillyfunnypedro.github.io/stained-glass-cutter/).
2. Tap to choose a photo (or drag an image in).
3. Adjust the sliders until it looks right:
   - **Line thickness** — width of the transparent gap between pieces.
   - **Detection sensitivity** — how dark a pixel must be to count as a line.
   - **Smoothing** — rounds off jagged edges.
   - **Spur cleanup** — trims stray little stubs at line junctions.
4. Press **Save to Photos**. On a phone this opens the share sheet with
   *Save Image* (saves straight to Photos); on desktop it downloads a PNG.

The output is a transparent PNG, so it composites cleanly over any background.

## How it works

`src/processing.ts` is a TypeScript image pipeline:

1. **Line mask** — pixels darker than the threshold are treated as lines.
2. **Despeckle** — drop tiny noise blobs.
3. **Skeletonize** (Zhang-Suen) — reduce strokes to 1px centerlines.
4. **Prune spurs** — trim stray dead-end branches.
5. **Dilate** — regrow lines to a uniform width.
6. **Gaussian smooth** — round off the pixel staircase.
7. **Flood fill from the border** — separate the outside from the enclosed
   cells, then fill the cells black and leave everything else transparent.

`src/worker.ts` runs this in a Web Worker so the UI stays responsive, and
`src/App.tsx` handles upload, the live preview, the sliders, and saving.

## Develop / build

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # type-checks, then bundles to dist/
npm run preview  # serve the production build locally
```

Pushing to `main` auto-deploys to GitHub Pages via the workflow in
`.github/workflows/deploy.yml`.

## License

Released under [**CC0 1.0 Universal**](./LICENSE) (public domain dedication).
Do whatever you like with it — no permission needed. **Attribution is
appreciated if you feel like it, but not required.**

## Notes

- Large uploads are downscaled to ~1400px on the long edge before processing so
  slider tweaks re-render in about a second.
- EXIF orientation is respected on import.
