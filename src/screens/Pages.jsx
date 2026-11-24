import { useEffect, useState } from 'react';
import { MAX_PAGES } from '../lib/image.js';
import { renderPage } from '../lib/render.js';
import { pageFlag } from '../lib/quality.js';

// In Clean document mode the thumbnail shows the cropped, straightened result so detection is visible.
function Thumb({ page, mode, onFlag }) {
  const [src, setSrc] = useState(page.url);
  useEffect(() => {
    if (mode !== 'clean' && !page.rotate) { setSrc(page.url); return; }
    let dead = false;
    const t = setTimeout(async () => {
      try {
        if (mode === 'clean' || page.rotate) {
          const c = await renderPage(page, mode, 420);
          if (!dead) setSrc(c.toDataURL('image/jpeg', 0.8));
          c.width = c.height = 0;
        } else if (!dead) setSrc(page.url);
      } catch { if (!dead) setSrc(page.url); }
      try {
        const plain = await renderPage({ ...page, filter: 'original', brightness: 0, contrast: 0 }, mode, 200);
        const flag = pageFlag(plain.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, plain.width, plain.height).data, plain.width, plain.height);
        plain.width = plain.height = 0;
        if (!dead) onFlag(page.id, flag);
      } catch { /* flag stays as it was */ }
    }, 60);
    return () => { dead = true; clearTimeout(t); };
  }, [mode, page.url, page.corners, page.skipCrop, page.filter, page.brightness, page.contrast, page.rotate]);
  return <img src={src} alt="" />;
}

function Lightbox({ page, mode, index, onClose, onEdit, onRetake }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const c = await renderPage(page, mode, 1400);
        if (!dead) setSrc(c.toDataURL('image/jpeg', 0.85));
        c.width = c.height = 0;
      } catch { if (!dead) setSrc(page.url); }
    })();
    return () => { dead = true; };
  }, []);
  return (
    <div className="lightbox" role="dialog" aria-label={`Page ${index + 1} preview`}>
      <div className="lb-top"><strong>Page {index + 1}</strong><button className="link light" onClick={onClose}>Close</button></div>
      <div className="lb-img">{src ? <img src={src} alt={`Page ${index + 1}`} /> : <span className="spinner" />}</div>
      <div className="lb-bar">
        <button className="btn secondary" onClick={onRetake}>Retake</button>
        <button className="btn primary" onClick={onEdit}>{mode === 'clean' ? 'Edit' : 'Open'}</button>
      </div>
    </div>
  );
}

