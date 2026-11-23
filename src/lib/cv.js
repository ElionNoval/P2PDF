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
  minArea: 0.08,        // a document must fill at least this share of the frame
  maxArea: 0.9,         // ...and not more than this (a bed or a wall fills the frame, a sheet does not)
  marginLive: 0.012,    // live: every corner must sit this far inside the frame (share of the short side)
  marginStill: 0.004,   // photos: slightly more forgiving
  angleMin: 62, angleMax: 118, // inner corner angles of a sheet, perspective included
  sideRatioMin: 0.5,    // opposite sides must be of similar length
  aspectMax: 2.3,       // longest/shortest side
  sideSupport: 0.6,     // each visible side: share of its length lying on a real, straight, matching edge
  meanSupport: 0.72,    // average over the visible sides
  minContrast: 7,       // grey-level step across a side (inside brighter than outside)
  paperMinGrey: 70,     // not a dark object (screen off, black cover)
  paperUniform: 0.5,    // share of the interior that is one flat colour (any colour: white, blue, pink...)
  coarseMax: 0.17,      // blankets, folds and pillows vary a lot more than a sheet of paper does
  skinCenter: 0.1,      // skin-coloured area in the middle of the page that is NOT the page's own colour: a hand, a face
  skinTotal: 0.3,       // fingers may only cover the rim
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
  if (s < 0.27 || s > 0.75) return false; // shaded white paper under warm light is only ~0.22 saturated
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

// Total length of long lines that do not follow the page sides (folds, creases, pillow edges), in units of the short side.
function offAxisLength(cv, S, quad) {
  const { w, h } = S;
  const centre = shrink(quad, 0.9);
  const minSide = Math.min(dist(quad[0], quad[1]), dist(quad[1], quad[2]), dist(quad[2], quad[3]), dist(quad[3], quad[0]));
  const mats = [];
  const keep = (m) => (mats.push(m), m);
  let off2 = 0;
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
  } finally { mats.forEach((m) => { try { m.delete(); } catch { /* freed */ } }); }
  return off2 / minSide;
}

/* ---------- judging a candidate ---------- */
// Median brightness and main colour of the middle of a candidate.
function pageTone(S, quad) {
  const { w, h } = S;
  const centre = shrink(quad, 0.9);
  const hist = new Uint32Array(256);
  let nC = 0;
  scan(centre, w, h, (x, y) => { hist[S.gray[y * w + x]]++; nC++; });
  if (nC < 60) return null;
  let acc = 0, med = 0;
  while (med < 255 && (acc += hist[med]) < nC / 2) med++;
  let rr = 0, gg = 0, bb = 0, nr = 0;
  scan(centre, w, h, (x, y) => { const i = y * w + x; if (Math.abs(S.gray[i] - med) <= 10) { rr += S.rgb[i * 3]; gg += S.rgb[i * 3 + 1]; bb += S.rgb[i * 3 + 2]; nr++; } });
  if (!nr) return null;
  return { med, rr: rr / nr, gg: gg / nr, bb: bb / nr, nC, ctol: Math.max(40, med * 0.22) };
}

