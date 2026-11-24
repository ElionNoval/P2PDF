// Quick checks on a small render of a page so the Your pages list can flag pages worth a second look.
// data = RGBA pixels (ImageData.data). Returns 'blank', 'dark' or ''.
export function pageFlag(data, w, h) {
  const n = w * h;
  if (n < 100) return '';
  const g = new Uint8Array(n);
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) | 0;
    g[i] = v; hist[v]++; sum += v;
  }
  if (sum / n < 70) return 'dark';
  let acc = 0, med = 0;
  while (med < 255 && (acc += hist[med]) < n / 2) med++;
  let content = 0;
  for (let i = 0; i < n; i++) if (Math.abs(g[i] - med) > 45) content++;
  return content / n < 0.003 ? 'blank' : '';
}
