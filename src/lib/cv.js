// OpenCV.js ships with the app (public/opencv.js) so detection works offline and never depends on a CDN.
const SRC = `${import.meta.env.BASE_URL}opencv.js`;
let loading = null;

export const cvReady = () => !!(window.cv && window.cv.Mat && window.cv.getPerspectiveTransform);

export function loadOpenCV() {
  if (cvReady()) return Promise.resolve(true);
  if (loading) return loading;
  loading = new Promise((resolve) => {
    const t0 = Date.now();
    const poll = () => {
      if (cvReady()) resolve(true);
      else if (Date.now() - t0 > 60000) resolve(false);
      else setTimeout(poll, 150);
    };
    const s = document.createElement('script');
    s.async = true;
    s.src = SRC;
    s.onload = () => {
      // Some OpenCV.js builds expose `cv` as a promise-like object until the runtime is ready.
      const v = window.cv;
      if (v && typeof v.then === 'function' && !v.Mat) {
        v.then((m) => { try { delete m.then; } catch { /* ignore */ } window.cv = m; });
      }
      poll();
    };
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  }).then((ok) => {
    if (!ok) loading = null; // allow retry
    return ok;
  });
  return loading;
}

/* ---------- tuning (all the strictness knobs live here) ---------- */
const T = {
  minArea: 0.12,        // a document must fill at least this share of the frame
  maxArea: 0.9,         // ...and not more than this (a bed or a wall fills the frame, a sheet does not)
  marginLive: 0.012,    // live: every corner must sit this far inside the frame (share of the short side)
  marginStill: 0.004,   // photos: slightly more forgiving
  angleMin: 62, angleMax: 118, // inner corner angles of a sheet, perspective included
  sideRatioMin: 0.5,    // opposite sides must be of similar length
  aspectMax: 2.3,       // longest/shortest side
  sideSupport: 0.6,     // each visible side: share of its length lying on a real, straight, matching edge
  meanSupport: 0.72,    // average over the visible sides
  minContrast: 7,       // grey-level step across a side (inside brighter than outside)
  paperMinGrey: 100,    // paper is bright
  paperMaxSat: 0.27,    // ...and nearly colourless
  paperUniform: 0.6,    // share of the interior that is one flat paper tone
  chromaMax: 0.18,      // share of clearly coloured pixels allowed inside (blankets, clothes, tables)
  coarseMax: 0.17,      // blankets, folds and pillows vary a lot more than a sheet of paper does
  skinCenter: 0.015,    // skin in the middle of the page: a hand, a face, a bed with someone on it
  skinTotal: 0.22,      // fingers may only cover the rim
  offAxisMax: 1.1,      // long lines that are not parallel to the page sides (folds, creases, pillows)
  sharpMin: 0.35,       // paper edges are crisp, mattress and blanket outlines are soft
  confMin: 0.62,
};

/* ---------- geometry helpers (pixel space) ---------- */
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const centroid = (q) => ({ x: q.reduce((s, p) => s + p.x, 0) / q.length, y: q.reduce((s, p) => s + p.y, 0) / q.length });
const shrink = (q, f) => { const c = centroid(q); return q.map((p) => ({ x: c.x + (p.x - c.x) * f, y: c.y + (p.y - c.y) * f })); };

const polyArea = (q) => {
  let a = 0;
  for (let i = 0; i < q.length; i++) { const p = q[i], n = q[(i + 1) % q.length]; a += p.x * n.y - n.x * p.y; }
  return Math.abs(a) / 2;
};

// Order as top-left, top-right, bottom-right, bottom-left, whatever the rotation.
function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let start = 0;
  sorted.forEach((p, i) => { if (p.x + p.y < sorted[start].x + sorted[start].y) start = i; });
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
}

// Calls fn(x, y) for every pixel inside a convex polygon.
function scan(poly, w, h, fn) {
  const ys = poly.map((p) => p.y);
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        const x = a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y);
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
    for (let x = Math.max(0, Math.ceil(lo)); x <= Math.min(w - 1, Math.floor(hi)); x++) fn(x, y);
  }
}

// Does the outline have the proportions and angles of a sheet seen from a camera?
function looksLikeSheet(q, w, h, margin) {
  const m = Math.min(w, h) * margin;
  if (!q.every((p) => p.x > m && p.y > m && p.x < w - m && p.y < h - m)) return false; // part of it is outside the frame
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
    if (l1 < 12 || l2 < 12) return false;
    const deg = (Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (l1 * l2)))) * 180) / Math.PI;
    if (deg < T.angleMin || deg > T.angleMax) return false;
  }
  const a = dist(q[0], q[1]), b = dist(q[1], q[2]), c = dist(q[3], q[2]), d = dist(q[0], q[3]);
  if (Math.min(a, c) / Math.max(a, c) < T.sideRatioMin || Math.min(b, d) / Math.max(b, d) < T.sideRatioMin) return false;
  return Math.max(a + c, b + d) / Math.min(a + c, b + d) <= T.aspectMax;
}