// Everything below looks at the candidate the way a person would: are the four sides real, straight, matching edges?
// Is the inside flat, plain paper rather than a blanket, a table, a face or a hand?
function judge(cv, S, quad, wantLines) {
  const { w, h } = S;
  const minDim = Math.min(w, h);
  const c = centroid(quad);
  const r = Math.max(2, Math.round(minDim * 0.012)); // search distance across a side
  const off = Math.max(4, Math.round(minDim * 0.02)); // compare the paper just inside with the surface just outside
  const fail = (why) => ({ ok: false, why, conf: 0 });
  const tone = pageTone(S, quad);
  if (!tone) return fail('too small');
  // skin-coloured pixels count as a finger only if they differ from the page's own colour (an orange cover is not a hand)
  const finger = (i) => S.skin[i] && Math.hypot(S.rgb[i * 3] - tone.rr, S.rgb[i * 3 + 1] - tone.gg, S.rgb[i * 3 + 2] - tone.bb) > tone.ctol;
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
      if (finger(yi * w + xi) || finger(Math.round(py + n.y * 2) * w + Math.round(px + n.x * 2))) { hid++; continue; } // a finger over the rim
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
  // every visible side must sit on a real edge; one side may be faint (low contrast against the table) if the others are solid
  const weakSides = vis.filter((s) => s.sup < T.sideSupport);
  const solidOthers = (w0) => vis.every((s) => s === w0 || s.sup >= 0.8);
  if (weakSides.length > 1 || weakSides.some((s) => s.sup < (solidOthers(s) ? 0.12 : 0.3)) || (weakSides.length === 1 && vis.some((s) => s !== weakSides[0] && s.sup < 0.7)))
    return fail('weak side ' + sides.map((s) => s.valid ? s.sup.toFixed(2) : 'x').join('/'));
  const meanSup = vis.reduce((s, v) => s + v.sup, 0) / vis.length;
  if (meanSup < T.meanSupport) return fail('low support');
  if (vis.filter((s) => Math.abs(s.contrast) < T.minContrast && s.cdist < 18).length > 1) return fail('no boundary'); // one faint side (a gutter) is fine
  const contrast = vis.reduce((s, v) => s + Math.abs(v.contrast), 0) / vis.length;
  const sharpness = vis.reduce((s, v) => s + v.sharp, 0) / vis.length;
  if (sharpness < T.sharpMin) return fail('soft outline ' + sharpness.toFixed(2));
  if (contrast < T.minContrast * 0.8 && vis.reduce((s, v) => s + v.cdist, 0) / vis.length < 30) return fail('flat contrast');

  // four crisp, straight, matching edges: a printed cover, a laminated card, a photo page. The inside can be anything but mostly skin.
  if (vis.length === 4 && vis.every((s) => s.sup >= 0.8) && meanSup >= 0.88 && sharpness >= 0.4) {
    let nK = 0, kS = 0;
    scan(shrink(quad, 0.7), w, h, (x, y) => { nK++; if (S.skinBig[y * w + x]) kS++; });
    if (nK < 100) return fail('too small');
    if (kS / nK > 0.3) return fail('mostly skin');
    if (wantLines && offAxisLength(cv, S, quad) > 3.5) return fail('creases / folds (framed)');
    let nU = 0, nIn = 0; // how much of the inside is the page's main colour: the true page outline is flatter than one that swallowed some table
    scan(shrink(quad, 0.92), w, h, (x, y) => { nU++; const i = y * w + x; if (Math.hypot(S.rgb[i * 3] - tone.rr, S.rgb[i * 3 + 1] - tone.gg, S.rgb[i * 3 + 2] - tone.bb) <= tone.ctol) nIn++; });
    const uniF = nU ? nIn / nU : 0;
    return { ok: true, why: 'ok framed', conf: 0.4 + 0.25 * meanSup + 0.1 * clamp01(contrast / 40) + 0.25 * uniF };
  }

  // inside the page: tone, colour, uniformity, coarse variation, skin
  const centre = shrink(quad, 0.9), whole = shrink(quad, 0.97), core = shrink(quad, 0.7);
  const { med, rr, gg, bb, nC, ctol } = tone;
  if (med < T.paperMinGrey) return fail('too dark');
  const pageSat = (Math.max(rr, gg, bb) - Math.min(rr, gg, bb)) / Math.max(1, Math.max(rr, gg, bb));
  if (pageSat > 0.25 && isSkin(Math.round(rr), Math.round(gg), Math.round(bb))) return fail('page is skin coloured');
  let near = 0, cs = 0, cq = 0;
  scan(centre, w, h, (x, y) => {
    const i = y * w + x;
    if (Math.hypot(S.rgb[i * 3] - rr, S.rgb[i * 3 + 1] - gg, S.rgb[i * 3 + 2] - bb) <= ctol) { near++; const v = S.coarse[i]; cs += v; cq += v * v; }
  });
  const uni = near / nC;
  if (uni < T.paperUniform) return fail('not a flat page ' + uni.toFixed(2));
  const mean = cs / near, coarseStd = Math.sqrt(Math.max(0, cq / near - mean * mean)) / Math.max(1, mean); // measured on paper pixels only, so print and ink do not count
  if (coarseStd > T.coarseMax) return fail('uneven ' + coarseStd.toFixed(2));

  let nCore = 0, skinCore = 0, nAll = 0, skinAll = 0;
  const offPage = (i) => Math.hypot(S.rgb[i * 3] - rr, S.rgb[i * 3 + 1] - gg, S.rgb[i * 3 + 2] - bb) > ctol; // skin that is not just the page's own tint
  scan(core, w, h, (x, y) => { nCore++; const i = y * w + x; if (S.skinBig[i] && offPage(i)) skinCore++; });
  scan(whole, w, h, (x, y) => { nAll++; const i = y * w + x; if (S.skinBig[i] && offPage(i)) skinAll++; });
  if (nCore && skinCore / nCore > T.skinCenter) return fail('skin in the middle');
  if (nAll && skinAll / nAll > T.skinTotal) return fail('too much skin');

  // long lines that do not follow the page sides are folds and pillows, not paper
  const off2 = wantLines ? offAxisLength(cv, S, quad) : 0;
  if (off2 > T.offAxisMax) return fail('creases / folds');

  const conf = 0.38 * meanSup + 0.2 * clamp01((uni - 0.4) / 0.5) + 0.15 * clamp01(contrast / 40) + 0.15 * (1 - clamp01(coarseStd / 0.2)) + 0.12 * clamp01(1 - off2 / T.offAxisMax);
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
  const hEdge = keep(new cv.Mat());
  cv.Canny(blur3, hEdge, 40, 110);

  const rgb = rgbM.data.slice();
  const n = w * h;
  const skin = new Uint8Array(n), paper = new Uint8Array(n), sat = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const R = rgb[p], G = rgb[p + 1], B = rgb[p + 2];
    { const mxs = Math.max(R, G, B); sat[i] = mxs ? ((mxs - Math.min(R, G, B)) * 255) / mxs : 0; }
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
  // only palm- or face-sized skin blobs count for the 'skin in the middle' test; small orange or red print does not
  const kb = Math.max(5, Math.round(Math.min(w, h) * 0.035) | 1);
  const skinBigM = keep(new cv.Mat());
  cv.morphologyEx(skinM, skinBigM, cv.MORPH_OPEN, keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kb, kb))));
  const skinBig = skinBigM.data.slice();
  return {
    w, h, rgb, gray: blur3.data.slice(), gx: gxM.data32F.slice(), gy: gyM.data32F.slice(), coarse: coarseM.data.slice(),
    skin: skinClean, skinBig, skinD, fineEdges: fine, hEdge, paperM: mk(paper), satM: mk(sat), blur: blur3, rgbM, grayM, k5,
    skinNear: (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi >= 0 && yi >= 0 && xi < w && yi < h && !!skinDd[yi * w + xi]; },
  };
}

