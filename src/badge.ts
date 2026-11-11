// Draws an "unwatched episodes" badge in the top-right corner of a JPEG poster.
// Digits are a small monoline vector font (segments + arcs) rasterized with
// anti-aliasing, so they stay smooth at any poster size.
import jpeg from "jpeg-js";

type Pt = [number, number];
type Stroke = Pt[];

// Glyph box: 10 x 16 units, y grows downwards.
const arc = (cx: number, cy: number, r: number, from: number, to: number): Pt[] => {
  const pts: Pt[] = [];
  const steps = Math.max(2, Math.ceil(Math.abs(to - from) / 8));
  for (let i = 0; i <= steps; i++) {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
};

const GLYPHS: Record<string, Stroke[]> = {
  "0": [[...arc(5, 5, 4, 180, 360), ...arc(5, 11, 4, 0, 180), [1, 5]]],
  "1": [[[2.2, 3.6], [5.6, 1], [5.6, 15]]],
  "2": [[...arc(5, 5, 4, 180, 385), [1, 15], [9.2, 15]]],
  "3": [[...arc(5, 4.6, 3.6, 205, 450), ...arc(5, 11.6, 3.8, 270, 515)]],
  "4": [[[7, 15], [7, 1], [0.8, 11], [9.4, 11]]],
  "5": [[[8.6, 1], [2.2, 1], [1.6, 7.4], ...arc(5, 10.8, 4.2, 228, 515)]],
  "6": [arc(11, 11, 10, 180, 243), arc(5, 11, 4, 0, 360)],
  "7": [[[0.8, 1], [9.2, 1], [3.6, 15]]],
  "8": [arc(5, 4.5, 3.5, 0, 360), arc(5, 11.5, 4, 0, 360)],
  "9": [arc(-1, 5, 10, 0, 63), arc(5, 5, 4, 0, 360)],
  "+": [[[5, 4.2], [5, 11.8]], [[1.2, 8], [8.8, 8]]],
};
const GLYPH_W = 10, GLYPH_H = 16, ADVANCE = 13;

export type BadgeStyle = "new" | "unstarted";
const BADGE_COLORS: Record<BadgeStyle, number[]> = {
  new: [229, 57, 53], // red: started series with unwatched episodes
  unstarted: [41, 98, 255], // blue: series not started yet (count = released episodes)
};
const TEXT: number[] = [255, 255, 255];

function segDist(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2)) : 0;
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

export function drawBadge(jpegBytes: Uint8Array, count: number, style: BadgeStyle = "new"): Uint8Array {
  const BADGE = BADGE_COLORS[style];
  const img = jpeg.decode(jpegBytes, { useTArray: true, formatAsRGBA: true });
  const { width: W, height: H, data } = img;
  const text = count > 99 ? "99+" : String(count);

  const unit = W / 165; // glyph height ≈ 9.7% of poster width
  const stroke = 2.5 * unit; // line thickness in px
  const textW = ((text.length - 1) * ADVANCE + GLYPH_W) * unit + stroke;
  const textH = GLYPH_H * unit + stroke;
  const padX = 7 * unit, padY = 5.5 * unit;
  const bh = Math.round(textH + padY * 2);
  const bw = Math.round(Math.max(textW + padX * 2, bh)); // never narrower than a circle
  const margin = Math.round(W * 0.04);
  const x0 = W - margin - bw, y0 = margin;
  const r = bh / 2;

  // segments of the text, in pixel coordinates
  const ox = x0 + (bw - textW) / 2 + stroke / 2;
  const oy = y0 + (bh - textH) / 2 + stroke / 2;
  const segs: [Pt, Pt][] = [];
  [...text].forEach((ch, i) => {
    for (const s of GLYPHS[ch]) {
      for (let k = 1; k < s.length; k++) {
        const p = (q: Pt): Pt => [ox + (q[0] + i * ADVANCE) * unit, oy + q[1] * unit];
        segs.push([p(s[k - 1]), p(s[k])]);
      }
    }
  });

  const blend = (i: number, c: number[], a: number) => {
    if (a <= 0) return;
    for (let k = 0; k < 3; k++) data[i + k] = Math.round(data[i + k] * (1 - a) + c[k] * a);
  };
  const pill = (px: number, py: number, rr: number, bx: number, by: number) => {
    const cx = Math.min(Math.max(px, bx + rr), bx + bw - rr);
    return Math.min(1, Math.max(0, rr - Math.hypot(px - cx, py - (by + rr)) + 0.5));
  };

  const sh = Math.max(2, Math.round(unit * 1.5)); // shadow offset / blur
  for (let y = Math.max(0, y0 - sh); y < Math.min(H, y0 + bh + sh * 2); y++) {
    for (let x = Math.max(0, x0 - sh); x < Math.min(W, x0 + bw + sh); x++) {
      const i = (y * W + x) * 4;
      const cx = x + 0.5, cy = y + 0.5;
      // soft drop shadow, then the pill, then a subtle top highlight
      const shadow = Math.min(1, Math.max(0, (r + sh - Math.hypot(cx - Math.min(Math.max(cx, x0 + r), x0 + bw - r), cy - (y0 + r + sh * 0.6))) / (sh * 2)));
      blend(i, [0, 0, 0], 0.45 * shadow * (1 - pill(cx, cy, r, x0, y0)));
      const cover = pill(cx, cy, r, x0, y0);
      if (cover <= 0) continue;
      const shade = 1 + 0.12 * (1 - (cy - y0) / bh); // slightly lighter at the top
      blend(i, BADGE.map((v) => Math.min(255, v * shade)), cover);
      let d = Infinity;
      for (const [a, b] of segs) d = Math.min(d, segDist(cx, cy, a, b));
      blend(i, TEXT, cover * Math.min(1, Math.max(0, stroke / 2 - d + 0.5)));
    }
  }

  return new Uint8Array(jpeg.encode({ width: W, height: H, data }, 85).data);
}