/* ---------- skin ---------- */
// Skin tone test (red-dominant, orange hue, typical Cr/Cb band). Works across light and dark skin and ignores warm-lit paper.
export function isSkin(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx < 45 || r < g || r < b) return false;
  const s = (mx - mn) / mx;
  if (s < 0.2 || s > 0.75) return false;
  const hue = (g - b) / (mx - mn); // 0 = red, 0.5 = 30 degrees
  if (hue < -0.09 || hue > 0.53) return false;
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cr = (r - y) * 0.713 + 128, cb = (b - y) * 0.564 + 128;
  return cr >= 136 && cr <= 178 && cb >= 75 && cb <= 128 && cr - cb >= 22;
}

/* ---------- harvesting four-corner candidates ---------- */
// Snap the four sides to the straight stretches of the outline and intersect them. Stretches next to skin are ignored,
// so a corner hidden under a finger is restored instead of being cut off.
function snapToOutline(cv, quad, hull, skinNear, w, h) {
  const minDim = Math.min(w, h);
  const dense = [];
  const hp = hull.data32S;
  const n = hull.rows;
  for (let i = 0; i < n; i++) {
    const a = { x: hp[i * 2], y: hp[i * 2 + 1] }, b = { x: hp[((i + 1) % n) * 2], y: hp[((i + 1) % n) * 2 + 1] };
    const steps = Math.max(1, Math.round(dist(a, b) / 2));
    for (let j = 0; j < steps; j++) dense.push({ x: a.x + ((b.x - a.x) * j) / steps, y: a.y + ((b.y - a.y) * j) / steps });
  }
  const tol = Math.max(3, minDim * 0.02);
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    const len = dist(a, b);
    const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const pts = [];
    for (const p of dense) {
      const t = (p.x - a.x) * u.x + (p.y - a.y) * u.y;
      const off = Math.abs((p.x - a.x) * -u.y + (p.y - a.y) * u.x);
      if (t > len * 0.03 && t < len * 0.97 && off <= tol && !skinNear(p.x, p.y)) pts.push(p.x, p.y);
    }
    let line = { p: a, u };
    if (pts.length >= 20) {
      const m = cv.matFromArray(pts.length / 2, 1, cv.CV_32FC2, pts);
      const l = new cv.Mat();
      try {
        cv.fitLine(m, l, cv.DIST_HUBER, 0, 0.01, 0.01);
        const f = l.data32F;
        if (Math.abs(f[0] * u.x + f[1] * u.y) > Math.cos((8 * Math.PI) / 180)) line = { p: { x: f[2], y: f[3] }, u: { x: f[0], y: f[1] } };
      } finally { m.delete(); l.delete(); }
    }
    lines.push(line);
  }
  const cross = (p, q) => p.x * q.y - p.y * q.x;
  const out = quad.map((orig, i) => {
    const L1 = lines[(i + 3) % 4], L2 = lines[i];
    const den = cross(L1.u, L2.u);
    if (Math.abs(den) < 1e-3) return orig;
    const t = cross({ x: L2.p.x - L1.p.x, y: L2.p.y - L1.p.y }, L2.u) / den;
    return { x: L1.p.x + L1.u.x * t, y: L1.p.y + L1.u.y * t };
  });
  return out.every((p, i) => dist(p, quad[i]) <= minDim * 0.12) ? out : quad;
}