// Share of a side lying on a straight edge that runs along it (same test as in judge, without the extras).
function edgeSup(S, a, b, maxSteps, gmin = 24) {
  const { w, h } = S;
  const len = dist(a, b);
  if (len < 8) return 0;
  const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }, n = { x: -u.y, y: u.x };
  const r = Math.max(2, Math.round(Math.min(w, h) * 0.012));
  const steps = maxSteps ? Math.min(maxSteps, Math.max(6, Math.round(len / 2))) : Math.max(10, Math.round(len / 2));
  let tot = 0, hit = 0;
  for (let j = 0; j <= steps; j++) {
    const t = 0.04 + (0.92 * j) / steps;
    const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
    tot++;
    for (let k = -r; k <= r; k++) {
      const x = Math.round(px + n.x * k), y = Math.round(py + n.y * k);
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      const idx = y * w + x, gx = S.gx[idx], gy = S.gy[idx];
      const gm = Math.hypot(gx, gy);
      if (gm >= gmin && Math.abs(gx * n.x + gy * n.y) >= 0.85 * gm) { hit++; break; }
    }
  }
  return hit / tot;
}

// A page whose corner is dark (a green cover corner, a shadow) comes out slightly short. Nudge each corner to where
// the two adjacent sides sit on the strongest straight edges, in a few shrinking steps, never leaving a sheet-like shape.
function growQuad(S, quad) {
  const { w, h } = S;
  const minDim = Math.min(w, h);
  const q = quad.map((p) => ({ ...p }));
  const score = (z) => z.reduce((t, p, i) => t + edgeSup(S, p, z[(i + 1) % 4], 16), 0) + (0.4 * polyArea(z)) / (w * h);
  let cur = score(q);
  for (const step of [0.035, 0.018, 0.009]) {
    for (let it = 0; it < 2; it++) {
      for (let i = 0; i < 4; i++) {
        let bp = q[i], bs = cur;
        for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
          if (!dx && !dy) continue;
          const p = { x: q[i].x + dx * step * minDim, y: q[i].y + dy * step * minDim };
          const z = q.slice(); z[i] = p;
          if (!looksLikeSheet(z, w, h, T.marginStill)) continue;
          const sc = score(z);
          if (sc > bs + 0.02) { bs = sc; bp = p; }
        }
        if (bp !== q[i]) { q[i] = bp; cur = bs; }
      }
    }
  }
  return q;
}

