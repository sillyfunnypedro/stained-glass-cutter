// SVG vector export. Turns the pipeline's masks into smooth vector paths:
//  - filled shapes (marching-squares contours -> Catmull-Rom Beziers), for the
//    glass-piece cells and for outlined lines, and
//  - centerline strokes (skeleton graph traced into polylines), for single-line
//    line drawings.

import { gaussianBlur } from "./processing";

type Pt = [number, number];

// --------------------------------------------------------------------------- //
// Marching squares: trace iso-contours of a float field at `level` into
// closed polylines (sub-pixel, so curves come out smooth).
// --------------------------------------------------------------------------- //
function marchingSquares(field: Float32Array, w: number, h: number, level: number): Pt[][] {
  const segs: number[] = []; // flat: x1,y1,x2,y2 per segment

  const interp = (ax: number, ay: number, av: number, bx: number, by: number, bv: number): Pt => {
    const d = bv - av;
    const t = Math.abs(d) < 1e-9 ? 0.5 : (level - av) / d;
    return [ax + (bx - ax) * t, ay + (by - ay) * t];
  };

  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = field[y * w + x];
      const tr = field[y * w + x + 1];
      const br = field[(y + 1) * w + x + 1];
      const bl = field[(y + 1) * w + x];
      let c = 0;
      if (tl > level) c |= 8;
      if (tr > level) c |= 4;
      if (br > level) c |= 2;
      if (bl > level) c |= 1;
      if (c === 0 || c === 15) continue;

      const T = (): Pt => interp(x, y, tl, x + 1, y, tr);
      const R = (): Pt => interp(x + 1, y, tr, x + 1, y + 1, br);
      const B = (): Pt => interp(x, y + 1, bl, x + 1, y + 1, br);
      const L = (): Pt => interp(x, y, tl, x, y + 1, bl);
      const push = (a: Pt, b: Pt) => segs.push(a[0], a[1], b[0], b[1]);

      switch (c) {
        case 1: push(L(), B()); break;
        case 2: push(B(), R()); break;
        case 3: push(L(), R()); break;
        case 4: push(T(), R()); break;
        case 5: push(T(), R()); push(B(), L()); break;
        case 6: push(T(), B()); break;
        case 7: push(T(), L()); break;
        case 8: push(T(), L()); break;
        case 9: push(T(), B()); break;
        case 10: push(T(), L()); push(B(), R()); break;
        case 11: push(T(), R()); break;
        case 12: push(L(), R()); break;
        case 13: push(B(), R()); break;
        case 14: push(L(), B()); break;
      }
    }
  }

  // Stitch segments into polylines by matching shared endpoints. Endpoints on a
  // shared cell edge are computed from identical corner values, so they match
  // exactly.
  const key = (x: number, y: number) => `${Math.round(x * 1e4)}_${Math.round(y * 1e4)}`;
  const nSeg = segs.length / 4;
  const ends = new Map<string, number[]>();
  for (let i = 0; i < nSeg; i++) {
    const ax = segs[i * 4], ay = segs[i * 4 + 1], bx = segs[i * 4 + 2], by = segs[i * 4 + 3];
    (ends.get(key(ax, ay)) ?? ends.set(key(ax, ay), []).get(key(ax, ay))!).push(i);
    (ends.get(key(bx, by)) ?? ends.set(key(bx, by), []).get(key(bx, by))!).push(i);
  }

  const used = new Uint8Array(nSeg);
  const ptOf = (seg: number, which: 0 | 1): Pt =>
    which === 0
      ? [segs[seg * 4], segs[seg * 4 + 1]]
      : [segs[seg * 4 + 2], segs[seg * 4 + 3]];

  const polylines: Pt[][] = [];
  for (let s = 0; s < nSeg; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const start = ptOf(s, 0);
    let cur = ptOf(s, 1);
    const poly: Pt[] = [start, cur];
    while (true) {
      const k = key(cur[0], cur[1]);
      const cand = ends.get(k);
      let next = -1;
      if (cand) for (const si of cand) if (!used[si]) { next = si; break; }
      if (next < 0) break;
      used[next] = 1;
      const a = ptOf(next, 0);
      const b = ptOf(next, 1);
      cur = key(a[0], a[1]) === k ? b : a;
      poly.push(cur);
    }
    if (poly.length >= 3) polylines.push(poly);
  }
  return polylines;
}

