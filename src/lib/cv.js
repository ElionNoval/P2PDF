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

/* ---------- geometry helpers (pixel space) ---------- */
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

// Every inner angle must be roughly square, which allows for camera perspective but rejects slivers.
function looksLikeSheet(q) {
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
    if (l1 < 8 || l2 < 8) return false;
    const deg = (Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (l1 * l2)))) * 180) / Math.PI;
    if (deg < 48 || deg > 132) return false;
  }
  return true;
}

// How much of a quad's outline lies on a real edge in the image, overall and for each of its four sides.
function edgeSupport(quad, support, w, h) {
  const data = support.data;
  const sides = [];
  let hit = 0, total = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    const n = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 3));
    let sh = 0, st = 0;
    for (let j = 0; j <= n; j++) {
      const x = Math.round(a.x + ((b.x - a.x) * j) / n), y = Math.round(a.y + ((b.y - a.y) * j) / n);
      if (x <= 2 || y <= 2 || x >= w - 3 || y >= h - 3) continue; // stretches along the frame border do not count
      st++;
      if (data[y * w + x]) sh++;
    }
    sides.push(st < 8 ? 1 : sh / st);
    hit += sh; total += st;
  }
  return { all: total < 20 ? 0.5 : hit / total, sides };
}

// Turn the blobs/edges in a binary image into four-corner candidates.
// Strict mode needs four straight, well-supported sides. Relaxed mode (still photos only) tolerates a hidden corner.
function collect(cv, bin, w, h, retrieval, out, support, relaxed = false) {
  const fillMin = relaxed ? 0.65 : 0.85, fillMax = relaxed ? 1.4 : 1.15, rectMin = relaxed ? 0.75 : 0.88;
  const ladder = relaxed ? [0.01, 0.02, 0.03, 0.045, 0.065, 0.09] : [0.01, 0.02, 0.03, 0.045];
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  try {
    cv.findContours(bin, contours, hier, retrieval, cv.CHAIN_APPROX_SIMPLE);
    const frame = w * h;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      try {
        if (cv.contourArea(cnt) < frame * 0.1) continue;
        const hull = new cv.Mat();
        try {
          cv.convexHull(cnt, hull, false, true);
          const hullArea = cv.contourArea(hull);
          const peri = cv.arcLength(hull, true);
          let quad = null;
          for (const eps of ladder) {
            const ap = new cv.Mat();
            cv.approxPolyDP(hull, ap, eps * peri, true);
            const rows = ap.rows;
            if (rows === 4) quad = [0, 1, 2, 3].map((j) => ({ x: ap.data32S[j * 2], y: ap.data32S[j * 2 + 1] }));
            ap.delete();
            if (quad || rows < 4) break;
          }
          if (!quad) { // rounded corners or a ragged edge: fall back to the tightest rotated rectangle
            const r = cv.minAreaRect(hull);
            if (hullArea / (r.size.width * r.size.height) > rectMin) quad = cv.RotatedRect.points(r).map((p) => ({ x: p.x, y: p.y }));
          }
          if (!quad) continue;
          quad = orderCorners(quad.map((p) => ({ x: Math.min(w, Math.max(0, p.x)), y: Math.min(h, Math.max(0, p.y)) })));
          const qa = polyArea(quad);
          const fill = hullArea / qa;
          if (qa > frame * 0.1 && qa < frame * 0.97 && fill > fillMin && fill < fillMax && looksLikeSheet(quad)) {
            const sup = edgeSupport(quad, support, w, h);
            const ok = relaxed
              ? sup.all >= 0.4 && sup.sides.filter((v) => v >= 0.45).length >= 3
              : sup.all >= 0.6 && Math.min(...sup.sides) >= 0.35;
            if (ok) out.push({ quad, relaxed, score: Math.sqrt(qa / frame) * Math.min(fill, 1 / fill) * sup.all * sup.all });
          }
        } finally { hull.delete(); }
      } finally { cnt.delete(); }
    }
  } finally { contours.delete(); hier.delete(); }
}

