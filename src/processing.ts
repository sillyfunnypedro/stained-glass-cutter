// Client-side port of the Python stained-glass pipeline.
//
// Input : an RGBA bitmap of a colored/dark line drawing on a light background.
// Output: an RGBA bitmap where the enclosed "glass piece" cells are filled
//         solid black, and the lines between cells + the surrounding area are
//         fully transparent.
//
// Pipeline: line mask -> despeckle -> skeletonize (Zhang-Suen) -> prune spurs
// -> dilate to uniform width -> gaussian smooth -> flood-fill from the border
// to separate the outside from the enclosed cells.

/**
 * Output style:
 *  - "cells": enclosed glass-piece regions filled black, lines transparent.
 *  - "lines": the smoothed skeleton drawn as black lines on transparent.
 */
export type Mode = "cells" | "lines";

export interface Params {
  /** Output style. */
  mode: Mode;
  /** Background brightness cutoff 0-255. Pixels darker than this are "line". */
  bgThresh: number;
  /** Uniform line width in pixels (the transparent gap between cells). */
  lineWidth: number;
  /** Gaussian smoothing strength; higher = smoother but rounds sharp corners. */
  smoothSigma: number;
  /** Max spur length (px) trimmed off the skeleton. */
  pruneLen: number;
  /** Drop connected line blobs smaller than this (px) as noise. */
  minBlob: number;
}

export const DEFAULT_PARAMS: Params = {
  mode: "cells",
  bgThresh: 230,
  lineWidth: 8,
  smoothSigma: 2,
  pruneLen: 15,
  minBlob: 20,
};

/** Longest side the pipeline runs at. Large uploads are downscaled to this. */
export const MAX_PROCESS_DIM = 1400;

// --------------------------------------------------------------------------- //
// 1. Line mask: a pixel is "line" if its darkest channel is below threshold.
// --------------------------------------------------------------------------- //
function lineMask(data: Uint8ClampedArray, n: number, bgThresh: number): Uint8Array {
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    mask[i] = min < bgThresh ? 1 : 0;
  }
  return mask;
}

// --------------------------------------------------------------------------- //
// 2. Despeckle: remove connected components (8-connected) smaller than minBlob.
// --------------------------------------------------------------------------- //
function despeckle(mask: Uint8Array, w: number, h: number, minBlob: number): void {
  const n = w * h;
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  const comp = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (!mask[start] || visited[start]) continue;
    let sp = 0;
    let cp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    while (sp > 0) {
      const p = stack[--sp];
      comp[cp++] = p;
      const x = p % w;
      const y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !visited[q]) {
            visited[q] = 1;
            stack[sp++] = q;
          }
        }
      }
    }
    if (cp < minBlob) {
      for (let k = 0; k < cp; k++) mask[comp[k]] = 0;
    }
  }
}

// --------------------------------------------------------------------------- //
// 3. Skeletonize (Zhang-Suen thinning) -> 1px centerlines.
// --------------------------------------------------------------------------- //
function skeletonize(src: Uint8Array, w: number, h: number): Uint8Array {
  const img = Uint8Array.from(src);
  const N = -w, S = w, E = 1, W2 = -1;
  const NE = -w + 1, SE = w + 1, SW = w - 1, NW = -w - 1;
  const toClear = new Int32Array(w * h);

  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      let count = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!img[i]) continue;
          const p2 = img[i + N], p3 = img[i + NE], p4 = img[i + E], p5 = img[i + SE];
          const p6 = img[i + S], p7 = img[i + SW], p8 = img[i + W2], p9 = img[i + NW];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          // count 0->1 transitions around the ring p2,p3,...,p9,p2
          let a = 0;
          if (p2 === 0 && p3 === 1) a++;
          if (p3 === 0 && p4 === 1) a++;
          if (p4 === 0 && p5 === 1) a++;
          if (p5 === 0 && p6 === 1) a++;
          if (p6 === 0 && p7 === 1) a++;
          if (p7 === 0 && p8 === 1) a++;
          if (p8 === 0 && p9 === 1) a++;
          if (p9 === 0 && p2 === 1) a++;
          if (a !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }
          toClear[count++] = i;
        }
      }
      if (count > 0) {
        for (let k = 0; k < count; k++) img[toClear[k]] = 0;
        changed = true;
      }
    }
  }
  return img;
}

