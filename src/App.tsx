import { useEffect, useMemo, useRef, useState } from 'react';
import ScoreReader from './components/ScoreReader';
import type { ReaderLocation } from './components/ScoreReader';
import MusicIcon from './components/MusicIcon';
import { createDemoScore } from './lib/demo-score';
import { isPlaybackFile } from './lib/media-file';
import { readLibrary, removeLibraryScore, saveLibraryScore } from './lib/library';
import type { LibraryScore } from './lib/library';
import type { ScoreDocument } from './types';

function Bracket({ children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`bracket ${className}`} {...props}><span aria-hidden="true">{'{'}</span><span>{children}</span><span aria-hidden="true">{'}'}</span></button>;
}

const routeFromHash = () => window.location.hash === '#/library' ? 'library' : 'reader';

export default function App() {
  const [score, setScore] = useState<ScoreDocument>(createDemoScore);
  const [revision, setRevision] = useState(0);
  const [route, setRoute] = useState(routeFromHash);
  const [library, setLibrary] = useState<LibraryScore[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [activeId, setActiveId] = useState('demo');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [scoreFiles, setScoreFiles] = useState<File[]>([]);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [uploadTarget, setUploadTarget] = useState<'new' | 'audio'>('new');
  const [importStatus, setImportStatus] = useState('');
  const [preparingNotation, setPreparingNotation] = useState(false);
  const [readerLocation, setReaderLocation] = useState<ReaderLocation>();
  const inputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const importLock = useRef(false);
  const importController = useRef<AbortController | null>(null);
  const preparationRevision = useRef(0);
  const preparationSaving = useRef(false);

  useEffect(() => {
    const changeRoute = () => { setRoute(routeFromHash()); setDeleteId(null); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', changeRoute);
    return () => window.removeEventListener('hashchange', changeRoute);
  }, []);

  useEffect(() => {
    let alive = true;
    readLibrary().then(records => { if (alive) setLibrary(records); })
      .catch(() => { if (alive) setLibraryError('谱库暂时无法读取。'); })
      .finally(() => { if (alive) setLibraryLoading(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (uploadOpen) {
      dialog.classList.remove('is-closing');
      if (!dialog.open) dialog.showModal();
      document.body.style.overflow = 'hidden';
      return;
    }
    document.body.style.overflow = '';
    if (!dialog.open) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { dialog.close(); return; }
    // Let the sheet settle away before the modal is removed; reopening cancels it.
    dialog.classList.add('is-closing');
    const timer = window.setTimeout(() => { dialog.classList.remove('is-closing'); dialog.close(); }, 240);
    return () => window.clearTimeout(timer);
  }, [uploadOpen]);
  useEffect(() => () => { document.body.style.overflow = ''; }, []);
  useEffect(() => () => importController.current?.abort(), []);

  function cancelPreparation() {
    // Once IndexedDB writes begin, keep selection and the saved result together.
    // A ref closes the gap before the "saving" status has rendered.
    if (preparationSaving.current) return false;
    if (preparingNotation) {
      preparationRevision.current++;
      importController.current?.abort();
    }
    return true;
  }
  function openUpload() { if (!cancelPreparation()) return; setError(''); setScoreFiles([]); setAudioFile(null); setUploadTarget('new'); setUploadOpen(true); }
  function openAudioUpload() { if (!cancelPreparation()) return; setError(''); setScoreFiles([]); setAudioFile(null); setUploadTarget('audio'); setUploadOpen(true); }
  function showReader() { window.location.hash = '/'; setRoute('reader'); }
  function openScore(nextScore: ScoreDocument, id: string) {
    if (!cancelPreparation()) return;
    if (id !== activeId) { setReaderLocation(undefined); setScore(nextScore); setActiveId(id); setRevision(value => value + 1); }
    showReader();
  }
  function selectFiles(files: File[]) {
    if (importLock.current) return;
    const audio = files.filter(isPlaybackFile);
    if (audio.length > 1) { setError('每份谱子请选择一份音频或 MIDI。'); return; }
    const scores = files.filter(file => !audio.includes(file));
    if (scores.length) { setScoreFiles(scores); setUploadTarget('new'); }
    if (audio.length) setAudioFile(audio[0]);
    setError('');
  }
  async function loadFiles() {
    if ((uploadTarget === 'new' && !scoreFiles.length) || (uploadTarget === 'audio' && !audioFile) || importLock.current) return;
    importLock.current = true; setLoading(true); setError(''); setImportStatus('正在读取谱子…');
    const controller = new AbortController();
    importController.current = controller;
    try {
      let nextScore: ScoreDocument;
      if (uploadTarget === 'audio') nextScore = { ...score };
      else {
        const { importScore } = await import('./lib/import-score');
        nextScore = await importScore(scoreFiles);
        nextScore.originals = scoreFiles.map(file => ({ name: file.name, type: file.type, blob: file }));
      }
      controller.signal.throwIfAborted();
      if ((nextScore.kind === 'pdf' || nextScore.kind === 'image') && !nextScore.notation) {
        setImportStatus('正在解析谱面…');
        try {
          const { recognizeScore } = await import('./lib/recognize-score');
          nextScore = { ...nextScore, ...await recognizeScore(nextScore.pages, controller.signal) };
        } catch (cause) {
          controller.signal.throwIfAborted();
          if (audioFile) throw cause;
          nextScore = { ...nextScore, notationError: cause instanceof Error ? cause.message : '暂不能重新排版，已保留原件。' };
        }
      }
      if (audioFile) {
        if (!nextScore.reference) throw new Error('此谱缺少音符参考，暂不能对齐音频。');
        const { importAudio } = await import('./lib/import-audio');
        nextScore = { ...nextScore, audio: await importAudio(audioFile, nextScore.reference!, nextScore.pages.length, setImportStatus, controller.signal) };
      }
      controller.signal.throwIfAborted();
      setImportStatus('正在保存…');
      try {
        const existing = uploadTarget === 'audio' ? library.find(item => item.id === activeId) : undefined;
        const record = await saveLibraryScore(nextScore, existing);
        setLibrary(current => [record, ...current.filter(item => item.id !== record.id)]); setActiveId(record.id); setLibraryError('');
      } catch {
        setActiveId(`session-${Date.now()}`); setLibraryError('谱子已打开，未能保存到谱库。');
      }
      setReaderLocation(undefined); setScore(nextScore); setRevision(value => value + 1); setUploadOpen(false); showReader();
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '这份谱子暂时无法打开。'); }
    finally { importController.current = null; importLock.current = false; setLoading(false); setImportStatus(''); if (inputRef.current) inputRef.current.value = ''; if (audioInputRef.current) audioInputRef.current.value = ''; }
  }
  async function prepareCurrentNotation(location: ReaderLocation) {
    if (importLock.current) return;
    importLock.current = true;
    const controller = new AbortController();
    const token = ++preparationRevision.current;
    importController.current = controller;
    setPreparingNotation(true); setImportStatus('正在解析谱面…');
    try {
      const { recognizeScore } = await import('./lib/recognize-score');
      const result = await recognizeScore(score.pages, controller.signal);
      controller.signal.throwIfAborted();
      let nextScore: ScoreDocument = { ...score, ...result };
      // A fresh recognition can change musical events. Re-match saved audio rather than
      // attaching the old recording timeline to a different score by array index.
      if (score.audio) {
        const { importAudio, audioSourceFile } = await import('./lib/import-audio');
        const file = audioSourceFile(score.audio);
        nextScore = { ...nextScore, audio: await importAudio(file, result.reference, nextScore.pages.length, setImportStatus, controller.signal) };
      }
      controller.signal.throwIfAborted();
      preparationSaving.current = true;
      setImportStatus('正在保存…');
      try {
        const record = await saveLibraryScore(nextScore, library.find(item => item.id === activeId));
        if (controller.signal.aborted || token !== preparationRevision.current) return;
        setLibrary(current => [record, ...current.filter(item => item.id !== record.id)]);
        setActiveId(record.id); setLibraryError('');
      } catch { if (!controller.signal.aborted) setLibraryError('谱子已打开，未能保存到谱库。'); }
      if (controller.signal.aborted || token !== preparationRevision.current) return;
      setReaderLocation(location); setScore(nextScore); setRevision(value => value + 1);
    } catch (cause) {
      if (!controller.signal.aborted) setLibraryError(cause instanceof Error ? cause.message : '解析失败，已保留原谱。');
    } finally {
      preparationSaving.current = false;
      importController.current = null; importLock.current = false;
      setPreparingNotation(false); setImportStatus('');
    }
  }
  function resetDemo() { openScore(createDemoScore(), 'demo'); }
  async function deleteScore(id: string) {
    if (preparationSaving.current) return;
    if (deleteId !== id) { setDeleteId(id); return; }
    if (id === activeId) cancelPreparation();
    try { await removeLibraryScore(id); setLibrary(current => current.filter(item => item.id !== id)); setLibraryError(''); }
    catch { setLibraryError('未能删除，请重试。'); }
    setDeleteId(null);
  }
  const demo = useMemo(createDemoScore, []);
  const entries: LibraryScore[] = [...library, { id: 'demo', document: demo, addedAt: 0 }];

  return <>
    <a href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>跳到内容</a>
    <div className="site-frame" aria-hidden="true" />
    <header className="app-header">
      <a className="brand" href="#/" aria-label="随弦 · 谱面"><MusicIcon name="mark" size={36}/><span className="brand-name">随弦</span><span className="brand-en">Suixian</span></a>
      <nav className="app-nav" aria-label="页面导航">
        <a href="#/" className={route === 'reader' ? 'active' : ''} aria-current={route === 'reader' ? 'page' : undefined}><MusicIcon name="score" size={21}/><span>谱面</span></a>
        <a href="#/library" className={route === 'library' ? 'active' : ''} aria-current={route === 'library' ? 'page' : undefined}><MusicIcon name="library" size={21}/><span>谱库</span></a>
      </nav>
      <Bracket onClick={openUpload} className="header-upload"><MusicIcon name="upload" size={17}/><span>上传谱子</span></Bracket>
    </header>

    <main id="main-content" className={`app-main page-${route}`} tabIndex={-1}>
      {libraryError && <div className="storage-alert" role="status"><span>{libraryError}</span><button type="button" onClick={() => setLibraryError('')} aria-label="关闭提示"><MusicIcon name="close" size={15}/></button></div>}
      <div id="reader-content" className="reader-page" hidden={route !== 'reader'}>
        <ScoreReader key={revision} document={score} storageKey={activeId} onUpload={openUpload} onAttachAudio={openAudioUpload} onReset={resetDemo}
          initialLocation={readerLocation}
          onPrepareNotation={score.kind === 'pdf' || score.kind === 'image' ? location => void prepareCurrentNotation(location) : undefined}
          preparingNotation={preparingNotation} prepareStatus={importStatus} onCancelPreparation={cancelPreparation}
          active={route === 'reader' && !uploadOpen && !preparingNotation}/>
      </div>
      {route === 'library' && <section id="library-content" className="library-page" aria-labelledby="library-title">
        <header className="library-heading"><div><span className="library-kicker">Collection</span><h1 id="library-title">谱库<span className="library-count">{String(entries.length).padStart(2, '0')}</span></h1></div><span className="library-location"><span className="local-dot"/>本机保存</span></header>
        <div className="score-grid">
          {entries.map((entry, index) => <article className={`score-card ${entry.id === activeId ? 'is-current' : ''}`} key={entry.id} style={{ '--card-index': index } as React.CSSProperties}>
            <button type="button" className="score-card-open" onClick={() => openScore(entry.document, entry.id)} aria-label={`打开${entry.document.name}`}>
              <span className="score-cover"><span className="cover-page-back"/><img src={entry.document.pages[0].src} alt="" loading="lazy"/><span className="cover-open"><MusicIcon name="next" size={26}/></span>{entry.id === activeId && <span className="current-marker"><MusicIcon name="check" size={12}/>当前</span>}</span>
              <span className="score-card-info"><strong title={entry.document.name}>{entry.document.name}</strong><span>{entry.document.pages.length} 页<span className="metadata-dot">·</span>{entry.document.kind === 'demo' ? '示例' : entry.document.kind === 'image' ? '图片' : entry.document.kind.toUpperCase()}{entry.document.audio && <><span className="metadata-dot">·</span>{entry.document.audio.kind === 'midi' ? 'MIDI 同步' : '音频同步'}</>}</span></span>
            </button>
            {entry.id !== 'demo' && <div className="score-card-actions">{deleteId === entry.id ? <><button type="button" className="delete-confirm" onClick={() => void deleteScore(entry.id)}>删除</button><button type="button" className="delete-cancel" onClick={() => setDeleteId(null)}>取消</button></> : <button type="button" className="delete-button" onClick={() => void deleteScore(entry.id)} aria-label={`删除${entry.document.name}`} title="删除"><MusicIcon name="trash" size={17}/></button>}</div>}
          </article>)}
          <button type="button" className="library-add" onClick={openUpload}><MusicIcon name="upload" size={32}/><span>{libraryLoading ? '读取中…' : '上传谱子'}</span></button>
        </div>
      </section>}
    </main>

    <dialog ref={dialogRef} className="upload-dialog" aria-labelledby="upload-title" onCancel={event => { event.preventDefault(); if (!loading) setUploadOpen(false); }} onClick={event => { if (event.target === event.currentTarget && !loading) setUploadOpen(false); }} onClose={() => setUploadOpen(false)}>
      <div className="upload-inner"><div className="dialog-top"><h2 id="upload-title">{uploadTarget === 'audio' ? '添加音频 / MIDI' : '上传谱子与音频'}</h2><button type="button" className="close-button" aria-label="关闭上传窗口" disabled={loading} onClick={() => setUploadOpen(false)}><MusicIcon name="close" size={20}/></button></div>
        {uploadTarget === 'audio' ? <div className="upload-current"><span>当前谱子</span><strong>{score.name}</strong></div> : <button type="button" className={`drop-area upload-score-area ${dragging ? 'is-dragging' : ''}`} disabled={loading} onClick={() => inputRef.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); selectFiles([...event.dataTransfer.files]); }}>
          <MusicIcon name="upload" size={30}/><strong>{scoreFiles.length ? scoreFiles.length === 1 ? scoreFiles[0].name : `${scoreFiles.length} 张谱面` : '选择谱子'}</strong><span>PDF · MusicXML · JPG · PNG · WEBP<br/>最多 20 页 · 30 MB</span>
        </button>}
        <div className="upload-audio-row"><button type="button" disabled={loading} onClick={() => audioInputRef.current?.click()} className="upload-audio"><span>{audioFile ? '音频' : uploadTarget === 'new' ? '音频（可选）' : '音频'}</span><strong>{audioFile?.name ?? '选择音频 / MIDI'}</strong><small>MP3 · WAV · M4A · OGG · FLAC · MIDI<br/>音频 60 MB · MIDI 5 MB · 8 分钟</small></button>{audioFile && <button type="button" className="close-button" disabled={loading} aria-label="移除已选音频" onClick={() => setAudioFile(null)}><MusicIcon name="close" size={16}/></button>}</div>
        <input ref={inputRef} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,.musicxml,.xml,application/vnd.recordare.musicxml+xml,application/xml,text/xml,audio/*,.mp3,.wav,.m4a,.flac,.ogg,.mid,.midi,application/x-midi,application/midi" multiple className="file-input" aria-label="选择谱子文件" onChange={event => { selectFiles([...event.target.files ?? []]); event.target.value = ''; }}/>
        <input ref={audioInputRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg,.mid,.midi,application/x-midi,application/midi" className="file-input" aria-label="选择音频文件" onChange={event => { const file = event.target.files?.[0]; if (file) { setAudioFile(file); setError(''); } event.target.value = ''; }}/>
        <button type="button" className="upload-submit" disabled={loading || (uploadTarget === 'new' ? !scoreFiles.length : !audioFile)} onClick={() => void loadFiles()}>{loading && <MusicIcon name="loading" size={15}/>}<span>{loading ? importStatus : audioFile ? '识别并对齐' : '解析并打开'}</span></button>
        {loading && <span className="sr-only" role="status">{importStatus}</span>}
        {loading && importStatus !== '正在保存…' && <button type="button" className="upload-cancel" onClick={() => { importController.current?.abort(); setImportStatus('正在取消…'); }}>取消导入</button>}
        {error && <p role="alert" className="upload-error">{error}</p>}
      </div>
    </dialog>
  </>;
}