function collect(cv, bin, S, retrieval, out, margin) {
  const { w, h } = S;
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  const frame = w * h;
  try {
    cv.findContours(bin, contours, hier, retrieval, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      try {
        if (cv.contourArea(cnt) < frame * T.minArea * 0.85) continue;
        const hull = new cv.Mat();
        try {
          cv.convexHull(cnt, hull, false, true);
          const hullArea = cv.contourArea(hull);
          const peri = cv.arcLength(hull, true);
          let quad = null;
          for (const eps of [0.01, 0.02, 0.03, 0.045]) {
            const ap = new cv.Mat();
            cv.approxPolyDP(hull, ap, eps * peri, true);
            const rows = ap.rows;
            if (rows === 4) quad = [0, 1, 2, 3].map((j) => ({ x: ap.data32S[j * 2], y: ap.data32S[j * 2 + 1] }));
            ap.delete();
            if (quad || rows < 4) break;
          }
          if (!quad) { // rounded corners, a ragged edge or a hidden corner: tightest rotated rectangle
            const r = cv.minAreaRect(hull);
            if (hullArea / (r.size.width * r.size.height) > 0.9) quad = cv.RotatedRect.points(r).map((p) => ({ x: p.x, y: p.y }));
          }
          if (!quad) continue;
          quad = orderCorners(quad);
          quad = orderCorners(snapToOutline(cv, quad, hull, S.skinNear, w, h));
          quad = quad.map((p) => ({ x: Math.min(w, Math.max(0, p.x)), y: Math.min(h, Math.max(0, p.y)) }));
          const qa = polyArea(quad);
          const fill = hullArea / qa;
          if (qa > frame * T.minArea && qa < frame * T.maxArea && fill > 0.88 && fill < 1.12 && looksLikeSheet(quad, w, h, margin))
            out.push({ quad, pre: Math.sqrt(qa / frame) * Math.min(fill, 1 / fill) });
        } finally { hull.delete(); }
      } finally { cnt.delete(); }
    }
  } finally { contours.delete(); hier.delete(); }
}