// --------------------------------------------------------------------------- //
// 4. Prune spurs: repeatedly strip skeleton endpoints (1 neighbor) up to maxLen.
//    These designs are connected loops, so every endpoint is a stray spur.
// --------------------------------------------------------------------------- //
function pruneSpurs(img: Uint8Array, w: number, h: number, maxLen: number): void {
  if (maxLen <= 0) return;
  const ends = new Int32Array(w * h);
  for (let iter = 0; iter < maxLen; iter++) {
    let count = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!img[i]) continue;
        const nb =
          img[i - w] + img[i - w + 1] + img[i + 1] + img[i + w + 1] +
          img[i + w] + img[i + w - 1] + img[i - 1] + img[i - w - 1];
        if (nb === 1) ends[count++] = i;
      }
    }
    if (count === 0) break;
    for (let k = 0; k < count; k++) img[ends[k]] = 0;
  }
}

// --------------------------------------------------------------------------- //
// 5. Dilate with a disk structuring element -> uniform line width.
// --------------------------------------------------------------------------- //
function dilateDisk(img: Uint8Array, w: number, h: number, lineWidth: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const radius = Math.max(lineWidth - 1, 0) / 2;
  const r = Math.max(Math.ceil(radius), 1);
  // precompute disk offsets
  const offs: number[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= radius * radius + 1e-6) offs.push(dy * w + dx, dx, dy);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!img[i]) continue;
      for (let k = 0; k < offs.length; k += 3) {
        const nx = x + offs[k + 1];
        const ny = y + offs[k + 2];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        out[i + offs[k]] = 1;
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------------- //
// 6. Separable Gaussian blur of a 0/1 mask -> Float32 field in [0,1].
// --------------------------------------------------------------------------- //
export function gaussianBlur(mask: Uint8Array | Float32Array, w: number, h: number, sigma: number): Float32Array {
  const src = Float32Array.from(mask);
  if (sigma <= 0) return src;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const tmp = new Float32Array(w * h);
  // horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let xx = x + k;
        if (xx < 0) xx = 0;
        else if (xx >= w) xx = w - 1;
        acc += src[row + xx] * kernel[k + radius];
      }
      tmp[row + x] = acc;
    }
  }
  // vertical
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let yy = y + k;
        if (yy < 0) yy = 0;
        else if (yy >= h) yy = h - 1;
        acc += tmp[yy * w + x] * kernel[k + radius];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