// Candidates from straight lines instead of blobs: works on a busy table, a patterned cloth or a hand, where the page and its
// surroundings merge into one blob. Long segments are merged into lines, then every plausible "two pairs of parallel lines"
// rectangle is scored by how much of its outline lies on a real edge.
function lineCandidates(cv, S, out, margin) {
  const { w, h } = S;
  const minDim = Math.min(w, h);
  const segs = new cv.Mat();
  try {
    const minLen = Math.round(minDim * 0.22);
    cv.HoughLinesP(S.hEdge, segs, 1, Math.PI / 180, Math.max(20, Math.round(minLen * 0.55)), minLen, Math.max(3, Math.round(minDim * 0.03)));
    const d = segs.data32S;
    const raw = [];
    for (let i = 0; i < segs.rows; i++) {
      const a = { x: d[i * 4], y: d[i * 4 + 1] }, b = { x: d[i * 4 + 2], y: d[i * 4 + 3] };
      const len = dist(a, b);
      if (len > 0) raw.push({ a, b, len, u: { x: (b.x - a.x) / len, y: (b.y - a.y) / len } });
    }
    // straight stretches of the traced edges (more reliable than Hough on small frames)
    const cs = new cv.MatVector(), hier = new cv.Mat();
    try {
      cv.findContours(S.hEdge, cs, hier, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);
      const eps = Math.max(2, minDim * 0.012);
      for (let i = 0; i < cs.size(); i++) {
        const cnt = cs.get(i);
        try {
          if (cnt.rows < minLen) continue;
          const ap = new cv.Mat();
          cv.approxPolyDP(cnt, ap, eps, false);
          const q = ap.data32S;
          for (let j = 0; j + 1 < ap.rows; j++) {
            const a = { x: q[j * 2], y: q[j * 2 + 1] }, b = { x: q[j * 2 + 2], y: q[j * 2 + 3] };
            const len = dist(a, b);
            if (len >= minLen * 0.8) raw.push({ a, b, len, u: { x: (b.x - a.x) / len, y: (b.y - a.y) / len } });
          }
          ap.delete();
        } finally { cnt.delete(); }
      }
    } finally { cs.delete(); hier.delete(); }
    raw.sort((p, q) => q.len - p.len);
    const tolD = minDim * 0.025;
    const cross = (p, q) => p.x * q.y - p.y * q.x;
    const groups = [];
    for (const sg of raw.slice(0, 260)) {
      const g = groups.find((G) =>
        Math.abs(cross(G.u, sg.u)) < 0.09 &&
        Math.abs(cross({ x: sg.a.x - G.p.x, y: sg.a.y - G.p.y }, G.u)) < tolD &&
        Math.abs(cross({ x: sg.b.x - G.p.x, y: sg.b.y - G.p.y }, G.u)) < tolD);
      if (g) { g.len += sg.len; g.pts.push(sg.a.x, sg.a.y, sg.b.x, sg.b.y); } else groups.push({ p: sg.a, u: sg.u, len: sg.len, pts: [sg.a.x, sg.a.y, sg.b.x, sg.b.y] });
    }
    const lines = groups.sort((p, q) => q.len - p.len).slice(0, 26).map((G) => {
      if (G.pts.length >= 8) {
        const m = cv.matFromArray(G.pts.length / 2, 1, cv.CV_32FC2, G.pts), l = new cv.Mat();
        try {
          cv.fitLine(m, l, cv.DIST_HUBER, 0, 0.01, 0.01);
          const f = l.data32F;
          if (Math.abs(f[0] * G.u.x + f[1] * G.u.y) > 0.99) return { p: { x: f[2], y: f[3] }, u: { x: f[0], y: f[1] }, len: G.len };
        } finally { m.delete(); l.delete(); }
      }
      return G;
    });
    if (lines.length < 4) return;
    // pairs of roughly parallel lines that are far enough apart to be two sides of a page
    const pairs = [];
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
      const A = lines[i], B = lines[j];
      if (Math.abs(cross(A.u, B.u)) > 0.42) continue;
      if (Math.abs(cross({ x: B.p.x - A.p.x, y: B.p.y - A.p.y }, A.u)) < minDim * 0.2) continue;
      pairs.push([A, B]);
    }
    const hit = (A, B) => {
      const den = cross(A.u, B.u);
      if (Math.abs(den) < 0.77) return null; // the two families must be near-perpendicular (perspective allowed)
      const t = cross({ x: B.p.x - A.p.x, y: B.p.y - A.p.y }, B.u) / den;
      return { x: A.p.x + A.u.x * t, y: A.p.y + A.u.y * t };
    };
    const found = [];
    for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
      const [a, b] = pairs[i], [c, dd] = pairs[j];
      if (a === c || a === dd || b === c || b === dd) continue;
      const p1 = hit(a, c), p2 = hit(a, dd), p3 = hit(b, dd), p4 = hit(b, c);
      if (!p1 || !p2 || !p3 || !p4) continue;
      const q = orderCorners([p1, p2, p3, p4]);
      const qa = polyArea(q);
      if (qa < w * h * T.minArea || qa > w * h * T.maxArea || !looksLikeSheet(q, w, h, margin)) continue;
      let sup = 0, mn = 1;
      for (let k = 0; k < 4; k++) { const e = edgeSup(S, q[k], q[(k + 1) % 4], 12); sup += e; if (e < mn) mn = e; }
      sup /= 4;
      if (mn < 0.4 || sup < 0.65) continue;
      found.push({ quad: q, pre: 0.7 * sup + 0.3 * Math.sqrt(qa / (w * h)) });
    }
    // three solid sides and a faint or hidden fourth (the gutter of an open book, a page running past the frame):
    // slide the fourth side along and keep the position that sits on the best edge
    const strong = lines.slice(0, 10);
    for (const [a, b] of pairs.slice(0, 45)) {
      for (const c of strong) {
        if (c === a || c === b) continue;
        const pa = hit(a, c), pb = hit(b, c);
        if (!pa || !pb) continue;
        const cl = dist(pa, pb);
        if (cl < minDim * 0.25) continue;
        const ua = a.u, ub = cross(a.u, b.u) !== 0 && a.u.x * b.u.x + a.u.y * b.u.y < 0 ? { x: -b.u.x, y: -b.u.y } : b.u;
        for (const sg of [1, -1]) {
          let bq = null, bs = 0, bp = null;
          for (let f = 0.35; f <= 2.3; f += 0.075) {
            const pa2 = { x: pa.x + ua.x * sg * f * cl, y: pa.y + ua.y * sg * f * cl };
            const pb2 = { x: pb.x + ub.x * sg * f * cl, y: pb.y + ub.y * sg * f * cl };
            const q = orderCorners([pa, pa2, pb2, pb]);
            const qa = polyArea(q);
            if (qa < w * h * T.minArea || qa > w * h * T.maxArea || !looksLikeSheet(q, w, h, margin)) continue;
            const e = edgeSup(S, pa2, pb2, 12, 9); // faint edges count here (a gutter is only a few grey levels)
            if (e > bs) { bs = e; bq = q; bp = [pa2, pb2]; }
          }
          if (!bq || bs < 0.55) continue;
          // the other three sides must be solid; the sliding one may be faint
          const e1 = edgeSup(S, pa, bp[0], 12), e2 = edgeSup(S, pb, bp[1], 12), e3 = edgeSup(S, pa, pb, 12);
          const sup = (e1 + e2 + e3) / 3, mn3 = Math.min(e1, e2, e3);
          if (sup < 0.7 || mn3 < 0.55) continue;
          found.push({ quad: bq, pre: 0.7 * sup + 0.3 * Math.sqrt(polyArea(bq) / (w * h)) });
        }
      }
    }
    found.sort((p, q) => q.pre - p.pre);
    for (const f of found.slice(0, 10)) out.push(f);
  } catch (e) {
    console.warn('Line candidates failed', e);
  } finally { segs.delete(); }
}