/* ---------- judging a candidate ---------- */
// Everything below looks at the candidate the way a person would: are the four sides real, straight, matching edges?
// Is the inside flat, plain paper rather than a blanket, a table, a face or a hand?
function judge(cv, S, quad, wantLines) {
  const { w, h } = S;
  const minDim = Math.min(w, h);
  const c = centroid(quad);
  const r = Math.max(2, Math.round(minDim * 0.012)); // search distance across a side
  const off = Math.max(4, Math.round(minDim * 0.02)); // compare the paper just inside with the surface just outside
  const fail = (why) => ({ ok: false, why, conf: 0 });
  const sides = [];

  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    const len = dist(a, b);
    const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    let n = { x: -u.y, y: u.x };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if ((c.x - mid.x) * n.x + (c.y - mid.y) * n.y < 0) n = { x: -n.x, y: -n.y }; // n points into the page
    const steps = Math.max(10, Math.round(len / 2));
    let all = 0, tot = 0, hit = 0, hid = 0, sign = 0, gi = 0, go = 0, sharp = 0;
    const ci = [0, 0, 0], co = [0, 0, 0];
    for (let j = 0; j <= steps; j++) {
      const t = 0.04 + (0.92 * j) / steps;
      const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
      all++;
      const xi = Math.round(px + n.x * off), yi = Math.round(py + n.y * off);
      const xo = Math.round(px - n.x * off), yo = Math.round(py - n.y * off);
      if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1 || xo < 1 || yo < 1 || xo >= w - 1 || yo >= h - 1) continue;
      if (S.skin[yi * w + xi] || S.skin[Math.round(py + n.y * 2) * w + Math.round(px + n.x * 2)]) { hid++; continue; } // a finger over the rim
      tot++;
      let best = 0, bs = 0;
      for (let k = -r; k <= r; k++) {
        const x = Math.round(px + n.x * k), y = Math.round(py + n.y * k);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        const idx = y * w + x, gx = S.gx[idx], gy = S.gy[idx];
        const gm = Math.hypot(gx, gy);
        if (gm < 24) continue;
        const gn = gx * n.x + gy * n.y;
        if (Math.abs(gn) < 0.85 * gm) continue; // the edge must run along this side, not cross it
        if (Math.abs(gn) > best) { best = Math.abs(gn); bs = gn; }
      }
      const step = Math.abs(S.gray[yi * w + xi] - S.gray[yo * w + xo]);
      if (best) { hit++; sign += bs > 0 ? 1 : -1; sharp += Math.min(1, best / 4 / Math.max(8, step)); }
      gi += S.gray[yi * w + xi]; go += S.gray[yo * w + xo];
      for (let k = 0; k < 3; k++) { ci[k] += S.rgb[(yi * w + xi) * 3 + k]; co[k] += S.rgb[(yo * w + xo) * 3 + k]; }
    }
    sides.push({
      valid: tot >= Math.max(8, all * 0.5) && hid < all * 0.35,
      hidden: hid >= all * 0.35,
      sup: tot ? hit / tot : 0,
      sharp: hit ? sharp / hit : 0,
      sign: hit ? sign / hit : 0,
      contrast: tot ? (gi - go) / tot : 0,
      cdist: tot ? Math.hypot(ci[0] - co[0], ci[1] - co[1], ci[2] - co[2]) / tot : 0,
    });
  }

  const vis = sides.filter((s) => s.valid);
  if (vis.length < 3) return fail('sides not visible');
  if (sides.filter((s) => s.hidden).length > 1) return fail('too much hidden');
  if (vis.some((s) => s.sup < T.sideSupport)) return fail('weak side ' + sides.map((s) => s.valid ? s.sup.toFixed(2) : 'x').join('/'));
  const meanSup = vis.reduce((s, v) => s + v.sup, 0) / vis.length;
  if (meanSup < T.meanSupport) return fail('low support');
  if (vis.some((s) => Math.abs(s.contrast) < T.minContrast && s.cdist < 18)) return fail('no boundary');
  const lit = vis.filter((s) => Math.abs(s.contrast) >= T.minContrast);
  if (lit.some((s) => s.contrast < 0)) return fail('inside darker ' + sides.map((s) => s.contrast.toFixed(0)).join('/'));
  const contrast = vis.reduce((s, v) => s + Math.max(0, v.contrast), 0) / vis.length;
  const sharpness = vis.reduce((s, v) => s + v.sharp, 0) / vis.length;
  if (sharpness < T.sharpMin) return fail('soft outline ' + sharpness.toFixed(2));
  if (contrast < T.minContrast * 0.8 && vis.reduce((s, v) => s + v.cdist, 0) / vis.length < 30) return fail('flat contrast');

  // inside the page: tone, colour, uniformity, coarse variation, skin
  const centre = shrink(quad, 0.9), whole = shrink(quad, 0.97), core = shrink(quad, 0.7);
  const hist = new Uint32Array(256);
  let nC = 0;
  scan(centre, w, h, (x, y) => { hist[S.gray[y * w + x]]++; nC++; });
  if (nC < 200) return fail('too small');
  let acc = 0, med = 0;
  while (med < 255 && (acc += hist[med]) < nC / 2) med++;
  if (med < T.paperMinGrey) return fail('too dark');
  const tol = Math.max(20, med * 0.16);
  let near = 0, sr = 0, sg = 0, sb = 0, cs = 0, cq = 0, chroma = 0;
  scan(centre, w, h, (x, y) => {
    const i = y * w + x, g = S.gray[i];
    const cv2 = S.coarse[i];
    { const R = S.rgb[i * 3], G = S.rgb[i * 3 + 1], B = S.rgb[i * 3 + 2], mxx = Math.max(R, G, B); if (mxx > 40 && (mxx - Math.min(R, G, B)) / mxx > 0.3) chroma++; }
    if (Math.abs(g - med) <= tol) { near++; cs += cv2; cq += cv2 * cv2; sr += S.rgb[i * 3]; sg += S.rgb[i * 3 + 1]; sb += S.rgb[i * 3 + 2]; }
  });
  const uni = near / nC;
  if (uni < T.paperUniform) return fail('not flat paper ' + uni.toFixed(2));
  if (chroma / nC > T.chromaMax) return fail('coloured areas inside ' + (chroma / nC).toFixed(2));
  const mx = Math.max(sr, sg, sb) / near, mn = Math.min(sr, sg, sb) / near;
  if (mx > 0 && (mx - mn) / mx > T.paperMaxSat) return fail('coloured');
  const mean = cs / near, coarseStd = Math.sqrt(Math.max(0, cq / near - mean * mean)) / Math.max(1, mean); // measured on paper pixels only, so print and ink do not count
  if (coarseStd > T.coarseMax) return fail('uneven ' + coarseStd.toFixed(2));

  let nCore = 0, skinCore = 0, nAll = 0, skinAll = 0;
  scan(core, w, h, (x, y) => { nCore++; if (S.skin[y * w + x]) skinCore++; });
  scan(whole, w, h, (x, y) => { nAll++; if (S.skin[y * w + x]) skinAll++; });
  if (nCore && skinCore / nCore > T.skinCenter) return fail('skin in the middle');
  if (nAll && skinAll / nAll > T.skinTotal) return fail('too much skin');

  // long lines that do not follow the page sides are folds and pillows, not paper
  let off2 = 0;
  if (wantLines) {
    const minSide = Math.min(dist(quad[0], quad[1]), dist(quad[1], quad[2]), dist(quad[2], quad[3]), dist(quad[3], quad[0]));
    const mats = [];
    const keep = (m) => (mats.push(m), m);
    try {
      const mask = keep(cv.Mat.zeros(h, w, cv.CV_8UC1));
      const pts = keep(cv.matFromArray(4, 1, cv.CV_32SC2, centre.flatMap((p) => [Math.round(p.x), Math.round(p.y)])));
      const mv = keep(new cv.MatVector());
      mv.push_back(pts);
      cv.fillPoly(mask, mv, new cv.Scalar(255));
      const e = keep(new cv.Mat());
      cv.bitwise_and(S.fineEdges, mask, e);
      const lines = keep(new cv.Mat());
      const minLen = Math.round(minSide * 0.3);
      cv.HoughLinesP(e, lines, 1, Math.PI / 180, Math.max(18, Math.round(minSide * 0.25)), minLen, 4);
      const dirs = [0, 1, 2, 3].map((i) => Math.atan2(quad[(i + 1) % 4].y - quad[i].y, quad[(i + 1) % 4].x - quad[i].x));
      const d = lines.data32S;
      for (let i = 0; i < lines.rows; i++) {
        const x1 = d[i * 4], y1 = d[i * 4 + 1], x2 = d[i * 4 + 2], y2 = d[i * 4 + 3];
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const onAxis = dirs.some((a) => { let df = Math.abs(ang - a) % Math.PI; if (df > Math.PI / 2) df = Math.PI - df; return df < (14 * Math.PI) / 180; });
        if (!onAxis) off2 += Math.hypot(x2 - x1, y2 - y1);
      }
      off2 /= minSide;
    } finally { mats.forEach((m) => { try { m.delete(); } catch { /* freed */ } }); }
    if (off2 > T.offAxisMax) return fail('creases / folds');
  }

  const conf = 0.38 * meanSup + 0.2 * clamp01((uni - 0.5) / 0.4) + 0.15 * clamp01(contrast / 40) + 0.15 * (1 - clamp01(coarseStd / 0.2)) + 0.12 * clamp01(1 - off2 / T.offAxisMax);
  if (conf < T.confMin) return fail('low confidence');
  return { ok: true, why: 'ok', conf };
}

