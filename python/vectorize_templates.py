#!/usr/bin/env python3
"""Vectorize stained-glass line templates into smooth SVGs for Cricut cutting.

Cut style: OUTLINE / VINYL.
Each drawn line is turned into a thin filled shape whose *outline* is the cut
path. On the Cricut you cut the SVG, weed away the background, and are left with
the design as standing vinyl lines (the classic faux-stained-glass / lead-line
look on glass).

Pipeline:
  1. Detect the drawn lines (anything that isn't near-white background).
  2. Skeletonize to a 1px centerline so width no longer depends on how thick
     the original strokes were drawn.
  3. Re-grow the centerline to a uniform, weedable width.
  4. Gaussian-smooth the mask and trace its contours at sub-pixel precision,
     which rounds off the pixel staircase.
  5. Simplify the contours (Douglas-Peucker) and emit them as smooth cubic
     Bezier paths (Catmull-Rom), so Cricut gets true curves, not jagged
     polylines.

Output: "<name>_cut.svg"  (+ "<name>_cut_preview.png" to eyeball the result)

Usage:
    python3 vectorize_templates.py                       # all images here
    python3 vectorize_templates.py drawing.jpg other.jpg  # specific files
    python3 vectorize_templates.py --line-width 20 --smooth 3 img.jpg
"""

import argparse
import os

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from skimage.measure import find_contours
from skimage.morphology import skeletonize


# --------------------------------------------------------------------------- #
# Geometry helpers
# --------------------------------------------------------------------------- #
def rdp(points, epsilon):
    """Ramer-Douglas-Peucker polyline simplification. points: Nx2 array (x, y)."""
    if len(points) < 3:
        return points
    start, end = points[0], points[-1]
    line = end - start
    line_len = np.hypot(*line)
    if line_len == 0:
        dists = np.hypot(*(points - start).T)
    else:
        # perpendicular distance of each point to the start-end segment
        rel = points - start
        dists = np.abs(line[0] * rel[:, 1] - line[1] * rel[:, 0]) / line_len
    idx = int(np.argmax(dists))
    if dists[idx] > epsilon:
        left = rdp(points[: idx + 1], epsilon)
        right = rdp(points[idx:], epsilon)
        return np.vstack([left[:-1], right])
    return np.vstack([start, end])


def prune_spurs(skeleton, max_len):
    """Trim short dead-end branches off a 1px skeleton.

    A spur ends in an "endpoint" pixel (exactly one skeleton neighbor). These
    designs are made of connected loops with no legitimate dead-ends, so every
    endpoint belongs to a stray skeletonization spur. Removing all current
    endpoints `max_len` times eats spurs up to `max_len` px long while leaving
    the loop geometry untouched.
    """
    kernel = np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]])
    sk = skeleton.copy()
    for _ in range(max_len):
        neighbors = ndimage.convolve(sk.astype(np.uint8), kernel, mode="constant")
        endpoints = sk & (neighbors == 1)
        if not endpoints.any():
            break
        sk &= ~endpoints
    return sk


def catmull_rom_to_bezier(points):
    """Build a closed SVG path string of cubic Beziers through `points` (Nx2).

    A Catmull-Rom spline passes through every control point and converts cleanly
    to cubic Beziers, giving smooth closed curves for Cricut.
    """
    n = len(points)
    if n < 3:
        return ""
    d = [f"M {points[0][0]:.2f},{points[0][1]:.2f}"]
    for i in range(n):
        p0 = points[(i - 1) % n]
        p1 = points[i]
        p2 = points[(i + 1) % n]
        p3 = points[(i + 2) % n]
        c1 = p1 + (p2 - p0) / 6.0
        c2 = p2 - (p3 - p1) / 6.0
        d.append(
            f"C {c1[0]:.2f},{c1[1]:.2f} {c2[0]:.2f},{c2[1]:.2f} "
            f"{p2[0]:.2f},{p2[1]:.2f}"
        )
    d.append("Z")
    return " ".join(d)


def sample_bezier_path(points, per_seg=12):
    """Sample points along the closed Catmull-Rom curve, for PNG previewing."""
    n = len(points)
    out = []
    ts = np.linspace(0, 1, per_seg, endpoint=False)
    for i in range(n):
        p0 = points[(i - 1) % n]
        p1 = points[i]
        p2 = points[(i + 1) % n]
        p3 = points[(i + 2) % n]
        c1 = p1 + (p2 - p0) / 6.0
        c2 = p2 - (p3 - p1) / 6.0
        for t in ts:
            mt = 1 - t
            pt = (mt**3) * p1 + 3 * (mt**2) * t * c1 + 3 * mt * (t**2) * c2 + (t**3) * p2
            out.append(pt)
    return out


