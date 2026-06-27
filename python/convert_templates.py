#!/usr/bin/env python3
"""Convert stained-glass line templates to white-on-black images with 3px lines.

The source images are colored line drawings (green, magenta, etc.) on a white
background. This script:

  1. Detects the drawn lines (anything that isn't near-white background).
  2. Reduces every line to its 1px centerline (skeletonize), so the output line
     weight no longer depends on how thick the original strokes were drawn.
  3. Re-draws the centerlines at a uniform width (default 3px) in white on a
     black background.

Usage:
    python3 convert_templates.py                      # convert all jpgs here
    python3 convert_templates.py drawing.jpg other.jpg  # convert specific files
    python3 convert_templates.py --width 3 --bg-thresh 230 img.jpg

Outputs are written next to each input as "<name>_bw.png".
"""

import argparse
import os

import numpy as np
from PIL import Image
from scipy import ndimage
from skimage.morphology import skeletonize


def convert(path, line_width=3, bg_thresh=230, out_suffix="_bw"):
    """Convert one image to a white-on-black template with uniform line width."""
    img = Image.open(path).convert("RGB")
    arr = np.asarray(img)

    # A pixel is "line" if it is meaningfully darker/more saturated than the
    # white background. We treat anything where the minimum channel drops below
    # the background threshold as part of a drawn line. Colored lines (green,
    # magenta) and black lines all satisfy this; near-white paper does not.
    min_channel = arr.min(axis=2)
    line_mask = min_channel < bg_thresh

    # Remove tiny specks/JPEG noise so they don't become stray skeleton dots.
    labels, n = ndimage.label(line_mask)
    if n > 0:
        sizes = ndimage.sum(np.ones_like(labels), labels, range(1, n + 1))
        keep = np.zeros(n + 1, dtype=bool)
        keep[1:] = sizes >= 20  # drop blobs smaller than 20px
        line_mask = keep[labels]

    # Collapse each stroke to a 1px centerline so the final width is uniform
    # regardless of the original stroke thickness.
    skeleton = skeletonize(line_mask)

    # Grow the centerline back out to the requested width. A disk-shaped
    # structuring element keeps corners/junctions rounded rather than blocky.
    if line_width <= 1:
        thick = skeleton
    else:
        radius = (line_width - 1) / 2.0
        r = int(np.ceil(radius))
        yy, xx = np.ogrid[-r : r + 1, -r : r + 1]
        disk = (xx**2 + yy**2) <= radius**2 + 1e-6
        thick = ndimage.binary_dilation(skeleton, structure=disk)

    # Compose: white lines on a black background.
    out = np.zeros(arr.shape[:2], dtype=np.uint8)
    out[thick] = 255

    base, _ = os.path.splitext(path)
    out_path = f"{base}{out_suffix}.png"
    Image.fromarray(out, mode="L").save(out_path)
    return out_path


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("images", nargs="*",
                        help="Image files to convert (default: all *.jpg/*.png here)")
    parser.add_argument("--width", type=int, default=3,
                        help="Output line width in pixels (default: 3)")
    parser.add_argument("--bg-thresh", type=int, default=230,
                        help="Background brightness cutoff 0-255 (default: 230). "
                             "Lower it if faint lines are dropped; raise it if "
                             "background noise is picked up.")
    args = parser.parse_args()

    images = args.images
    if not images:
        here = os.path.dirname(os.path.abspath(__file__))
        images = [
            os.path.join(here, f)
            for f in sorted(os.listdir(here))
            if f.lower().endswith((".jpg", ".jpeg", ".png"))
            and not f.lower().endswith("_bw.png")
        ]

    if not images:
        print("No images found to convert.")
        return

    for path in images:
        out_path = convert(path, line_width=args.width, bg_thresh=args.bg_thresh)
        print(f"{os.path.basename(path)} -> {os.path.basename(out_path)}")


if __name__ == "__main__":
    main()
