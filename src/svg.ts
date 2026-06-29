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
  const visited = new Uint8Array(w * h);
  const components: CellComponent[] = [];
  const stack = new Int32Array(w * h);

  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || visited[start]) continue;

    let sp = 0;
    let sumX = 0, sumY = 0, count = 0;
    stack[sp++] = start;
    visited[start] = 1;

    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p / w) | 0;
      sumX += x;
      sumY += y;
      count++;

      if (x > 0 && mask[p - 1] && !visited[p - 1]) { visited[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !visited[p + 1]) { visited[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !visited[p - w]) { visited[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !visited[p + w]) { visited[p + w] = 1; stack[sp++] = p + w; }
    }

    components.push({ cx: sumX / count, cy: sumY / count, area: count });
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

export function buildStrokedSvg(
  skeleton: Uint8Array,
  w: number,
  h: number,
  strokeWidth: number,
  simplifyTol = 1.0,
): string {
  const polylines = traceSkeleton(skeleton, w, h);
  const paths: string[] = [];
  for (const pl of polylines) {
    const closed = pl.length > 3 && isClosed(pl);
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
// Numbers layer: one SVG <text> per glass-piece cell, centred inside it.
// Font size scales with ~sqrt(cell area) so large and small cells both get
// a legible number. Cells smaller than minArea (noise fragments) are skipped.
// --------------------------------------------------------------------------- //
export function buildNumberedSvg(interior: Uint8Array, w: number, h: number): string {
  const minArea = 100;
  const components = findInteriorComponents(interior, w, h).filter((c) => c.area >= minArea);

  // Number top-to-bottom then left-to-right for a natural reading order.
  components.sort((a, b) => a.cy - b.cy || a.cx - b.cx);

  const texts: string[] = [];
  for (let i = 0; i < components.length; i++) {
    const { cx, cy, area } = components[i];
    const fontSize = Math.max(8, Math.min(60, Math.round(Math.sqrt(area) * 0.3)));
    texts.push(
      `  <text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" ` +
        `font-family="Arial,sans-serif" font-size="${fontSize}" ` +
        `text-anchor="middle" dominant-baseline="central" ` +
        `fill="#000000">${i + 1}</text>`,
    );
  }

  return svgDoc(w, h, texts.join("\n"));
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

  const degree = new Uint8Array(w * h);
  const pixels: number[] = [];
  for (let p = 0; p < w * h; p++) {
    if (skel[p]) {
      pixels.push(p);
      degree[p] = neighbors(p).length;
    }
  }

  const pt = (p: number): Pt => [(p % w) + 0.5, ((p / w) | 0) + 0.5];
  const edgeUsed = new Set<string>();
  const ekey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const polylines: Pt[][] = [];

  // Walk a chain starting from node `start` toward neighbor `first`, until the
  // next node (degree != 2) or back to a used edge.
  const walk = (start: number, first: number): number[] => {
    const path = [start];
    let prev = start;
    let cur = first;
    while (true) {
      path.push(cur);
      edgeUsed.add(ekey(prev, cur));
      if (degree[cur] !== 2) break; // reached a node/endpoint
      const nb = neighbors(cur);
      const next = nb.find((q) => q !== prev && !edgeUsed.has(ekey(cur, q)));
      if (next === undefined) break;
      prev = cur;
      cur = next;
    }
    return path;
  };

  // 1. Chains between nodes (endpoints / junctions).
  for (const p of pixels) {
    if (degree[p] === 2) continue;
    for (const nb of neighbors(p)) {
      if (edgeUsed.has(ekey(p, nb))) continue;
      polylines.push(walk(p, nb).map(pt));
    }
  }

  // 2. Pure loops (all degree 2, no nodes touched above).
  for (const p of pixels) {
    if (degree[p] !== 2) continue;
    const nb = neighbors(p).filter((q) => !edgeUsed.has(ekey(p, q)));
    if (nb.length === 0) continue;
    const path = walk(p, nb[0]).map(pt);
    if (path.length >= 3) polylines.push(path);
  }

  return polylines;
}