// Does a candidate look like a sheet of paper? Returns a ranking factor and a yes/no verdict.
// Rejects skin-coloured regions (faces, hands, wood), very colourful regions, and shapes with no visible boundary.
function judgeSheet(cv, rgb, gray, skin, quad, w, h, kern) {
  const mats = [];
  const keep = (m) => (mats.push(m), m);
  try {
    const mask = keep(cv.Mat.zeros(h, w, cv.CV_8UC1));
    const pts = keep(cv.matFromArray(4, 1, cv.CV_32SC2, quad.flatMap((p) => [Math.round(p.x), Math.round(p.y)])));
    const mv = keep(new cv.MatVector());
    mv.push_back(pts);
    cv.fillPoly(mask, mv, new cv.Scalar(255));
    const eroded = keep(new cv.Mat()), outer = keep(new cv.Mat()), ring = keep(new cv.Mat()), band = keep(new cv.Mat());
    cv.erode(mask, eroded, kern);
    cv.dilate(mask, outer, kern);
    cv.subtract(outer, mask, ring); // thin band just outside the outline
    cv.subtract(mask, eroded, band); // thin band just inside the outline
    if (cv.countNonZero(band) < 50 || cv.countNonZero(ring) < 50 || cv.countNonZero(eroded) < 50) return { ok: false, bright: 0, sat: 1, prior: 0 };

    // Skin tones inside the shape: a face, a hand or a wooden table is not a document.
    const skinIn = keep(new cv.Mat());
    cv.bitwise_and(skin, eroded, skinIn);
    const skinFrac = cv.countNonZero(skinIn) / cv.countNonZero(eroded);

    // Compare the band just inside with the band just outside, so a mat that merely contains a sheet is not mistaken for one.
    const gi = cv.mean(gray, band)[0], go = cv.mean(gray, ring)[0];
    const ci = cv.mean(rgb, band), co = cv.mean(rgb, ring);
    const colourDist = Math.hypot(ci[0] - co[0], ci[1] - co[1], ci[2] - co[2]);
    const mx = Math.max(ci[0], ci[1], ci[2]), mn = Math.min(ci[0], ci[1], ci[2]);
    const sat = mx > 0 ? (mx - mn) / mx : 0;

    const boundaryVisible = Math.abs(gi - go) >= 10 || colourDist >= 25;
    const ok = skinFrac <= 0.4 && sat <= 0.7 && boundaryVisible;

    const diff = Math.max(-1, Math.min(1, (gi - go) / 40));
    const contrast = Math.max(0, Math.min(1, (gi - go) / 30)); // only a brighter inside counts
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const sa = (d(quad[0], quad[1]) + d(quad[3], quad[2])) / 2, sb = (d(quad[1], quad[2]) + d(quad[0], quad[3])) / 2;
    const ratio = Math.max(sa, sb) / Math.min(sa, sb);
    const paperLike = [1.414, 1.294, 1.0, 1.5, 1.586].some((t) => Math.abs(ratio - t) < 0.07 * t) ? 1.06 : 1;
    return { ok, bright: gi - go, sat, prior: (1 + 0.5 * diff + 0.15 * (1 - Math.min(1, sat / 0.5)) + 0.1 * contrast) * paperLike };
  } finally {
    mats.forEach((m) => { try { m.delete(); } catch { /* already freed */ } });
  }
}