// --------------------------------------------------------------------------- //
// Ramer-Douglas-Peucker simplification.
// --------------------------------------------------------------------------- //
function rdp(points: Pt[], eps: number): Pt[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [sx, sy] = points[s];
    const [ex, ey] = points[e];
    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.hypot(dx, dy) || 1;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs(dx * (points[i][1] - sy) - dy * (points[i][0] - sx)) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// --------------------------------------------------------------------------- //
// Catmull-Rom -> cubic Bezier path strings.
// --------------------------------------------------------------------------- //
const f = (n: number) => n.toFixed(2);

function bezierClosed(points: Pt[]): string {
  const n = points.length;
  if (n < 3) return "";
  const d = [`M ${f(points[0][0])},${f(points[0][1])}`];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d.push(`C ${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(p2[0])},${f(p2[1])}`);
  }
  d.push("Z");
  return d.join(" ");
}

function bezierOpen(points: Pt[]): string {
  const n = points.length;
  if (n < 2) return "";
  if (n === 2) return `M ${f(points[0][0])},${f(points[0][1])} L ${f(points[1][0])},${f(points[1][1])}`;
  const d = [`M ${f(points[0][0])},${f(points[0][1])}`];
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 < n ? i + 2 : n - 1];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d.push(`C ${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(p2[0])},${f(p2[1])}`);
  }
  return d.join(" ");
}