// Finds the most document-like four-corner shape in an RGBA canvas, or null if nothing convincing is there.
// `thorough` adds extra strategies for still photos; the live preview stays strict and fast.
// `hint` is the page found in the previous live frame (normalised): if it is still there it is confirmed without a new search.
export function findDocument(cv, canvas, thorough, debug, hint, grow) {
  const mats = [];
  const keep = (m) => (mats.push(m), m);
  try {
    const S = prepare(cv, canvas, keep);
    const { w, h } = S;
    const margin = thorough ? T.marginStill : T.marginLive;
    const toNorm = (q) => q.map((p) => ({ x: p.x / w, y: p.y / h }));
    const k3 = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));

    // fast path: the page found in the previous frame is still there, so just re-check it
    if (hint) {
      const hq = hint.map((p) => ({ x: p.x * w, y: p.y * h }));
      if (looksLikeSheet(hq, w, h, margin)) {
        const v = judge(cv, S, hq, false); // already vetted when it was first found: skip the slow crease check
        if (v.ok) return debug ? { quad: toNorm(hq), conf: v.conf, why: ['hint'] } : toNorm(hq);
      }
    }

    const seen = [], verdicts = [];
    let best = null;
    const pre = [];
    const evaluate = (jobs, limit) => {
      const cands = pre.splice(0);
      for (const [m, r] of jobs) collect(cv, m, S, r, cands, margin);
      cands.sort((a, b) => b.pre - a.pre);
      let tried = 0;
      for (const c of cands) {
        if (tried >= limit) break;
        if (seen.some((q) => q.reduce((t, p, i) => t + dist(p, c.quad[i]), 0) / 4 < Math.min(w, h) * 0.03)) continue;
        seen.push(c.quad);
        tried++;
        let v = judge(cv, S, c.quad, true), q = c.quad;
        // an outline that swallowed the page's shadow or a loose margin: try it pulled in a little
        if (!v.ok && /weak|mixed|boundary|support|contrast|soft/.test(v.why)) {
          for (const f of [0.985, 0.97]) {
            const q2 = shrink(c.quad, f), v2 = judge(cv, S, q2, true);
            if (v2.ok) { v = v2; q = q2; break; }
          }
        }
        verdicts.push(v.why);
        const rank = v.conf + 0.1 * Math.sqrt(polyArea(q) / (w * h)); // among equals, prefer the bigger page
        if (v.ok && (!best || rank > best.rank)) best = { quad: q, conf: v.conf, rank };
      }
    };

    // stage 1 (cheap): a flat region against its surroundings, in brightness or in colour, skin cut out; plus plain edges
    const pm = keep(new cv.Mat());
    cv.subtract(S.paperM, S.skinD, pm);
    cv.morphologyEx(pm, pm, cv.MORPH_OPEN, S.k5);
    cv.morphologyEx(pm, pm, cv.MORPH_CLOSE, S.k5);
    const bin = keep(new cv.Mat());
    cv.threshold(S.blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.subtract(bin, S.skinD, bin);
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, S.k5);
    cv.morphologyEx(bin, bin, cv.MORPH_OPEN, S.k5);
    const sb = keep(new cv.Mat()), sbi = keep(new cv.Mat());
    cv.threshold(S.satM, sb, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU); // coloured page on a plain table
    cv.bitwise_not(sb, sbi);                                              // plain page on a coloured table
    for (const m of [sb, sbi]) { cv.subtract(m, S.skinD, m); cv.morphologyEx(m, m, cv.MORPH_CLOSE, S.k5); cv.morphologyEx(m, m, cv.MORPH_OPEN, S.k5); }
    const e1 = keep(new cv.Mat());
    cv.Canny(S.blur, e1, 40, 120);
    cv.dilate(e1, e1, k3);
    lineCandidates(cv, S, pre, margin);
    evaluate([[bin, cv.RETR_EXTERNAL], [pm, cv.RETR_EXTERNAL], [e1, cv.RETR_LIST], [sb, cv.RETR_EXTERNAL], [sbi, cv.RETR_EXTERNAL]], thorough ? 8 : 6);

    // stage 2 (photos only, and only when stage 1 found nothing): the slower strategies
    if (!best && thorough) {
      const jobs = [];
      for (const [lo, hi] of [[25, 80], [50, 140]]) {
        const e = keep(new cv.Mat());
        cv.Canny(S.blur, e, lo, hi);
        cv.dilate(e, e, k3);
        jobs.push([e, cv.RETR_LIST]);
      }
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
        const pl = planes.get(i);
        const b = new cv.Mat(), e = new cv.Mat();
        cv.GaussianBlur(pl, b, new cv.Size(5, 5), 0);
        cv.Canny(b, e, 30, 90);
        if (i === 0) e.copyTo(merged); else cv.bitwise_or(merged, e, merged);
        pl.delete(); b.delete(); e.delete();
      }
      cv.dilate(merged, merged, k3);
      jobs.push([merged, cv.RETR_LIST]);
      evaluate(jobs, 8);
    }

    if (best) { // pull short corners out to the real page edge; keep the result only if it is still convincing
      const g = growQuad(S, best.quad);
      const v = judge(cv, S, g, true);
      if (v.ok) best = { quad: g, conf: Math.max(v.conf, best.conf), rank: best.rank };
    }
    if (debug) return { quad: best ? toNorm(best.quad) : null, conf: best?.conf, why: verdicts.length ? verdicts : ['no candidates'] };
    return best ? toNorm(best.quad) : null; // nothing convincing: better to show nothing than something wrong
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
 * { live: true } uses a smaller image and fewer strategies so it can run many times a second.
 * { hint } (live only) is the previous frame's result, re-checked first for a much faster lock.
 */
export function detectCorners(source, { live = false, hint = null } = {}) {
  if (!cvReady()) return null;
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  if (!sw || !sh) return null;
  // photos: a quick small pass first (usually enough), then the thorough one only if that found nothing
  const passes = live ? [[70000, false]] : [[70000, false], [250000, true]];
  const c = live ? (scratch ||= document.createElement('canvas')) : document.createElement('canvas');
  try {
    let q = null;
    for (const [side, thorough] of passes) {
      const s = Math.min(1, Math.sqrt(side / (sw * sh)));
      c.width = Math.round(sw * s); c.height = Math.round(sh * s);
      c.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, c.width, c.height);
      q = findDocument(window.cv, c, thorough, false, live ? hint : null, !live);
      if (q) break;
    }
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