// Finds the most document-like four-corner shape in an RGBA canvas, or null if nothing convincing is there.
// `thorough` adds extra strategies and tolerates a partly hidden page; the live preview stays strict and fast.
function findDocument(cv, canvas, thorough) {
  const w = canvas.width, h = canvas.height;
  const mats = [];
  const keep = (m) => (mats.push(m), m);
  const cands = [];
  const jobs = []; // binary images to harvest shapes from
  try {
    const rgba = keep(cv.imread(canvas));
    const rgb = keep(new cv.Mat());
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    const gray = keep(new cv.Mat());
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    const blur = keep(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    const k5 = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
    const k3 = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    const support = keep(new cv.Mat());
    cv.Canny(blur, support, 20, 60);
    cv.dilate(support, support, k5);

    // 1) Edges on brightness
    for (const [lo, hi] of thorough ? [[25, 80], [50, 140]] : [[40, 120]]) {
      const e = keep(new cv.Mat());
      cv.Canny(blur, e, lo, hi);
      cv.dilate(e, e, k3);
      jobs.push([e, cv.RETR_LIST]);
    }
    // 2) Bright (or dark) sheet against its surroundings
    const bin = keep(new cv.Mat());
    cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k5);
    cv.morphologyEx(bin, bin, cv.MORPH_OPEN, k5);
    jobs.push([bin, cv.RETR_EXTERNAL]);
    if (thorough) {
      const inv = keep(new cv.Mat());
      cv.bitwise_not(bin, inv);
      jobs.push([inv, cv.RETR_EXTERNAL]);
      // 3) Local contrast (handles uneven lighting and low-contrast edges)
      const clahe = new cv.CLAHE(3.0, new cv.Size(8, 8));
      const eq = keep(new cv.Mat());
      clahe.apply(gray, eq);
      clahe.delete();
      const eb = keep(new cv.Mat()), ee = keep(new cv.Mat());
      cv.GaussianBlur(eq, eb, new cv.Size(5, 5), 0);
      cv.Canny(eb, ee, 40, 110);
      cv.dilate(ee, ee, k3);
      jobs.push([ee, cv.RETR_LIST]);
      // 4) Edges per colour channel: paper with the same brightness as the table but another hue
      const planes = keep(new cv.MatVector());
      cv.split(rgb, planes);
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

    for (const [m, r] of jobs) collect(cv, m, w, h, r, cands, support);
    if (!cands.length && thorough) for (const [m, r] of jobs) collect(cv, m, w, h, r, cands, support, true); // partly hidden page
    if (!cands.length) return null;
    cands.sort((a, b) => b.score - a.score);

    // Skin-tone map (hue and saturation) used to rule out faces, hands and wood.
    const hsv = keep(new cv.Mat());
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const lo = keep(new cv.Mat(h, w, cv.CV_8UC3, new cv.Scalar(0, 45, 60)));
    const hi = keep(new cv.Mat(h, w, cv.CV_8UC3, new cv.Scalar(16, 170, 255)));
    const skin = keep(new cv.Mat());
    cv.inRange(hsv, lo, hi, skin);

    // Judge the strongest few distinct shapes; keep only those that really look like a sheet, best first.
    const kern = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(...Array(2).fill(Math.max(5, Math.round(Math.min(w, h) * 0.03) | 1)))));
    const seen = [];
    const judged = [];
    for (const c of cands) {
      if (judged.length >= 6) break;
      const dup = seen.some((q) => q.reduce((sum, p, i) => sum + Math.hypot(p.x - c.quad[i].x, p.y - c.quad[i].y), 0) / 4 < Math.min(w, h) * 0.03);
      if (dup) continue;
      seen.push(c.quad);
      const v = judgeSheet(cv, rgb, gray, skin, c.quad, w, h, kern);
      // A page found only by the relaxed pass must be unmistakably paper: bright, plain, and fully inside the frame.
      const m = Math.min(w, h) * 0.02;
      const inside = c.quad.every((p) => p.x > m && p.y > m && p.x < w - m && p.y < h - m);
      if (c.relaxed && !(v.bright >= 20 && v.sat <= 0.3 && inside)) continue;
      if (v.ok) judged.push({ quad: c.quad, final: c.score * v.prior });
    }
    if (!judged.length) return null; // nothing convincing: better to show nothing than something wrong
    judged.sort((a, b) => b.final - a.final);
    return judged[0].quad.map((p) => ({ x: p.x / w, y: p.y / h }));
  } finally {
    mats.forEach((m) => { try { m.delete(); } catch { /* already freed */ } });
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
    return findDocument(window.cv, c, !live);
  } catch (e) {
    console.warn('Detection failed', e);
    return null;
  } finally {
    if (!live) c.width = c.height = 0;
  }
}

/* ---------- perspective correction ---------- */
// Straighten the quadrilateral into a flat rectangle. Falls back to a plain bounding-box crop.
export function warp(img, corners, maxDim) {
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