function svgDoc(w: number, h: number, body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n` +
    `${body}\n</svg>\n`
  );
}

const isClosed = (poly: Pt[]) =>
  Math.hypot(poly[0][0] - poly[poly.length - 1][0], poly[0][1] - poly[poly.length - 1][1]) < 1.5;

// --------------------------------------------------------------------------- //
// Connected-component labeler for the interior mask: returns centroid + area
// for each distinct glass-piece cell (4-connected flood fill).
// --------------------------------------------------------------------------- //
interface CellComponent {
  cx: number;
  cy: number;
  area: number;
}

function findInteriorComponents(mask: Uint8Array, w: number, h: number): CellComponent[] {
  const n = w * h;
  const visited = new Uint8Array(n);
  const components: CellComponent[] = [];
  const stack = new Int32Array(n);
  // Scratch buffer so we can find the pixel closest to the centroid after the
  // flood fill — the centroid of a concave cell can fall outside the shape.
  const pixels = new Int32Array(n);

  for (let start = 0; start < n; start++) {
    if (!mask[start] || visited[start]) continue;

    let sp = 0, pixCount = 0;
    let sumX = 0, sumY = 0;
    stack[sp++] = start;
    visited[start] = 1;

    while (sp > 0) {
      const p = stack[--sp];
      pixels[pixCount++] = p;
      const x = p % w;
      const y = (p / w) | 0;
      sumX += x;
      sumY += y;

      if (x > 0 && mask[p - 1] && !visited[p - 1]) { visited[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !visited[p + 1]) { visited[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !visited[p - w]) { visited[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !visited[p + w]) { visited[p + w] = 1; stack[sp++] = p + w; }
    }

    // Centroid may lie outside the shape for concave cells. Find the component
    // pixel that is closest to the centroid — that point is always inside.
    const cx = sumX / pixCount;
    const cy = sumY / pixCount;
    let bestDist = Infinity, labelX = cx, labelY = cy;
    for (let i = 0; i < pixCount; i++) {
      const p = pixels[i];
      const px = p % w;
      const py = (p / w) | 0;
      const d = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      if (d < bestDist) { bestDist = d; labelX = px; labelY = py; }
    }

    components.push({ cx: labelX, cy: labelY, area: pixCount });
  }

  return components;
}

// --------------------------------------------------------------------------- //
// Public builders.
// --------------------------------------------------------------------------- //
export function buildFilledSvg(
  mask: Uint8Array,
  w: number,
  h: number,
  smoothSigma: number,
  simplifyTol = 1.2,
): string {
  const field = gaussianBlur(mask, w, h, Math.max(smoothSigma, 0.8));
  const polylines = marchingSquares(field, w, h, 0.5);
  const paths: string[] = [];
  for (const pl of polylines) {
    let pts = pl;
    if (pts.length > 1 && isClosed(pts)) pts = pts.slice(0, -1);
    pts = rdp(pts, simplifyTol);
    if (pts.length >= 3) paths.push(bezierClosed(pts));
  }
  const d = paths.join(" ");
  return svgDoc(w, h, `  <path fill="#000000" fill-rule="evenodd" stroke="none" d="${d}"/>`);
}

/** Stitch the raw skeleton trace back into continuous strokes. The trace splits
 *  the drawing at every junction, and junction clusters leave a swarm of tiny
 *  stubs. We (1) stitch 2-way meetings into longer lines, (2) contract short
 *  bridges between junctions (collapsing each cluster to a point), and (3) drop
 *  short dangling spurs. */
function mergePolylines(lines: Pt[][], minSpur: number, minBridge: number, minLoop: number): Pt[][] {
  const snap = (p: Pt) => `${Math.round(p[0])},${Math.round(p[1])}`;
  let cur = lines.filter((l) => l.length >= 2);

  const buildEnds = () => {
    const ends = new Map<string, number[]>();
    cur.forEach((l, i) => {
      const a = snap(l[0]);
      const b = snap(l[l.length - 1]);
      (ends.get(a) ?? ends.set(a, []).get(a)!).push(i);
      (ends.get(b) ?? ends.set(b, []).get(b)!).push(i);
    });
    return ends;
  };
  const len = (l: Pt[]) => {
    let s = 0;
    for (let i = 1; i < l.length; i++) s += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
    return s;
  };

  // (1) Stitch every clean 2-way meeting until none remain.
  const stitch = (): boolean => {
    let any = false;
    let changed = true;
    while (changed) {
      changed = false;
      const ends = buildEnds();
      const dead = new Set<number>();
      const touched = new Set<number>();
      for (const [k, idxs] of ends) {
        const alive = idxs.filter((i) => !dead.has(i));
        if (alive.length !== 2) continue;
        const [i, j] = alive;
        if (i === j || touched.has(i) || touched.has(j)) continue;
        const A = cur[i];
        const B = cur[j];
        const Aor = snap(A[A.length - 1]) === k ? A : A.slice().reverse();
        const Bor = snap(B[0]) === k ? B : B.slice().reverse();
        cur[i] = Aor.concat(Bor.slice(1));
        dead.add(j);
        touched.add(i);
        touched.add(j);
        changed = true;
        any = true;
      }
      if (dead.size) cur = cur.filter((_, i) => !dead.has(i));
    }
    return any;
  };

  // (2) Collapse one short junction-to-junction bridge by snapping its far end
  // onto its near end across all lines, then removing it.
  const contractOneBridge = (): boolean => {
    const ends = buildEnds();
    for (let i = 0; i < cur.length; i++) {
      const l = cur[i];
      if (isClosed(l) || len(l) >= minBridge) continue;
      const a = snap(l[0]);
      const b = snap(l[l.length - 1]);
      if (a === b) continue;
      if ((ends.get(a)?.length ?? 0) < 2 || (ends.get(b)?.length ?? 0) < 2) continue;
      const target = l[0];
      for (let m = 0; m < cur.length; m++) {
        if (m === i) continue;
        const L = cur[m];
        if (snap(L[0]) === b) L[0] = target.slice() as Pt;
        if (snap(L[L.length - 1]) === b) L[L.length - 1] = target.slice() as Pt;
      }
      cur.splice(i, 1);
      return true;
    }
    return false;
  };

  let go = true;
  while (go) {
    const s = stitch();
    const c = contractOneBridge();
    go = s || c;
  }

  // (3) Drop leftover noise: tiny closed loops, and short open lines with a
  // free (dangling) endpoint (spurs).
  const ends = buildEnds();
  return cur.filter((l) => {
    if (isClosed(l)) return len(l) >= minLoop;
    const free = (ends.get(snap(l[0]))?.length ?? 0) <= 1 || (ends.get(snap(l[l.length - 1]))?.length ?? 0) <= 1;
    return !free || len(l) >= minSpur;
  });
}

export function buildStrokedSvg(
  skeleton: Uint8Array,
  w: number,
  h: number,
  strokeWidth: number,
  simplifyTol = 1.0,
): string {
  const polylines = mergePolylines(traceSkeleton(skeleton, w, h), 12, 12, 16);
  const polyLen = (pl: Pt[]) => {
    let L = 0;
    for (let i = 1; i < pl.length; i++) L += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]);
    return L;
  };
  const paths: string[] = [];
  for (const pl of polylines) {
    const closed = pl.length > 3 && isClosed(pl);
    // Drop tiny straggler fragments (e.g. leftover thickness pixels) so they
    // don't become stray cut lines.
    if (!closed && polyLen(pl) < 4) continue;
    let pts = closed ? pl.slice(0, -1) : pl;
    pts = rdp(pts, simplifyTol);
    if (closed && pts.length >= 3) paths.push(bezierClosed(pts));
    else if (pts.length >= 2) paths.push(bezierOpen(pts));
  }
  const d = paths.join(" ");
  return svgDoc(
    w,
    h,
    `  <path fill="none" stroke="#000000" stroke-width="${strokeWidth}" ` +
      `stroke-linecap="round" stroke-linejoin="round" d="${d}"/>`,
  );
}

// --------------------------------------------------------------------------- //
// Numbers layer: one label per glass-piece cell.
// Positions are computed here so the main thread can expose them as draggable
// handles; the final SVG is built from whatever positions the user leaves them.
// --------------------------------------------------------------------------- //

/** One labelled cell: position is guaranteed inside the shape (never the raw
 *  centroid, which can fall outside a concave cell). */
export type NumberPosition = { x: number; y: number; area: number; label: number };

export function computeNumberPositions(interior: Uint8Array, w: number, h: number): NumberPosition[] {
  const minArea = 100;
  const components = findInteriorComponents(interior, w, h).filter((c) => c.area >= minArea);
  components.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  return components.map((c, i) => ({ x: c.cx, y: c.cy, area: c.area, label: i + 1 }));
}

// --------------------------------------------------------------------------- //
// Skeleton graph tracing -> centerline polylines.
// --------------------------------------------------------------------------- //
function traceSkeleton(skel: Uint8Array, w: number, h: number): Pt[][] {
  const idxN = (x: number, y: number) => y * w + x;
  const neighbors = (p: number): number[] => {
    const x = p % w;
    const y = (p / w) | 0;
    const out: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        const q = idxN(nx, ny);
        if (skel[q]) out.push(q);
      }
    }
    return out;
  };

  // Classify pixels by *connectivity number* — the count of distinct
  // 8-connected neighbour groups around the ring: 1 = endpoint, 2 = through
  // pixel, >=3 = real junction. This is robust to thick / staircase skeleton
  // pixels that have extra raw neighbours but still lie along a single line;
  // using the raw neighbour count instead mis-flags those as junctions and
  // shatters every line into thousands of 2px fragments.
  const ring = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  const isNode = new Uint8Array(w * h);
  const pixels: number[] = [];
  for (let p = 0; p < w * h; p++) {
    if (!skel[p]) continue;
    pixels.push(p);
    const x = p % w;
    const y = (p / w) | 0;
    let groups = 0;
    for (let i = 0; i < 8; i++) {
      const [dx, dy] = ring[i];
      const [px, py] = ring[(i + 7) % 8];
      const cx = x + dx, cy = y + dy;
      const ox = x + px, oy = y + py;
      const cOn = cx >= 0 && cx < w && cy >= 0 && cy < h && skel[cy * w + cx];
      const oOn = ox >= 0 && ox < w && oy >= 0 && oy < h && skel[oy * w + ox];
      if (cOn && !oOn) groups++;
    }
    if (groups !== 2) isNode[p] = 1;
  }

  const pt = (p: number): Pt => [(p % w) + 0.5, ((p / w) | 0) + 0.5];
  const edgeUsed = new Set<string>();
  const ekey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const adjacent = (a: number, b: number) =>
    Math.abs((a % w) - (b % w)) <= 1 && Math.abs(((a / w) | 0) - ((b / w) | 0)) <= 1;
  const polylines: Pt[][] = [];

  // Walk from `start` toward `first`, continuing through through-pixels until a
  // node (endpoint/junction) or a dead end.
  const walk = (start: number, first: number): number[] => {
    const path = [start];
    let prev = start;
    let cur = first;
    while (true) {
      path.push(cur);
      edgeUsed.add(ekey(prev, cur));
      if (isNode[cur]) break;
      const cand = neighbors(cur).filter((q) => q !== prev && !edgeUsed.has(ekey(cur, q)));
      if (cand.length === 0) break;
      // Prefer a neighbour not touching `prev` (forward along the line) over a
      // parallel thickness pixel, to avoid zig-zagging.
      const next = cand.find((q) => !adjacent(q, prev)) ?? cand[0];
      prev = cur;
      cur = next;
    }
    return path;
  };

  // 1. Chains between nodes (endpoints / junctions).
  for (const p of pixels) {
    if (!isNode[p]) continue;
    for (const nb of neighbors(p)) {
      if (edgeUsed.has(ekey(p, nb))) continue;
      polylines.push(walk(p, nb).map(pt));
    }
  }

  // 2. Pure loops (no nodes, e.g. an isolated ring).
  for (const p of pixels) {
    if (isNode[p]) continue;
    const nb = neighbors(p).filter((q) => !edgeUsed.has(ekey(p, q)));
    if (nb.length === 0) continue;
    const path = walk(p, nb[0]).map(pt);
    if (path.length >= 3) polylines.push(path);
  }

  return polylines;
}
