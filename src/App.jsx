import { useEffect, useRef, useState } from 'react';
import Home from './screens/Home.jsx';
import Camera from './screens/Camera.jsx';
import Pages from './screens/Pages.jsx';
import Editor from './screens/Editor.jsx';
import Export from './screens/Export.jsx';
import { MAX_PAGES, LIMIT_MSG, normalize, loadImg, isImageFile, tick } from './lib/image.js';
import { loadOpenCV, detectCorners } from './lib/cv.js';
import { DEFAULT_EDITS } from './lib/render.js';
import { saveDraft, loadDraft, clearDraft } from './lib/draft.js';

let uid = 0;

export default function App() {
  const [screen, setScreen] = useState('home'); // home | camera | pages | edit | export
  const [pages, setPages] = useState([]);
  const [mode, setMode] = useState('clean'); // original | clean
  const [cv, setCv] = useState('idle'); // idle | loading | ready | failed
  const [editIndex, setEditIndex] = useState(0);
  const [retake, setRetake] = useState(null);
  const [toast, setToast] = useState('');
  const [installEvt, setInstallEvt] = useState(null);
  const [draft, setDraft] = useState([]);
  const [saveOn, setSaveOn] = useState(false);
  const pagesRef = useRef([]);
  const pending = useRef(0);
  const fileInput = useRef(null);
  const timer = useRef(null);

  const update = (fn) => {
    const next = fn(pagesRef.current);
    pagesRef.current = next;
    setPages(next);
  };
  const notify = (msg) => {
    setToast(msg);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(''), 4500);
  };

  useEffect(() => {
    loadDraft().then((list) => {
      if (list.length) setDraft(list);
      else setSaveOn(true);
    });
  }, []);
  useEffect(() => {
    if (!saveOn) return;
    const t = setTimeout(() => saveDraft(pages), 700);
    return () => clearTimeout(t);
  }, [pages, saveOn]);

  const resumeDraft = () => {
    if (!draft.length) return;
    const restored = draft.map((d) => ({ ...d, url: URL.createObjectURL(d.blob) }));
    uid = Math.max(uid, ...restored.map((p) => p.id || 0));
    update((p) => {
      const merged = [...restored, ...p];
      merged.slice(MAX_PAGES).forEach((page) => URL.revokeObjectURL(page.url));
      return merged.slice(0, MAX_PAGES);
    });
    setDraft([]);
    setSaveOn(true);
    return restored.length;
  };
  const discardDraft = () => {
    setDraft([]);
    setSaveOn(true);
    clearDraft();
  };
  const resumeAndReview = () => {
    resumeDraft();
    setScreen('pages');
  };

  // Add images from any source. The page limit covers camera + uploads together.
  const addImages = async (blobs) => {
    resumeDraft();
    const room = MAX_PAGES - pagesRef.current.length - pending.current;
    if (room <= 0) { notify(LIMIT_MSG); return 0; }
    let list = blobs;
    if (blobs.length > room) {
      list = blobs.slice(0, room);
      notify(`${LIMIT_MSG} Added ${room}, skipped ${blobs.length - room}.`);
    }
    pending.current += list.length;
    const added = [];
    let bad = 0;
    for (const item of list) {
      try {
        const blob = item instanceof Blob ? item : item.blob;
        const n = await normalize(blob);
        added.push({ id: ++uid, ...n, hint: item.hint || null, rotate: 0, corners: null, detected: false, skipCrop: false, ...DEFAULT_EDITS });
      } catch {
        bad++;
      }
    }
    pending.current -= list.length;
    if (bad) notify(`${bad} file${bad > 1 ? 's' : ''} could not be read as an image and ${bad > 1 ? 'were' : 'was'} skipped.`);
    update((p) => {
      const next = [...p, ...added].slice(0, MAX_PAGES);
      added.slice(next.length - p.length).forEach((a) => URL.revokeObjectURL(a.url));
      return next;
    });
    return added.length;
  };

  const onPick = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const ok = files.filter(isImageFile);
    if (ok.length < files.length) notify('Only JPG, PNG and WebP images can be added.');
    if (ok.length) await addImages(ok);
    if (pagesRef.current.length) setScreen('pages');
  };
  const pick = () => {
    if (pagesRef.current.length >= MAX_PAGES) return notify(LIMIT_MSG);
    fileInput.current.click();
  };

  const onCapture = async (blob, hint) => {
    if (retake === null) return addImages([{ blob, hint }]);
    const i = retake;
    const old = pagesRef.current[i];
    setRetake(null);
    try {
      const n = await normalize(blob);
      const fresh = { id: ++uid, ...n, hint: hint || null, rotate: 0, corners: null, detected: false, skipCrop: false, ...DEFAULT_EDITS };
      if (old) { fresh.filter = old.filter; fresh.brightness = old.brightness; fresh.contrast = old.contrast; URL.revokeObjectURL(old.url); }
      update((l) => (old ? l.map((p, j) => (j === i ? fresh : p)) : [...l, fresh]));
      notify(`Page ${i + 1} replaced.`);
    } catch {
      notify('That photo could not be read. Try again.');
    }
    setScreen('pages');
    return 1;
  };

  const patchPage = (id, patch) => update((l) => l.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const applyToAll = (patch) => update((l) => l.map((p) => ({ ...p, ...patch })));
  const removePage = (i) => {
    URL.revokeObjectURL(pagesRef.current[i].url);
    update((l) => l.filter((_, j) => j !== i));
  };
  const movePage = (i, dir) =>
    update((l) => {
      const j = i + dir;
      if (j < 0 || j >= l.length) return l;
      const c = [...l];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });
  const newDocument = () => {
    pagesRef.current.forEach((p) => URL.revokeObjectURL(p.url));
    update(() => []);
    clearDraft();
    setMode('clean');
    setScreen('home');
  };
  const scan = () => {
    resumeDraft();
    setRetake(null);
    setScreen('camera');
  };

  // Load OpenCV as soon as Clean document mode is active so it is ready before the first scan.
  const startCv = () => {
    setCv('loading');
    loadOpenCV().then((ok) => setCv(ok ? 'ready' : 'failed'));
  };
  useEffect(() => {
    if (mode === 'clean' && cv === 'idle') startCv();
  }, [mode, cv]);

  // Auto-detect one page at a time so the interface never freezes.
  useEffect(() => {
    if (mode !== 'clean' || cv !== 'ready') return;
    const todo = pages.find((p) => !p.detected);
    if (!todo) return;
    let dead = false;
    (async () => {
      await tick();
      let corners = null;
      try { corners = detectCorners(await loadImg(todo.url)); } catch { /* page removed or unreadable */ }
      if (!corners && todo.hint) corners = todo.hint;
      if (!dead) patchPage(todo.id, { detected: true, corners });
    })();
    return () => { dead = true; };
  }, [pages, mode, cv]);

  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setInstallEvt(e); };
    const onInstalled = () => setInstallEvt(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled); };
  }, []);
  const install = async () => { installEvt.prompt(); await installEvt.userChoice; setInstallEvt(null); };

  const back = () => { setRetake(null); setScreen(pages.length ? 'pages' : 'home'); };

  return (
    <div className={`app ${screen}`}>
      {screen === 'home' && (
        <Home
          onInstall={installEvt ? install : null} count={pages.length} draftCount={draft.length}
          onScan={scan} onUpload={pick} onReview={() => setScreen('pages')}
          onResume={resumeAndReview} onDiscard={discardDraft}
        />
      )}
      {screen === 'camera' && (
        <Camera count={pages.length} mode={mode} cv={cv} retake={retake} onCapture={onCapture} onDone={back} />
      )}
      {screen === 'pages' && (
        <Pages
          pages={pages} mode={mode} setMode={setMode} cv={cv} onRetryCv={startCv}
          onMove={movePage} onRemove={removePage}
          onEdit={(i) => { setEditIndex(i); setScreen('edit'); }}
          onRetake={(i) => { setRetake(i); setScreen('camera'); }}
          onScan={scan} onUpload={pick}
          onExport={() => setScreen('export')} onHome={() => setScreen('home')}
        />
      )}
      {screen === 'edit' && pages[editIndex] && (
        <Editor
          key={pages[editIndex].id}
          page={pages[editIndex]} index={editIndex} total={pages.length} mode={mode} cv={cv}
          onChange={(patch) => patchPage(pages[editIndex].id, patch)}
          onApplyAll={applyToAll}
          onBack={() => setScreen('pages')}
        />
      )}
      {screen === 'export' && (
        <Export pages={pages} mode={mode} onBack={() => setScreen('pages')} onNew={newDocument} />
      )}
      <input
        ref={fileInput} type="file" hidden multiple
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" onChange={onPick}
      />
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
