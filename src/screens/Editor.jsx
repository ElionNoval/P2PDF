import { useEffect, useRef, useState } from 'react';
import { detectCorners } from '../lib/cv.js';
import { loadImg, tick } from '../lib/image.js';
import { renderPage, DEFAULT_EDITS } from '../lib/render.js';

const FILTERS = [['original', 'Original'], ['auto', 'Auto Enhance'], ['gray', 'Grayscale'], ['bw', 'Black & White']];
const DEFAULT_CORNERS = [{ x: 0.08, y: 0.08 }, { x: 0.92, y: 0.08 }, { x: 0.92, y: 0.92 }, { x: 0.08, y: 0.92 }];
const clamp = (v) => Math.min(1, Math.max(0, v));
const shown = (v) => Math.round(50 + (v * 50) / 60);

export default function Editor({ page, index, total, mode, cv, onChange, onApplyAll, onBack }) {
  const clean = mode === 'clean';
  const [tab, setTab] = useState('crop');
  const [preview, setPreview] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [compare, setCompare] = useState(false);
  const wrap = useRef(null);
  const autoTried = useRef(false);
  const cropping = !!page.corners && !page.skipCrop;

  // Live preview of the result (crop + filter) on a small copy.
  useEffect(() => {
    if (clean && tab !== 'enhance') return;
    let dead = false;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const c = await renderPage(page, mode, 900);
        if (!dead) setPreview(c.toDataURL('image/jpeg', 0.8));
        c.width = c.height = 0;
      } catch { if (!dead) setMsg('The preview could not be created.'); }
      if (!dead) setBusy(false);
    }, 120);
    return () => { dead = true; clearTimeout(t); };
  }, [tab, clean, page.corners, page.skipCrop, page.filter, page.brightness, page.contrast, page.rotate]);

  const detect = async (auto = false) => {
    if (cv !== 'ready') {
      if (!auto) { setMsg('The detector is not available. Drag the corners by hand.'); if (!page.corners) onChange({ corners: DEFAULT_CORNERS, skipCrop: false }); }
      return;
    }
    setBusy(true); setMsg(''); await tick();
    try {
      const c = detectCorners(await loadImg(page.url));
      if (c) { onChange({ corners: c, skipCrop: false, detected: true }); setMsg('Document found.'); }
      else { onChange({ detected: true }); setMsg(auto ? 'Could not find the page edges. Tap Set corners and drag them by hand.' : 'No document found. Drag the corners by hand or skip cropping.'); }
    } catch { setMsg('Detection failed. Drag the corners by hand.'); }
    setBusy(false);
  };
  useEffect(() => {
    if (clean && cv === 'ready' && !page.corners && !page.skipCrop && !autoTried.current) {
      autoTried.current = true;
      detect(true);
    }
  }, [cv]);
  const toggleCrop = () =>
    cropping ? onChange({ skipCrop: true }) : onChange({ skipCrop: false, corners: page.corners || DEFAULT_CORNERS });

  const drag = (i) => (e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); setDragging(i); };
  const move = (i) => (e) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const r = wrap.current.getBoundingClientRect();
    const pt = { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
    onChange({ corners: page.corners.map((p, j) => (j === i ? pt : p)) });
  };
  const drop = () => setDragging(null);
  const loupe = () => {
    const r = wrap.current?.getBoundingClientRect();
    if (dragging === null || !r || !page.corners) return null;
    const p = page.corners[dragging], Z = 2.5, S = 112;
    const left = p.x < 0.5 ? r.width - S - 8 : 8, top = p.y < 0.5 ? r.height - S - 8 : 8;
    return (
      <div className="loupe" style={{
        width: S, height: S, left, top, backgroundImage: `url(${page.url})`,
        backgroundSize: `${r.width * Z}px ${r.height * Z}px`,
        backgroundPosition: `${S / 2 - p.x * r.width * Z}px ${S / 2 - p.y * r.height * Z}px`,
      }}><i /></div>
    );
  };
  const filterName = FILTERS.find(([k]) => k === page.filter)?.[1] || 'filter';
  const stage = (src, alt) => (
    <div className={`stage ${busy ? 'loading' : ''}`}>
      {src ? <img src={src} alt={alt} /> : <img src={page.url} alt={alt} className="dim" />}
      {busy && <span className="spinner" aria-label="Updating preview" />}
    </div>
  );

  return (
    <div className="screen editor">
      <header className="bar">
        <button className="link" onClick={onBack}>Back</button>
        <h2>Page {index + 1} of {total}</h2>
        <span />
      </header>

      {!clean ? (
        <>
          {stage(preview, `Page ${index + 1}`)}
          <p className="note">Original photo mode exports this page as it is. Switch to Clean document to crop and enhance.</p>
          <button className="btn secondary" onClick={() => onChange({ rotate: ((page.rotate || 0) + 90) % 360 })}>Rotate 90 degrees</button>
        </>
      ) : (
        <>
          <div className="seg" role="tablist">
            <button className={tab === 'crop' ? 'on' : ''} onClick={() => setTab('crop')}>Crop</button>
            <button className={tab === 'enhance' ? 'on' : ''} onClick={() => setTab('enhance')}>Enhance</button>
          </div>

          {tab === 'crop' ? (
            <>
              <div className={`stage ${busy ? 'loading' : ''}`}>
                <div className="wrap" ref={wrap}>
                  <img src={page.url} alt={`Page ${index + 1}`} draggable="false" />
                  {cropping && (
                    <>
                      <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="quad">
                        <polygon points={page.corners.map((p) => `${p.x},${p.y}`).join(' ')} />
                      </svg>
                      {page.corners.map((p, i) => (
                        <span
                          key={i} className={`handle ${dragging === i ? 'held' : ''}`} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
                          onPointerDown={drag(i)} onPointerMove={move(i)} onPointerUp={drop} onPointerCancel={drop}
                        />
                      ))}
                      {loupe()}
                    </>
                  )}
                </div>
                {busy && <span className="spinner" aria-label="Finding the page" />}
              </div>
              <p className="note">{msg || (cropping ? 'Drag the corners to fit the document. A magnifier appears while you drag.' : 'The full original image will be used.')}</p>
              <div className="row">
                <button className="btn primary" onClick={() => detect(false)} disabled={busy}>Auto-detect</button>
                <button className="btn secondary" onClick={toggleCrop}>{cropping ? 'Skip cropping' : 'Set corners'}</button>
              </div>
            </>
          ) : (
            <>
              <div className={`stage ${busy ? 'loading' : ''}`}>
                <img src={compare ? page.url : (preview || page.url)} alt="Preview" className={!preview && !compare ? 'dim' : ''} />
                {busy && !compare && <span className="spinner" aria-label="Updating preview" />}
                {compare && <span className="badge">Original</span>}
              </div>
              {msg && <p className="note warn">{msg}</p>}
              <button
                className="btn secondary hold"
                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setCompare(true); }}
                onPointerUp={() => setCompare(false)} onPointerCancel={() => setCompare(false)}
                onContextMenu={(e) => e.preventDefault()}
              >Hold to see the original</button>
              <div className="chips">
                {FILTERS.map(([k, label]) => (
                  <button key={k} className={`chip-btn ${page.filter === k ? 'on' : ''}`} aria-pressed={page.filter === k} onClick={() => onChange({ filter: k })}>{label}</button>
                ))}
              </div>
              <label className="slider"><span>Brightness <b>{shown(page.brightness)}</b></span>
                <input type="range" min="-60" max="60" value={page.brightness} onChange={(e) => onChange({ brightness: +e.target.value })} />
              </label>
              <label className="slider"><span>Contrast <b>{shown(page.contrast)}</b></span>
                <input type="range" min="-60" max="60" value={page.contrast} onChange={(e) => onChange({ contrast: +e.target.value })} />
              </label>
              <div className="row">
                <button className="btn secondary" onClick={() => onChange({ rotate: ((page.rotate || 0) + 90) % 360 })}>Rotate 90 degrees</button>
                <button className="btn secondary" onClick={() => onChange({ ...DEFAULT_EDITS, rotate: 0 })}>Reset</button>
              </div>
              {total > 1 && (
                <button className="btn quiet" onClick={() => {
                  onApplyAll({ filter: page.filter, brightness: page.brightness, contrast: page.contrast });
                  setMsg(`Applied ${filterName} to all ${total} pages`);
                }}>
                  Apply to all pages
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
