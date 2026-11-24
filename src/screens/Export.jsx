import { useEffect, useRef, useState } from 'react';
import { buildPdf } from '../lib/pdf.js';

const MB = 1024 * 1024;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const stamp = () => { const d = new Date(); return `${d.getDate()}${MONTHS[d.getMonth()]}${d.getFullYear()}`; };
const size = (b) => (b >= MB ? `${(b / MB).toFixed(2)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const TIERS = [{ maxDim: 2200, quality: 0.8 }, { maxDim: 1800, quality: 0.7 }, { maxDim: 1500, quality: 0.6 }, { maxDim: 1200, quality: 0.5 }, { maxDim: 1000, quality: 0.42 }];

export default function Export({ pages, mode, onBack, onNew }) {
  const [name, setName] = useState(`P2PDF_${stamp()}`);
  const [busy, setBusy] = useState(true);
  const [what, setWhat] = useState('Creating');
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState('');
  const [res, setRes] = useState(null);
  const [msg, setMsg] = useState('');
  const [live, setLive] = useState([]);
  const urlRef = useRef(null);
  const nameInput = useRef(null);

  const onThumb = (i, t) => setLive((l) => { const c = [...l]; c[i] = t; return c; });
  const finish = (r) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = URL.createObjectURL(r.blob);
    setRes({ ...r, url: urlRef.current });
  };
  const run = async () => {
    setBusy(true); setWhat('Creating'); setErr(''); setProgress(0); setLive([]); setMsg('');
    try { finish(await buildPdf(pages, mode, setProgress, {}, onThumb)); }
    catch (e) {
      console.error(e);
      setErr('The PDF could not be created. A very large image may have run out of memory. Try fewer pages or Original photo mode.');
    }
    setBusy(false);
  };
  useEffect(() => { run(); return () => urlRef.current && URL.revokeObjectURL(urlRef.current); }, []);

  useEffect(() => {
    if (!busy || !navigator.wakeLock) return;
    let lock = null, dead = false;
    navigator.wakeLock.request('screen').then((l) => { if (dead) l.release().catch(() => {}); else lock = l; }).catch(() => {});
    return () => { dead = true; lock?.release?.().catch(() => {}); };
  }, [busy]);

  const compress = async () => {
    setBusy(true); setWhat('Compressing'); setErr(''); setProgress(0); setLive([]); setMsg('');
    try {
      let r = null;
      for (const t of TIERS) {
        r = await buildPdf(pages, mode, setProgress, t, onThumb);
        if (r.blob.size < 5 * MB) break;
      }
      finish(r);
      setMsg(`Compressed to ${size(r.blob.size)}.`);
    } catch (e) {
      console.error(e);
      setErr('Compressing failed. Try fewer pages.');
    }
    setBusy(false);
  };

  const fileName = `${(name.trim() || `P2PDF_${stamp()}`).replace(/[\\/:*?"<>|]+/g, '-').replace(/\.pdf$/i, '')}.pdf`;
  const file = res ? new File([res.blob], fileName, { type: 'application/pdf' }) : null;
  const canShare = !!(file && navigator.canShare?.({ files: [file] }));
  const bytes = res?.blob.size || 0;
  const verdict = bytes > 10 * MB ? { c: 'bad', t: 'Too big for most portals' } : bytes > 5 * MB ? { c: 'warn', t: 'Some portals limit uploads to 5 MB' } : { c: 'good', t: 'Good for portal' };

  const download = () => {
    const a = document.createElement('a');
    a.href = res.url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
  };
  const share = async () => {
    if (!canShare) { setMsg('Sharing is not supported in this browser. Use Download instead.'); return; }
    try { await navigator.share({ files: [file], title: fileName }); setMsg(''); }
    catch (e) { if (e.name !== 'AbortError') setMsg('Sharing failed. Use Download instead.'); }
  };

  return (
    <div className="screen export">
      <header className="bar">
        <button className="link" onClick={onBack} disabled={busy}>Back</button>
        <h2>Your PDF</h2>
        <span />
      </header>

      {busy && (
        <div className="progress" role="status">
          <div className="bar-track"><div className="bar-fill" style={{ width: `${(progress / pages.length) * 100}%` }} /></div>
          <p><strong>{what} page {Math.max(progress, 1)} of {pages.length}</strong>{progress >= pages.length ? ' · almost done' : ''}</p>
          <div className="build-grid">
            {pages.map((p, i) => (
              <figure key={p.id} className={live[i] ? 'done' : i + 1 === progress ? 'now' : ''}>
                {live[i] ? <img src={live[i]} alt={`Page ${i + 1}`} /> : <span className="ph" />}
                <figcaption>{i + 1}</figcaption>
              </figure>
            ))}
          </div>
          <p className="note">Keep this screen open. Your phone will stay awake until it finishes.</p>
        </div>
      )}
      {err && (
        <div className="card err">
          <p>{err}</p>
          <div className="row"><button className="btn secondary" onClick={onBack}>Back to pages</button><button className="btn primary" onClick={run}>Try again</button></div>
        </div>
      )}

      {res && !busy && (
        <>
          <p className="count">{pages.length} page{pages.length > 1 ? 's' : ''} <span className="dotsep">•</span> {size(bytes)} <span className="dotsep">•</span> <span className={`verdict ${verdict.c}`}>{verdict.t}</span></p>
          {bytes > 5 * MB && (
            <div className={`note ${bytes > 10 * MB ? 'warn' : ''}`}>
              {bytes > 10 * MB ? 'This file is over 10 MB and may be rejected when you upload it. ' : ''}
              <button className="link" onClick={compress}>Compress to under 5 MB</button>
            </div>
          )}
          <div className="previews">
            {res.thumbs.map((t, i) => (
              <figure key={i}><img src={t} alt={`Page ${i + 1}`} /><figcaption>{i + 1}</figcaption></figure>
            ))}
          </div>
          <a className="link" href={res.url} target="_blank" rel="noreferrer">Open full preview</a>
          <div className="field">File name
            <span className="input"><input ref={nameInput} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="File name" /><em>.pdf</em></span>
            <div className="suggest" aria-label="Name suggestions">
              {[`P2PDF_${stamp()}`, 'U22XX2030_MTH101_Assignment', `Assignment_${stamp()}`].map((s) => (
                <button key={s} className="chip-btn small" onClick={() => { setName(s); nameInput.current?.focus(); }}>{s}</button>
              ))}
            </div>
            <span className="hint">Format: MATRICNO_COURSE_NAME. Tap a name to use it, then edit it.</span>
          </div>
          {msg && <p className="note warn">{msg}</p>}
          <div className="dock">
            <div className="row">
              {canShare ? (
                <>
                  <button className="btn primary" onClick={share}>Share PDF</button>
                  <button className="btn secondary" onClick={download}>Download PDF</button>
                </>
              ) : (
                <>
                  <button className="btn primary" onClick={download}>Download PDF</button>
                  <button className="btn secondary" onClick={share}>Share PDF</button>
                </>
              )}
            </div>
            <button className="btn quiet" onClick={onNew}>Start a new document</button>
          </div>
        </>
      )}
    </div>
  );
}