// Per-frame data shared by all candidates (copied out of WASM memory so it stays valid).
function prepare(cv, canvas, keep) {
  const w = canvas.width, h = canvas.height;
  const rgba = keep(cv.imread(canvas));
  const rgbM = keep(new cv.Mat());
  cv.cvtColor(rgba, rgbM, cv.COLOR_RGBA2RGB);
  const grayM = keep(new cv.Mat());
  cv.cvtColor(rgba, grayM, cv.COLOR_RGBA2GRAY);
  const blur3 = keep(new cv.Mat());
  cv.GaussianBlur(grayM, blur3, new cv.Size(3, 3), 0);
  const gxM = keep(new cv.Mat()), gyM = keep(new cv.Mat());
  cv.Sobel(blur3, gxM, cv.CV_32F, 1, 0, 3);
  cv.Sobel(blur3, gyM, cv.CV_32F, 0, 1, 3);
  const k = Math.max(9, Math.round(Math.max(w, h) * 0.06) | 1);
  const coarseM = keep(new cv.Mat());
  cv.GaussianBlur(grayM, coarseM, new cv.Size(k, k), 0);
  const fine = keep(new cv.Mat());
  cv.Canny(blur3, fine, 30, 90);

  const rgb = rgbM.data.slice();
  const n = w * h;
  const skin = new Uint8Array(n), paper = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const R = rgb[p], G = rgb[p + 1], B = rgb[p + 2];
    if (isSkin(R, G, B)) skin[i] = 255;
    else {
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      if (mx > 105 && (mx - mn) / mx < 0.26) paper[i] = 255; // bright and colourless
    }
  }
  const mk = (arr) => { const m = keep(new cv.Mat(h, w, cv.CV_8UC1)); m.data.set(arr); return m; };
  const k5 = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
  const skinM = mk(skin);
  cv.morphologyEx(skinM, skinM, cv.MORPH_OPEN, keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)))); // drop speckle
  const skinClean = skinM.data.slice();
  const skinD = keep(new cv.Mat());
  cv.dilate(skinM, skinD, k5);
  const skinDd = skinD.data.slice();
  return {
    w, h, rgb, gray: blur3.data.slice(), gx: gxM.data32F.slice(), gy: gyM.data32F.slice(), coarse: coarseM.data.slice(),
    skin: skinClean, skinD, fineEdges: fine, paperM: mk(paper), blur: blur3, rgbM, grayM, k5,
    skinNear: (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi >= 0 && yi >= 0 && xi < w && yi < h && !!skinDd[yi * w + xi]; },
  };
}

