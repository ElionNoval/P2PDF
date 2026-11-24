import { jsPDF } from 'jspdf';
import { renderPage } from './render.js';
import { tick } from './image.js';

const MARGIN = 5; // mm

// One PDF, one A4 page per image, in the order given. Aspect ratio is always preserved.
// opts.maxDim / opts.quality trade sharpness for file size (used by "Compress").
// onThumb(i, dataUrl) is called as each page finishes so the screen can fill up page by page.
export async function buildPdf(pages, mode, onProgress, opts = {}, onThumb) {
  if (!pages.length) throw new Error('No pages');
  const maxDim = opts.maxDim || 2800, quality = opts.quality || 0.92;
  let pdf = null;
  const thumbs = [];

  for (let i = 0; i < pages.length; i++) {
    onProgress?.(i + 1, pages.length);
    await tick(); // let the UI repaint between heavy pages
    const c = await renderPage(pages[i], mode, maxDim);
    const orient = c.width > c.height ? 'l' : 'p';
    if (!pdf) pdf = new jsPDF({ orientation: orient, unit: 'mm', format: 'a4', compress: true });
    else pdf.addPage('a4', orient);

    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    const k = Math.min((pw - 2 * MARGIN) / c.width, (ph - 2 * MARGIN) / c.height);
    const w = c.width * k, h = c.height * k;
    pdf.addImage(c.toDataURL('image/jpeg', quality), 'JPEG', (pw - w) / 2, (ph - h) / 2, w, h, undefined, 'FAST');

    const t = document.createElement('canvas');
    const ts = 260 / Math.max(c.width, c.height);
    t.width = Math.max(1, Math.round(c.width * ts));
    t.height = Math.max(1, Math.round(c.height * ts));
    t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
    const thumb = t.toDataURL('image/jpeg', 0.7);
    thumbs.push(thumb);
    onThumb?.(i, thumb);
    t.width = t.height = c.width = c.height = 0; // release canvas memory
  }
  return { blob: pdf.output('blob'), thumbs };
}