# --------------------------------------------------------------------------- #
# Main conversion
# --------------------------------------------------------------------------- #
def vectorize(path, line_width=16, bg_thresh=230, smooth_sigma=2.0,
              simplify_tol=1.2, min_blob=20, prune_len=15):
    img = Image.open(path).convert("RGB")
    arr = np.asarray(img)
    h, w = arr.shape[:2]

    # 1. line mask: anything not near-white
    line_mask = arr.min(axis=2) < bg_thresh

    # despeckle
    labels, n = ndimage.label(line_mask)
    if n > 0:
        sizes = ndimage.sum(np.ones_like(labels), labels, range(1, n + 1))
        keep = np.zeros(n + 1, dtype=bool)
        keep[1:] = sizes >= min_blob
        line_mask = keep[labels]

    # 2. centerline, then trim stray spurs
    skeleton = skeletonize(line_mask)
    if prune_len > 0:
        skeleton = prune_spurs(skeleton, prune_len)

    # 3. uniform width via disk dilation
    radius = max(line_width - 1, 0) / 2.0
    r = int(np.ceil(radius)) or 1
    yy, xx = np.ogrid[-r : r + 1, -r : r + 1]
    disk = (xx**2 + yy**2) <= radius**2 + 1e-6
    thick = ndimage.binary_dilation(skeleton, structure=disk)

    # 4. The thick lines split the page into cells. We want the enclosed cells
    #    (the "glass pieces") filled, while the lines and the surrounding area
    #    stay empty. Anything not a line is background; background regions that
    #    touch the image border are the surrounding area, the rest are interior
    #    cells.
    smooth = ndimage.gaussian_filter(thick.astype(float), smooth_sigma)
    line_bin = smooth > 0.5
    bg = ~line_bin
    labels, _ = ndimage.label(bg)
    border = np.unique(np.concatenate([
        labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]]))
    interior = bg & ~np.isin(labels, border)

    # 5. smooth + sub-pixel contour trace of the interior cells
    interior_field = ndimage.gaussian_filter(interior.astype(float), smooth_sigma)
    contours = find_contours(interior_field, 0.5)

    # 5. simplify + Bezier-ify each contour
    svg_paths = []
    preview_polys = []
    for c in contours:
        pts = np.column_stack([c[:, 1], c[:, 0]])  # (x, y)
        if len(pts) > 1 and np.allclose(pts[0], pts[-1]):
            pts = pts[:-1]  # drop duplicate closing point
        if len(pts) < 8:
            continue
        pts = rdp(pts, simplify_tol)
        if len(pts) < 3:
            continue
        svg_paths.append(catmull_rom_to_bezier(pts))
        preview_polys.append(sample_bezier_path(pts))

    base, _ = os.path.splitext(path)
    svg_path = f"{base}_cut.svg"
    _write_svg(svg_path, svg_paths, w, h)

    preview_path = f"{base}_cut_preview.png"
    _write_preview(preview_path, preview_polys, w, h)

    return svg_path, preview_path, len(svg_paths)


def _write_svg(out_path, svg_paths, w, h):
    # All sub-paths in one <path> with fill-rule evenodd so enclosed regions
    # (ring interiors, etc.) become holes rather than solid fills.
    d = " ".join(svg_paths)
    svg = (
        f'<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{w}" height="{h}" viewBox="0 0 {w} {h}">\n'
        f'  <path fill="#000000" fill-rule="evenodd" stroke="none" '
        f'd="{d}"/>\n'
        f'</svg>\n'
    )
    with open(out_path, "w") as f:
        f.write(svg)


def _write_preview(out_path, polys, w, h):
    # Fill the ribbons solid white, matching the SVG's evenodd rule: a pixel is
    # "on" if it's inside an odd number of contours, so enclosed regions (ring
    # interiors, etc.) stay black holes.
    acc = np.zeros((h, w), dtype=bool)
    for poly in polys:
        xy = [(float(p[0]), float(p[1])) for p in poly]
        if len(xy) < 3:
            continue
        tmp = Image.new("1", (w, h), 0)
        ImageDraw.Draw(tmp).polygon(xy, fill=1)
        acc ^= np.array(tmp, dtype=bool)
    # Black interior cells; lines and surrounding area transparent.
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[acc] = (0, 0, 0, 255)
    Image.fromarray(rgba, mode="RGBA").save(out_path)


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("images", nargs="*",
                        help="Images to vectorize (default: all *.jpg/*.png here)")
    parser.add_argument("--line-width", type=int, default=16,
                        help="Vinyl line thickness in source pixels (default: 16). "
                             "Thicker = easier to weed. ~16px is roughly 2mm when "
                             "cut at ~11in wide.")
    parser.add_argument("--bg-thresh", type=int, default=230,
                        help="Background brightness cutoff 0-255 (default: 230).")
    parser.add_argument("--smooth", type=float, default=2.0, dest="smooth_sigma",
                        help="Gaussian smoothing strength (default: 2.0). Higher = "
                             "smoother but rounds off sharp corners more.")
    parser.add_argument("--simplify", type=float, default=1.2, dest="simplify_tol",
                        help="Point-reduction tolerance in px (default: 1.2). Higher "
                             "= fewer, looser nodes.")
    parser.add_argument("--prune", type=int, default=15, dest="prune_len",
                        help="Max spur length to trim, in px (default: 15). 0 "
                             "disables spur removal.")
    args = parser.parse_args()

    images = args.images
    if not images:
        here = os.path.dirname(os.path.abspath(__file__))
        images = [
            os.path.join(here, f)
            for f in sorted(os.listdir(here))
            if f.lower().endswith((".jpg", ".jpeg", ".png"))
            and not f.lower().endswith(("_bw.png", "_cut_preview.png"))
        ]

    if not images:
        print("No images found to vectorize.")
        return

    for path in images:
        svg_path, preview_path, n = vectorize(
            path,
            line_width=args.line_width,
            bg_thresh=args.bg_thresh,
            smooth_sigma=args.smooth_sigma,
            simplify_tol=args.simplify_tol,
            prune_len=args.prune_len,
        )
        print(f"{os.path.basename(path)} -> {os.path.basename(svg_path)} "
              f"({n} paths)  + {os.path.basename(preview_path)}")


if __name__ == "__main__":
    main()