// Finds the most document-like four-corner shape in an RGBA canvas, or null if nothing convincing is there.
// `thorough` adds extra strategies for still photos; the live preview stays strict and fast.
export function findDocument(cv, canvas, thorough, debug) {
  const mats = [];
  const keep = (m) => (mats.push(m), m);
  try {
    const S = prepare(cv, canvas, keep);
    const { w, h } = S;
    const margin = thorough ? T.marginStill : T.marginLive;
    const cands = [];
    const k3 = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    const jobs = [];

    // 1) the page as a plain, colourless, bright region with skin cut out (so a hand never becomes part of it)
    const pm = keep(new cv.Mat());
    cv.subtract(S.paperM, S.skinD, pm);
    cv.morphologyEx(pm, pm, cv.MORPH_OPEN, S.k5);
    cv.morphologyEx(pm, pm, cv.MORPH_CLOSE, S.k5);
    jobs.push([pm, cv.RETR_EXTERNAL]);
    // 2) edges on brightness
    for (const [lo, hi] of thorough ? [[25, 80], [50, 140]] : [[40, 120]]) {
      const e = keep(new cv.Mat());
      cv.Canny(S.blur, e, lo, hi);
      cv.dilate(e, e, k3);
      jobs.push([e, cv.RETR_LIST]);
    }
    // 3) bright (or dark) region against its surroundings, skin removed
    const bin = keep(new cv.Mat());
    cv.threshold(S.blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.subtract(bin, S.skinD, bin);
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, S.k5);
    cv.morphologyEx(bin, bin, cv.MORPH_OPEN, S.k5);
    jobs.push([bin, cv.RETR_EXTERNAL]);
    if (thorough) {
      const inv = keep(new cv.Mat());
      cv.bitwise_not(bin, inv);
      cv.subtract(inv, S.skinD, inv);
      jobs.push([inv, cv.RETR_EXTERNAL]);
      const clahe = new cv.CLAHE(3.0, new cv.Size(8, 8));
      const eq = keep(new cv.Mat());
      clahe.apply(S.grayM, eq);
      clahe.delete();
      const eb = keep(new cv.Mat()), ee = keep(new cv.Mat());
      cv.GaussianBlur(eq, eb, new cv.Size(5, 5), 0);
      cv.Canny(eb, ee, 40, 110);
      cv.dilate(ee, ee, k3);
      jobs.push([ee, cv.RETR_LIST]);
      const planes = keep(new cv.MatVector());
      cv.split(S.rgbM, planes);
      const merged = keep(new cv.Mat());
      for (let i = 0; i < 3; i++) {
        const p = planes.get(i);
        const b = new cv.Mat(), e = new cv.Mat();
        cv.GaussianBlur(p, b, new cv.Size(5, 5), 0);
        cv.Canny(b, e, 30, 90);
        if (i === 0) e.copyTo(merged); else cv.bitwise_or(merged, e, merged);
        p.delete(); b.delete(); e.delete();
      }
      cv.dilate(merged, merged, k3);
      jobs.push([merged, cv.RETR_LIST]);
    }

    for (const [m, r] of jobs) collect(cv, m, S, r, cands, margin);
    if (!cands.length) return debug ? { quad: null, why: ['no candidates'] } : null;
    cands.sort((a, b) => b.pre - a.pre);

    // judge the strongest few distinct shapes; the most convincing one wins
    const seen = [];
    const verdicts = [];
    let best = null, tried = 0;
    for (const c of cands) {
      if (tried >= 8) break;
      if (seen.some((q) => q.reduce((s, p, i) => s + dist(p, c.quad[i]), 0) / 4 < Math.min(w, h) * 0.03)) continue;
      seen.push(c.quad);
      tried++;
      let v = judge(cv, S, c.quad, true), q = c.quad;
      // an outline that swallowed the page's shadow or a loose margin: try it pulled in a little
      if (!v.ok && /weak|darker|boundary|support|contrast|soft/.test(v.why)) {
        for (const f of [0.985, 0.97]) {
          const q2 = shrink(c.quad, f), v2 = judge(cv, S, q2, true);
          if (v2.ok) { v = v2; q = q2; break; }
        }
      }
      verdicts.push(v.why);
      if (v.ok && (!best || v.conf > best.conf)) best = { quad: q, conf: v.conf };
    }
    if (debug) return { quad: best ? best.quad.map((p) => ({ x: p.x / w, y: p.y / h })) : null, conf: best?.conf, why: verdicts };
    if (!best) return null; // nothing convincing: better to show nothing than something wrong
    return best.quad.map((p) => ({ x: p.x / w, y: p.y / h }));
  } finally {
    mats.forEach((m) => { try { m.delete(); } catch { /* already freed */ } });
  }
}