// --------------------------------------------------------------------------- //
// 7. Interior cells = background not reachable from the image border.
// --------------------------------------------------------------------------- //
function interiorCells(lineBin: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const surrounding = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qs = 0, qe = 0;

  const pushIfBg = (i: number) => {
    if (!lineBin[i] && !surrounding[i]) {
      surrounding[i] = 1;
      queue[qe++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    pushIfBg(x);
    pushIfBg((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    pushIfBg(y * w);
    pushIfBg(y * w + (w - 1));
  }
  // 4-connected flood fill across the background
  while (qs < qe) {
    const p = queue[qs++];
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) pushIfBg(p - 1);
    if (x < w - 1) pushIfBg(p + 1);
    if (y > 0) pushIfBg(p - w);
    if (y < h - 1) pushIfBg(p + w);
  }

  const interior = new Uint8Array(n);
  for (let i = 0; i < n; i++) interior[i] = !lineBin[i] && !surrounding[i] ? 1 : 0;
  return interior;
}

// --------------------------------------------------------------------------- //
// Intermediate masks, shared by the RGBA renderer and the SVG exporter.
// --------------------------------------------------------------------------- //
export interface Masks {
  w: number;
  h: number;
  /** Pruned 1px skeleton (centerlines). */
  skeleton: Uint8Array;
  /** Enclosed glass-piece cells. */
  interior: Uint8Array;
  /** Solid line region at the requested width (matches line-mode display). */
  lineCore: Uint8Array;
}

export function computeMasks(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  params: Params,
): Masks {
  const n = w * h;
  const mask = lineMask(data, n, params.bgThresh);
  despeckle(mask, w, h, params.minBlob);

  const skeleton = skeletonize(mask, w, h);
  pruneSpurs(skeleton, w, h, params.pruneLen);

  const thick = dilateDisk(skeleton, w, h, params.lineWidth);
  const smoothed = gaussianBlur(thick, w, h, params.smoothSigma);

  const lineBin = new Uint8Array(n);
  for (let i = 0; i < n; i++) lineBin[i] = smoothed[i] > 0.5 ? 1 : 0;
  const interior = interiorCells(lineBin, w, h);

  let lineCore = thick;
  if (params.lineWidth >= 3 && params.smoothSigma > 0) {
    const effSigma = Math.min(params.smoothSigma, 0.6 * params.lineWidth);
    const sm = gaussianBlur(thick, w, h, effSigma);
    lineCore = new Uint8Array(n);
    for (let i = 0; i < n; i++) lineCore[i] = sm[i] > 0.5 ? 1 : 0;
  }

  return { w, h, skeleton, interior, lineCore };
}

// --------------------------------------------------------------------------- //
// Full pipeline. Returns RGBA bytes: black interior cells, transparent else.
// --------------------------------------------------------------------------- //
export function process(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  params: Params,
): Uint8ClampedArray {
  const n = w * h;
  const mask = lineMask(data, n, params.bgThresh);
  despeckle(mask, w, h, params.minBlob);

  let skel = skeletonize(mask, w, h);
  pruneSpurs(skel, w, h, params.pruneLen);

  const thick = dilateDisk(skel, w, h, params.lineWidth);
  const smoothed = gaussianBlur(thick, w, h, params.smoothSigma);

  // Line-drawing mode: draw the smoothed skeleton as crisp black lines whose
  // width matches the line-thickness setting. We cap the smoothing relative to
  // the line width so thin lines survive — a wide blur followed by a 0.5
  // threshold would erase a 1px line (or feather it into a fat soft band).
  if (params.mode === "lines") {
    // Solid line core at the requested width. For thin lines we use the
    // skeleton/dilated mask directly (a blur + 0.5 threshold would break a 1px
    // line into dashes). For thicker lines we can safely smooth the shape,
    // capping the blur so the center stays above the threshold.
    let core = thick;
    if (params.lineWidth >= 3 && params.smoothSigma > 0) {
      const effSigma = Math.min(params.smoothSigma, 0.6 * params.lineWidth);
      const sm = gaussianBlur(thick, w, h, effSigma);
      core = new Uint8Array(n);
      for (let i = 0; i < n; i++) core[i] = sm[i] > 0.5 ? 1 : 0;
    }
    // Light feather for anti-aliased edges; the solid core keeps full opacity.
    const aa = gaussianBlur(core, w, h, 0.6);
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const a = core[i] ? 255 : Math.round(Math.min(1, aa[i]) * 255);
      if (a > 0) out[i * 4 + 3] = a; // RGB already 0 (black)
    }
    return out;
  }

  const lineBin = new Uint8Array(n);
  for (let i = 0; i < n; i++) lineBin[i] = smoothed[i] > 0.5 ? 1 : 0;

  const interior = interiorCells(lineBin, w, h);

  // Light feathering of the interior gives smooth, anti-aliased edges without
  // turning the lines gray (the gaps are far wider than this blur).
  const alpha = gaussianBlur(interior, w, h, 0.8);

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const a = Math.round(alpha[i] * 255);
    if (a > 0) {
      out[i * 4] = 0;
      out[i * 4 + 1] = 0;
      out[i * 4 + 2] = 0;
      out[i * 4 + 3] = a;
    }
  }
  return out;
}