export default function Pages({ pages, mode, setMode, cv, onRetryCv, onMove, onRemove, onEdit, onRetake, onScan, onUpload, onExport, onHome }) {
  const full = pages.length >= MAX_PAGES;
  const detecting = mode === 'clean' && cv === 'ready' && pages.some((p) => !p.detected);
  const [flags, setFlags] = useState({});
  const [view, setView] = useState(null);
  const [ask, setAsk] = useState(false);
  const onFlag = (id, f) => setFlags((o) => (o[id] === f ? o : { ...o, [id]: f }));

  const uncropped = (p) => mode === 'clean' && p.detected && (!p.corners || p.skipCrop);
  const notCropped = pages.map((p, i) => (uncropped(p) ? i : -1)).filter((i) => i >= 0);
  const flagged = pages.map((p, i) => (flags[p.id] ? i : -1)).filter((i) => i >= 0);
  const status = (p) => {
    if (mode === 'original') return { t: 'Original', c: '' };
    if (!p.detected && cv === 'ready') return { t: 'Detecting', c: '' };
    if (!p.corners) return p.detected ? { t: 'Not cropped', c: 'warn' } : { t: 'Waiting for detector', c: '' };
    return p.skipCrop ? { t: 'Not cropped', c: 'warn' } : { t: 'Cropped', c: '' };
  };
  const create = () => {
    if (notCropped.length) setAsk(true);
    else onExport();
  };

  return (
    <div className="screen pages">
      <header className="bar">
        <button className="link" onClick={onHome}>Home</button>
        <h2>Your pages</h2>
        <span />
      </header>
      <p className="count">{pages.length} of {MAX_PAGES} pages</p>

      <div className="seg" role="group" aria-label="Processing">
        <button className={mode === 'original' ? 'on' : ''} onClick={() => setMode('original')}>Original photo</button>
        <button className={mode === 'clean' ? 'on' : ''} onClick={() => setMode('clean')}>Clean document</button>
      </div>
      {mode === 'clean' && cv === 'loading' && <p className="note">Loading the document detector. Pages are cropped automatically as soon as it is ready.</p>}
      {mode === 'clean' && cv === 'failed' && (
        <p className="note warn">The detector could not load (check your connection). Set corners by hand on each page, or use Original photo. <button className="link" onClick={onRetryCv}>Try again</button></p>
      )}
      {flagged.length > 0 && (
        <p className="note warn">{flagged.length === 1 ? `Page ${flagged[0] + 1} looks` : `Pages ${flagged.map((i) => i + 1).join(', ')} look`} blank or very dark. Tap the page to check {flagged.length === 1 ? 'it' : 'them'}.</p>
      )}

      {pages.length === 0 ? (
        <p className="empty">No pages yet. Scan or upload to get started.</p>
      ) : (
        <ul className="list">
          {pages.map((p, i) => {
            const st = status(p);
            const fl = flags[p.id];
            return (
              <li className="card page" key={p.id}>
                <button className="thumb" onClick={() => setView(i)} aria-label={`Preview page ${i + 1}`}>
                  <Thumb page={p} mode={mode} onFlag={onFlag} />
                  {fl && <span className="dot" title={fl === 'blank' ? 'Looks blank' : 'Very dark'} />}
                </button>
                <div className="meta">
                  <strong>Page {i + 1}</strong>
                  <span className={`chip ${st.c}`}>{st.t}</span>
                  {fl && <span className="chip bad">{fl === 'blank' ? 'Looks blank' : 'Very dark'}</span>}
                </div>
                <div className="acts">
                  <button onClick={() => onEdit(i)}>{mode === 'clean' ? 'Edit' : 'Open'}</button>
                  <button onClick={() => onRetake(i)}>Retake</button>
                  <button disabled={i === 0} onClick={() => onMove(i, -1)} aria-label="Move up">Up</button>
                  <button disabled={i === pages.length - 1} onClick={() => onMove(i, 1)} aria-label="Move down">Down</button>
                  <button className="del" onClick={() => onRemove(i)} aria-label={`Remove page ${i + 1}`}>Remove</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="dock">
        {full ? <p className="note">Page limit reached. Remove a page to add another.</p> : (
          <div className="row">
            <button className="btn secondary" onClick={onScan}>Scan more</button>
            <button className="btn secondary" onClick={onUpload}>Upload more</button>
          </div>
        )}
        <button className="btn primary" disabled={!pages.length || detecting} onClick={create}>
          {detecting ? 'Detecting documents' : 'Create PDF'}
        </button>
      </div>
      {view !== null && pages[view] && (
        <Lightbox
          page={pages[view]} mode={mode} index={view}
          onClose={() => setView(null)}
          onEdit={() => { const i = view; setView(null); onEdit(i); }}
          onRetake={() => { const i = view; setView(null); onRetake(i); }}
        />
      )}
      {ask && (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="card sheet-box">
            <h3>{notCropped.length} page{notCropped.length > 1 ? 's' : ''} not cropped</h3>
            <p className="note">{notCropped.length > 1 ? `Pages ${notCropped.map((i) => i + 1).join(', ')} still show the table or background around the paper.` : `Page ${notCropped[0] + 1} still shows the table or background around the paper.`} Continue anyway?</p>
            <div className="row">
              <button className="btn secondary" onClick={() => { const i = notCropped[0]; setAsk(false); onEdit(i); }}>Fix page {notCropped[0] + 1}</button>
              <button className="btn primary" onClick={() => { setAsk(false); onExport(); }}>Continue anyway</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