// Re-fit each side of the page to the real edge pixels in a higher-resolution copy, then intersect the four lines.
// This removes the small error left by working on a downscaled image.
function refineCorners(cv, source, quad) {
  const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
  const s = Math.min(1, 1400 / Math.max(sw, sh));
  const w = Math.round(sw * s), h = Math.round(sh * s);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, w, h);
  const mats = [];
  const keep = (m) => (mats.push(m), m);
  try {
    const rgba = keep(cv.imread(c));
    const gray = keep(new cv.Mat());
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    const blur = keep(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(3, 3), 0);
    const edges = keep(new cv.Mat());
    cv.Canny(blur, edges, 30, 90);
    const E = edges.data;
    const Q = quad.map((p) => ({ x: p.x * w, y: p.y * h }));
    const r = Math.max(5, Math.round(Math.min(w, h) * 0.012));

    const lines = [];
    for (let i = 0; i < 4; i++) {
      const a = Q[i], b = Q[(i + 1) % 4];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }, n = { x: -u.y, y: u.x };
      const pts = [];
      for (let d = len * 0.08; d <= len * 0.92; d += 2) {
        // the edge pixel closest to the current estimate, searching across the side
        for (let k = 0; k <= r; k++) {
          let hit = null;
          for (const sgn of k ? [-1, 1] : [1]) {
            const x = Math.round(a.x + u.x * d + n.x * k * sgn), y = Math.round(a.y + u.y * d + n.y * k * sgn);
            if (x > 1 && y > 1 && x < w - 2 && y < h - 2 && E[y * w + x]) { hit = [x, y]; break; }
          }
          if (hit) { pts.push(hit[0], hit[1]); break; }
        }
      }
      let line = { p: a, u }; // fall back to the original side if there is not enough edge evidence
      if (pts.length >= 40) {
        const m = keep(cv.matFromArray(pts.length / 2, 1, cv.CV_32FC2, pts));
        const l = keep(new cv.Mat());
        cv.fitLine(m, l, cv.DIST_HUBER, 0, 0.01, 0.01);
        const f = l.data32F;
        const dot = Math.abs(f[0] * u.x + f[1] * u.y);
        if (dot > Math.cos((6 * Math.PI) / 180)) line = { p: { x: f[2], y: f[3] }, u: { x: f[0], y: f[1] } };
      }
      lines.push(line);
    }
    const cross = (p, q) => p.x * q.y - p.y * q.x;
    const out = Q.map((orig, i) => {
      const L1 = lines[(i + 3) % 4], L2 = lines[i];
      const den = cross(L1.u, L2.u);
      if (Math.abs(den) < 1e-3) return orig;
      const t = cross({ x: L2.p.x - L1.p.x, y: L2.p.y - L1.p.y }, L2.u) / den;
      const p = { x: L1.p.x + L1.u.x * t, y: L1.p.y + L1.u.y * t };
      return Math.hypot(p.x - orig.x, p.y - orig.y) <= r * 2.5 ? p : orig; // never wander far from the detected corner
    });
    return out.map((p) => ({ x: Math.min(1, Math.max(0, p.x / w)), y: Math.min(1, Math.max(0, p.y / h)) }));
  } catch (e) {
    console.warn('Corner refinement failed', e);
    return null;
  } finally {
    mats.forEach((m) => { try { m.delete(); } catch { /* already freed */ } });
    c.width = c.height = 0;
  }
}

let scratch = null;
/**
 * Detect the document in an <img> or <video>. Returns four normalised corners (tl, tr, br, bl) or null.
 * { live: true } uses a smaller image and fewer strategies so it can run several times a second.
 */
export function detectCorners(source, { live = false } = {}) {
  if (!cvReady()) return null;
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  if (!sw || !sh) return null;
  const side = live ? 360 : 640;
  const s = Math.min(1, side / Math.max(sw, sh));
  const w = Math.round(sw * s), h = Math.round(sh * s);
  const c = live ? (scratch ||= document.createElement('canvas')) : document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, w, h);
  try {
    const q = findDocument(window.cv, c, !live);
    if (!q || live) return q;
    return refineCorners(window.cv, source, q) || q;
  } catch (e) {
    console.warn('Detection failed', e);
    return null;
  } finally {
    if (!live) c.width = c.height = 0;
  }
}

/* ---------- fingers ---------- */
// Paint out skin that touches the rim of the straightened page (a thumb or fingers holding it). Skin well inside the page is left alone.
function removeFingers(cv, dst) {
  const w = dst.cols, h = dst.rows;
  const d = dst.data;
  const band = Math.round(Math.min(w, h) * 0.14);
  const m = new Uint8Array(w * h);
  let n = 0;
  for (let i = 0, p = 0; i < m.length; i++, p += 4) if (isSkin(d[p], d[p + 1], d[p + 2])) { m[i] = 255; n++; }
  if (n < w * h * 0.0012) return;
  const mats = [];
  const keep = (x) => (mats.push(x), x);
  try {
    const mask = keep(new cv.Mat(h, w, cv.CV_8UC1));
    mask.data.set(m);
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3))));
    const labels = keep(new cv.Mat()), stats = keep(new cv.Mat()), cents = keep(new cv.Mat());
    const cnt = cv.connectedComponentsWithStats(mask, labels, stats, cents, 8);
    const L = labels.data32S;
    const keepIds = new Set();
    for (let i = 1; i < cnt; i++) {
      const x = stats.intAt(i, 0), y = stats.intAt(i, 1), bw = stats.intAt(i, 2), bh = stats.intAt(i, 3), area = stats.intAt(i, 4);
      const touches = x < band || y < band || x + bw > w - band || y + bh > h - band;
      if (touches && area >= w * h * 0.0008 && area <= w * h * 0.25) keepIds.add(i);
    }
    if (!keepIds.size) return;
    const out = keep(new cv.Mat(h, w, cv.CV_8UC1));
    const od = new Uint8Array(w * h);
    for (let i = 0; i < od.length; i++) if (L[i] && keepIds.has(L[i])) od[i] = 255;
    out.data.set(od);
    const grow = Math.max(3, Math.round(Math.min(w, h) * 0.008)) | 1;
    cv.dilate(out, out, keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(grow * 2 + 1, grow * 2 + 1))));
    const rgb = keep(new cv.Mat());
    cv.cvtColor(dst, rgb, cv.COLOR_RGBA2RGB);
    const painted = keep(new cv.Mat());
    cv.inpaint(rgb, out, painted, 6, cv.INPAINT_TELEA);
    cv.cvtColor(painted, dst, cv.COLOR_RGB2RGBA);
  } catch (e) {
    console.warn('Finger removal skipped', e);
  } finally {
    mats.forEach((x) => { try { x.delete(); } catch { /* freed */ } });
  }
}

/* ---------- perspective correction ---------- */
// Straighten the quadrilateral into a flat rectangle, removing fingers from the rim. Falls back to a plain bounding-box crop.
export function warp(img, corners, maxDim, { fingers = true } = {}) {
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const P = corners.map((p) => ({ x: p.x * iw, y: p.y * ih }));
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let w = Math.max(d(P[0], P[1]), d(P[3], P[2]));
  let h = Math.max(d(P[0], P[3]), d(P[1], P[2]));
  const s = Math.min(1, maxDim / Math.max(w, h));
  w = Math.max(2, Math.round(w * s));
  h = Math.max(2, Math.round(h * s));
  const out = document.createElement('canvas');

  if (cvReady()) {
    const cv = window.cv;
    const mats = [];
    try {
      const src = cv.imread(img); mats.push(src);
      const a = cv.matFromArray(4, 1, cv.CV_32FC2, P.flatMap((p) => [p.x, p.y])); mats.push(a);
      const b = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]); mats.push(b);
      const M = cv.getPerspectiveTransform(a, b); mats.push(M);
      const dst = new cv.Mat(); mats.push(dst);
      cv.warpPerspective(src, dst, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
      if (fingers) removeFingers(cv, dst);
      out.width = w; out.height = h;
      cv.imshow(out, dst);
      return out;
    } catch (e) {
      console.warn('Perspective warp failed, using plain crop', e);
    } finally {
      mats.forEach((m) => { try { m.delete(); } catch { /* already freed */ } });
    }
  }

  const xs = P.map((p) => p.x), ys = P.map((p) => p.y);
  const x0 = Math.max(0, Math.min(...xs)), y0 = Math.max(0, Math.min(...ys));
  const bw = Math.min(iw, Math.max(...xs)) - x0, bh = Math.min(ih, Math.max(...ys)) - y0;
  const k = Math.min(1, maxDim / Math.max(bw, bh));
  out.width = Math.max(2, Math.round(bw * k));
  out.height = Math.max(2, Math.round(bh * k));
  out.getContext('2d').drawImage(img, x0, y0, bw, bh, 0, 0, out.width, out.height);
  return out;
}