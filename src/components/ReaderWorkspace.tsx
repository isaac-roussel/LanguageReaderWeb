import { BookOpen, Download, FilePlus, Import, Library, LogOut, Plus, RotateCcw, Save, Search, Sparkles, X } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Lexicon, LexiconEntry, TextDoc } from '../types';
import { clampStatus, deepLUrl, desktopEntriesFromJson, normalizedKey, splitLines, toDesktopLexicon } from '../utils/lexicon';
import { isWordToken, parseSentences, pickSpeechLocale, sentenceToText } from '../utils/text';

type Props = { session: Session; onSignOut: () => void };
type View = 'reader' | 'dictionary' | 'review';
type ReaderTokenSelection = { key: string; text: string; order: number };
type PopupAnchor = { left: number; top: number; right: number; bottom: number };
type ReaderPopup = { open: boolean; x: number; y: number; anchor: PopupAnchor | null; manual: boolean };
const statusLabel = ['Ignored', 'New', 'Seen', 'Familiar', 'Known'];
const popupWidth = 380;
const popupHeight = 560;

export default function ReaderWorkspace({ session, onSignOut }: Props) {
  const userId = session.user.id;
  const [view, setView] = useState<View>('reader');
  const [lexicons, setLexicons] = useState<Lexicon[]>([]);
  const [texts, setTexts] = useState<TextDoc[]>([]);
  const [activeLexicon, setActiveLexicon] = useState<Lexicon | null>(null);
  const [activeText, setActiveText] = useState<TextDoc | null>(null);
  const [entries, setEntries] = useState<LexiconEntry[]>([]);
  const [selected, setSelected] = useState<LexiconEntry | null>(null);
  const [query, setQuery] = useState('');
  const [readerMode, setReaderMode] = useState<'full' | 'sentence'>('sentence');
  const [sentenceIndex, setSentenceIndex] = useState(0);
  const [isReading, setIsReading] = useState(false);
  const [speechRate, setSpeechRate] = useState(0.5);
  const [isAddingText, setIsAddingText] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [readerTokenSelection, setReaderTokenSelection] = useState<ReaderTokenSelection[]>([]);
  const [readerPopup, setReaderPopup] = useState<ReaderPopup>({ open: false, x: 0, y: 0, anchor: null, manual: false });
  const importRef = useRef<HTMLInputElement>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const readerPanelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);

  useEffect(() => { void refreshAll(); }, []);
  useEffect(() => { if (activeLexicon) void loadEntries(activeLexicon.id); }, [activeLexicon?.id]);
  useEffect(() => () => {
    window.speechSynthesis.cancel();
    utteranceRef.current = null;
  }, []);
  useEffect(() => setReaderTokenSelection([]), [activeText?.id, readerMode, sentenceIndex]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setReaderPopup(current => ({ ...current, open: false }));
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!readerPopup.open) return;
      const target = event.target as Node | null;
      if (target && popupRef.current?.contains(target)) return;
      setReaderPopup(current => ({ ...current, open: false }));
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [readerPopup.open]);
  useEffect(() => {
    if (view !== 'reader') setReaderPopup(current => ({ ...current, open: false }));
  }, [view]);

  const entryMap = useMemo(() => new Map(entries.map(e => [e.normalized_key, e])), [entries]);
  const sentences = useMemo(() => parseSentences(activeText?.content || ''), [activeText?.content]);
  const visibleSentences = readerMode === 'sentence' ? sentences.slice(sentenceIndex, sentenceIndex + 1) : sentences;
  const selectedReaderPhrase = useMemo(() => readerTokenSelection
    .slice()
    .sort((a, b) => a.order - b.order)
    .map(token => token.text)
    .join(' '), [readerTokenSelection]);
  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(e => !q || e.target.toLowerCase().includes(q) || e.native.join(' ').toLowerCase().includes(q) || e.notes.toLowerCase().includes(q));
  }, [entries, query]);
  const familiar = entries.filter(e => e.status === 3);
  const due = entries.filter(e => e.status > 0 && e.status < 4);

  async function refreshAll() {
    if (!supabase) return;
    const [{ data: lx }, { data: tx }] = await Promise.all([
      supabase.from('lexicons').select('*').order('updated_at', { ascending: false }),
      supabase.from('texts').select('*').order('updated_at', { ascending: false })
    ]);
    const nextLexicons = (lx || []) as Lexicon[];
    const nextTexts = (tx || []) as TextDoc[];
    setLexicons(nextLexicons);
    setTexts(nextTexts);
    setActiveLexicon(current => current || nextLexicons[0] || null);
    setActiveText(current => current || nextTexts[0] || null);
  }

  async function loadEntries(lexiconId: string) {
    if (!supabase) return;
    const pageSize = 1000;
    const allEntries: LexiconEntry[] = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('lexicon_entries')
        .select('*')
        .eq('lexicon_id', lexiconId)
        .order('target')
        .range(from, from + pageSize - 1);
      if (error) {
        alert(error.message);
        break;
      }
      const page = (data || []) as LexiconEntry[];
      allEntries.push(...page);
      if (page.length < pageSize) break;
    }
    setEntries(allEntries);
  }

  async function createLexicon() {
    if (!supabase) return;
    const title = window.prompt('Lexicon name', 'My Lexicon');
    if (!title) return;
    const { data, error } = await supabase.from('lexicons').insert({ owner_id: userId, title, target_language: 'auto', native_language: 'en' }).select('*').single();
    if (error) return alert(error.message);
    setLexicons([data as Lexicon, ...lexicons]);
    setActiveLexicon(data as Lexicon);
  }

  async function saveText() {
    if (!supabase || !draftText.trim()) return;
    const payload = { owner_id: userId, title: draftTitle.trim() || 'Untitled text', content: draftText, target_language: activeLexicon?.target_language || 'auto' };
    const { data, error } = await supabase.from('texts').insert(payload).select('*').single();
    if (error) return alert(error.message);
    setTexts([data as TextDoc, ...texts]);
    setActiveText(data as TextDoc);
    setDraftText('');
    setDraftTitle('');
    setSentenceIndex(0);
    setIsAddingText(false);
  }

  async function upsertEntry(target: string, patch: Partial<LexiconEntry>) {
    if (!supabase || !activeLexicon) return null;
    const key = normalizedKey(target);
    const existing = entryMap.get(key);
    const payload = {
      lexicon_id: activeLexicon.id,
      owner_id: userId,
      target,
      normalized_key: key,
      native: patch.native ?? existing?.native ?? [],
      status: clampStatus(patch.status ?? existing?.status ?? 1),
      scope: patch.scope ?? existing?.scope ?? (target.includes(' ') ? 'phrase' : 'word'),
      notes: patch.notes ?? existing?.notes ?? '',
      review: patch.review ?? existing?.review ?? {}
    };
    const query = existing
      ? supabase.from('lexicon_entries').update(payload).eq('id', existing.id).select('*').single()
      : supabase.from('lexicon_entries').insert(payload).select('*').single();
    const { data, error } = await query;
    if (error) { alert(error.message); return null; }
    const saved = data as LexiconEntry;
    setEntries(prev => existing ? prev.map(e => e.id === saved.id ? saved : e) : [...prev, saved].sort((a, b) => a.target.localeCompare(b.target)));
    setSelected(saved);
    return saved;
  }

  async function updateSelected(patch: Partial<LexiconEntry>) {
    if (!selected) return;
    await upsertEntry(selected.target, patch);
  }

  async function deleteSelectedEntry() {
    if (!supabase || !selected) return;
    const confirmed = window.confirm(`Delete "${selected.target}" from this lexicon? This cannot be undone.`);
    if (!confirmed) return;
    const entryId = selected.id;
    const { error } = await supabase
      .from('lexicon_entries')
      .delete()
      .eq('id', entryId)
      .eq('owner_id', userId);
    if (error) return alert(error.message);
    setEntries(prev => prev.filter(entry => entry.id !== entryId));
    setSelected(null);
    setReaderTokenSelection([]);
    setReaderPopup(current => ({ ...current, open: false }));
  }

  async function importJson(file: File) {
    if (!supabase) return;
    const raw = await file.text();
    const imported = desktopEntriesFromJson(raw);
    let targetLexicon = activeLexicon;
    if (!targetLexicon) {
      const title = file.name.replace(/\.json$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2') || 'Imported Lexicon';
      const { data, error } = await supabase.from('lexicons').insert({
        owner_id: userId,
        title,
        target_language: imported.meta?.language || imported.meta?.targetLang || 'auto',
        native_language: imported.meta?.nativeLang || imported.meta?.defLang || imported.meta?.native || 'en'
      }).select('*').single();
      if (error) return alert(error.message);
      targetLexicon = data as Lexicon;
      setLexicons(prev => [targetLexicon!, ...prev]);
      setActiveLexicon(targetLexicon);
    } else if (imported.meta?.language || imported.meta?.nativeLang) {
      await supabase.from('lexicons').update({ target_language: imported.meta.language || imported.meta.targetLang || targetLexicon.target_language, native_language: imported.meta.nativeLang || imported.meta.defLang || imported.meta.native || targetLexicon.native_language }).eq('id', targetLexicon.id);
    }
    const rows = imported.entries.map(e => ({
      ...e,
      lexicon_id: targetLexicon.id,
      owner_id: userId
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('lexicon_entries').upsert(rows.slice(i, i + 500), { onConflict: 'lexicon_id,normalized_key' });
      if (error) return alert(error.message);
    }
    await loadEntries(targetLexicon.id);
    await refreshAll();
  }

  function exportJson() {
    if (!activeLexicon) return;
    const blob = new Blob([toDesktopLexicon(activeLexicon, entries)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeLexicon.title.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_lexicon.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function stopSpeech() {
    window.speechSynthesis.cancel();
    utteranceRef.current = null;
    setIsReading(false);
  }

  function speak(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = pickSpeechLocale(activeLexicon?.target_language);
    utterance.rate = speechRate;
    utteranceRef.current = utterance;
    setIsReading(true);
    const finish = () => {
      if (utteranceRef.current === utterance) {
        utteranceRef.current = null;
        setIsReading(false);
      }
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    window.speechSynthesis.speak(utterance);
  }

  function openDeepL(text: string) {
    window.open(deepLUrl(text, activeLexicon?.target_language || 'auto', activeLexicon?.native_language || 'en'), 'language-reader-deepl');
  }

  function startNewText() {
    setIsAddingText(true);
    setDraftTitle('');
    setDraftText('');
    setSelected(null);
  }

  function selectedReaderText() {
    if (selectedReaderPhrase) return selectedReaderPhrase;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return '';
    const selectedRange = selection.getRangeAt(0);
    const selectedTokens = Array.from(document.querySelectorAll<HTMLElement>('.reader-text [data-reader-token="true"]'))
      .filter(token => selectedRange.intersectsNode(token))
      .map(token => token.textContent?.trim() || '')
      .filter(Boolean);
    if (selectedTokens.length > 0) return selectedTokens.join(' ');
    return selection.toString().replace(/\s+/g, ' ').trim();
  }

  const addSelectedPhrase = useCallback(async () => {
    const phrase = selectedReaderText();
    if (!phrase) {
      alert('Select a phrase in the reader first.');
      return;
    }
    const anchor = anchorFromReaderSelection();
    const saved = await upsertEntry(phrase, { scope: 'phrase' });
    if (!saved) return;
    openReaderPopup(anchor);
    setReaderTokenSelection([]);
    window.getSelection()?.removeAllRanges();
  }, [entryMap, activeLexicon?.id, userId, selectedReaderPhrase]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      if (event.altKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        void addSelectedPhrase();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [addSelectedPhrase]);

  const phraseEntries = useMemo(() => entries
    .filter(e => e.scope === 'phrase')
    .map(e => ({
      status: e.status,
      parts: normalizedKey(e.target).split(' ').filter(Boolean)
    }))
    .filter(e => e.parts.length > 1)
    .sort((a, b) => b.parts.length - a.parts.length), [entries]);

  function phraseClasses(tokens: string[]) {
    const classes = Array(tokens.length).fill('');
    const words = tokens.map((token, index) => ({ token, index, key: normalizedKey(token) })).filter(item => isWordToken(item.token));

    for (let i = 0; i < words.length; i += 1) {
      if (classes[words[i].index]) continue;
      const phrase = phraseEntries.find(candidate =>
        candidate.parts.every((part, offset) => words[i + offset]?.key === part)
      );
      if (!phrase) continue;
      phrase.parts.forEach((_, offset) => {
        const word = words[i + offset];
        if (word) classes[word.index] = ` phrase phrase-status-${phrase.status}`;
      });
      i += phrase.parts.length - 1;
    }

    return classes;
  }

  function tokenClass(token: string, phraseClass = '', isManuallySelected = false) {
    const entry = entryMap.get(normalizedKey(token));
    return `${entry ? `token status-${entry.status}` : 'token status-new'}${phraseClass}${isManuallySelected ? ' token-selected' : ''}`;
  }

  function clampPopupPosition(x: number, y: number) {
    const margin = 12;
    const maxX = Math.max(margin, window.innerWidth - popupWidth - margin);
    const maxY = Math.max(margin, window.innerHeight - popupHeight - margin);
    return {
      x: Math.min(Math.max(margin, x), maxX),
      y: Math.min(Math.max(margin, y), maxY)
    };
  }

  function popupPositionForAnchor(anchor: PopupAnchor | null) {
    if (anchor) return clampPopupPosition(anchor.right + 12, anchor.top);
    const fallback = readerPanelRef.current?.getBoundingClientRect();
    if (fallback) return clampPopupPosition(fallback.right - popupWidth - 16, fallback.top + 16);
    return clampPopupPosition(window.innerWidth - popupWidth - 16, 80);
  }

  function openReaderPopup(anchor: PopupAnchor | null, forceRecenter = false) {
    setReaderPopup(current => {
      const shouldKeepManualPosition = current.open && current.manual && !forceRecenter;
      const position = shouldKeepManualPosition ? { x: current.x, y: current.y } : popupPositionForAnchor(anchor);
      return { open: true, x: position.x, y: position.y, anchor: anchor || current.anchor, manual: shouldKeepManualPosition };
    });
  }

  function recenterReaderPopup() {
    setReaderPopup(current => {
      const position = popupPositionForAnchor(current.anchor);
      return { ...current, open: true, x: position.x, y: position.y, manual: false };
    });
  }

  function anchorFromReaderSelection(): PopupAnchor | null {
    const firstSelected = readerTokenSelection.slice().sort((a, b) => a.order - b.order)[0];
    if (firstSelected) {
      const token = document.querySelector<HTMLElement>(`[data-reader-token-key="${firstSelected.key}"]`);
      if (token) return token.getBoundingClientRect();
    }
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width || rect.height) return rect;
    }
    return null;
  }

  function openToken(token: string, anchor: PopupAnchor | null = null) {
    setReaderTokenSelection([]);
    openReaderPopup(anchor);
    const entry = entryMap.get(normalizedKey(token));
    setSelected(entry || null);
    if (!entry) void upsertEntry(token, { status: 1 });
  }

  function toggleReaderToken(token: string, key: string, order: number) {
    window.getSelection()?.removeAllRanges();
    setReaderTokenSelection(current => {
      if (current.some(item => item.key === key)) return current.filter(item => item.key !== key);
      return [...current, { key, text: token, order }];
    });
  }

  function hasActiveSelection() {
    return Boolean(window.getSelection()?.toString().trim());
  }

  function needsTrailingSpace(tokens: string[], index: number) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (!next) return false;
    if (/^[,.;:!?%)\]”’]$/u.test(next)) return false;
    if (/^[(\[{“‘¿¡]$/u.test(token)) return false;
    return true;
  }

  function startPopupDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (window.matchMedia('(max-width: 700px)').matches) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, input, textarea, select')) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - readerPopup.x,
      offsetY: event.clientY - readerPopup.y
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function movePopupDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const position = clampPopupPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    setReaderPopup(current => ({ ...current, open: true, x: position.x, y: position.y, manual: true }));
  }

  function stopPopupDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><BookOpen size={22}/><strong>Language Reader</strong></div>
        <nav>
          <button className={view === 'reader' ? 'active' : ''} onClick={() => setView('reader')}><BookOpen size={17}/> Reader</button>
          <button className={view === 'dictionary' ? 'active' : ''} onClick={() => setView('dictionary')}><Library size={17}/> Dictionary</button>
          <button className={view === 'review' ? 'active' : ''} onClick={() => setView('review')}><Sparkles size={17}/> Review</button>
        </nav>
        <section className="side-section">
          <header><span>Lexicons</span><button onClick={createLexicon} title="New lexicon"><Plus size={16}/></button></header>
          <select value={activeLexicon?.id || ''} onChange={e => setActiveLexicon(lexicons.find(l => l.id === e.target.value) || null)}>
            <option value="">No lexicon</option>
            {lexicons.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
          </select>
          <div className="button-row">
            <button onClick={() => importRef.current?.click()}><Import size={15}/> Import</button>
            <button onClick={exportJson} disabled={!activeLexicon}><Download size={15}/> Export</button>
          </div>
          <input ref={importRef} type="file" accept=".json,application/json" hidden onChange={e => e.target.files?.[0] && void importJson(e.target.files[0])}/>
        </section>
        <section className="side-section">
          <header><span>Texts</span><button onClick={startNewText} title="New story"><Plus size={16}/></button></header>
          <select value={activeText?.id || ''} onChange={e => { setActiveText(texts.find(t => t.id === e.target.value) || null); setSentenceIndex(0); }}>
            <option value="">No text</option>
            {texts.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </section>
        <button className="ghost signout" onClick={onSignOut}><LogOut size={16}/> Sign out</button>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">Invite-only web beta</p><h1>{view === 'reader' ? activeText?.title || 'Reader' : view === 'dictionary' ? 'Dictionary' : 'Review'}</h1></div>
          <div className="stats"><span>{entries.length} entries</span><span>{familiar.length} familiar</span><span>{due.length} due-ish</span></div>
        </header>

        {view === 'reader' && <section className="reader-grid">
          <div ref={readerPanelRef} className="panel reader-panel">
            {(!activeText || isAddingText) && <div className="new-text">
              <input placeholder="Text title" value={draftTitle} onChange={e => setDraftTitle(e.target.value)} />
              <textarea placeholder="Paste a reading text here..." value={draftText} onChange={e => setDraftText(e.target.value)} />
              <div className="button-row">
                <button className="primary" onClick={saveText}><FilePlus size={16}/> Save story</button>
                {activeText && <button onClick={() => setIsAddingText(false)}>Cancel</button>}
              </div>
            </div>}
            {activeText && !isAddingText && <>
              <div className="reader-toolbar">
                <div className="segmented small"><button className={readerMode === 'sentence' ? 'active' : ''} onClick={() => setReaderMode('sentence')}>Sentence</button><button className={readerMode === 'full' ? 'active' : ''} onClick={() => setReaderMode('full')}>Full text</button></div>
                {readerMode === 'sentence' && <div className="pager"><button onClick={() => setSentenceIndex(Math.max(0, sentenceIndex - 1))}>Previous</button><span>{Math.min(sentenceIndex + 1, sentences.length)} / {sentences.length}</span><button onClick={() => setSentenceIndex(Math.min(sentences.length - 1, sentenceIndex + 1))}>Next</button></div>}
                <div className="button-row reader-actions">
                  <button disabled={!activeLexicon} onClick={() => void addSelectedPhrase()}><Search size={16}/> Look up</button>
                  <button disabled={!activeLexicon} onClick={() => void addSelectedPhrase()}>Add phrase</button>
                  {selectedReaderPhrase && <button className="ghost" onClick={() => setReaderTokenSelection([])}>Clear</button>}
                </div>
                <label className="rate-control">Speed <input type="range" min="0.25" max="1" step="0.05" value={speechRate} onChange={event => setSpeechRate(Number(event.target.value))}/><span>{speechRate.toFixed(2)}x</span></label>
                <button className={isReading ? 'danger' : ''} onClick={() => isReading ? stopSpeech() : speak(sentenceToText(visibleSentences.flatMap(s => s.tokens)))}>{isReading ? 'Stop' : 'Read'}</button>
                {selectedReaderPhrase && <div className="phrase-preview">{selectedReaderPhrase}</div>}
              </div>
              <article className="reader-text">
                {visibleSentences.map((s, si) => {
                  const sentenceOrder = readerMode === 'sentence' ? sentenceIndex + si : si;
                  const phraseTokenClasses = phraseClasses(s.tokens);
                  return <p key={`${s.raw}-${si}`}>{s.tokens.map((token, ti) => {
                    const trailingSpace = needsTrailingSpace(s.tokens, ti) ? ' ' : '';
                    return isWordToken(token)
                    ? (() => {
                      const readerTokenKey = `${sentenceOrder}:${ti}`;
                      const isManuallySelected = readerTokenSelection.some(item => item.key === readerTokenKey);
                      return <Fragment key={`${token}-${ti}`}>
                        <span
                        key={`${token}-${ti}`}
                        role="button"
                        tabIndex={0}
                        data-reader-token="true"
                        data-reader-token-key={readerTokenKey}
                        className={tokenClass(token, phraseTokenClasses[ti], isManuallySelected)}
                        onClick={event => {
                          if (event.ctrlKey || event.metaKey) {
                            event.preventDefault();
                            toggleReaderToken(token, readerTokenKey, sentenceOrder * 10000 + ti);
                            return;
                          }
                          if (!hasActiveSelection()) openToken(token, event.currentTarget.getBoundingClientRect());
                        }}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            openToken(token, event.currentTarget.getBoundingClientRect());
                          }
                        }}
                        >{token}</span>
                        {trailingSpace}
                      </Fragment>;
                    })()
                    : <Fragment key={`${token}-${ti}`}><span className="punct">{token}</span>{trailingSpace}</Fragment>;
                  })}</p>;
                })}
              </article>
            </>}
          </div>
          {selected && readerPopup.open && <div
            ref={popupRef}
            className="reader-popup panel"
            style={{ left: readerPopup.x, top: readerPopup.y }}
          >
            <div
              className="reader-popup-titlebar"
              onPointerDown={startPopupDrag}
              onPointerMove={movePopupDrag}
              onPointerUp={stopPopupDrag}
              onPointerCancel={stopPopupDrag}
            >
              <span>Lexicon entry</span>
              <div className="button-row">
                <button className="ghost" onClick={recenterReaderPopup} title="Recenter"><RotateCcw size={15}/></button>
                <button className="ghost" onClick={() => setReaderPopup(current => ({ ...current, open: false }))} title="Close"><X size={15}/></button>
              </div>
            </div>
            <div className="entry-editor reader-popup-editor">
              <EntryEditorFields selected={selected} onChange={updateSelected} onDeepL={openDeepL} onDelete={deleteSelectedEntry} />
            </div>
          </div>}
        </section>}

        {view === 'dictionary' && <section className="panel dictionary-panel">
          <label className="search"><Search size={16}/><input placeholder="Search target, definition, or notes" value={query} onChange={e => setQuery(e.target.value)} /></label>
          <div className="entry-list">{filteredEntries.map(e => <button key={e.id} onClick={() => setSelected(e)} className={selected?.id === e.id ? 'active' : ''}><strong>{e.target}</strong><span>{e.native.join(' • ') || 'No definition'}</span><em>{statusLabel[e.status]}</em></button>)}</div>
          <EntryEditor selected={selected} onChange={updateSelected} onDeepL={openDeepL} onDelete={deleteSelectedEntry} />
        </section>}

        {view === 'review' && <section className="review-grid">
          <ReviewColumn title="Familiar flashcards" entries={familiar} actionLabel="Mark seen" onAction={e => upsertEntry(e.target, { status: 2 })}/>
          <ReviewColumn title="SRS practice" entries={due} actionLabel="Mark known" onAction={e => upsertEntry(e.target, { status: 4 })}/>
        </section>}
      </main>
    </div>
  );
}

function EntryEditor({ selected, onChange, onDeepL, onDelete }: { selected: LexiconEntry | null; onChange: (patch: Partial<LexiconEntry>) => void; onDeepL: (text: string) => void; onDelete: () => void }) {
  if (!selected) return <aside className="panel entry-editor empty"><p>Select a word to edit its lexicon entry.</p></aside>;
  return <aside className="panel entry-editor">
    <EntryEditorFields selected={selected} onChange={onChange} onDeepL={onDeepL} onDelete={onDelete} />
  </aside>;
}

function EntryEditorFields({ selected, onChange, onDeepL, onDelete }: { selected: LexiconEntry; onChange: (patch: Partial<LexiconEntry>) => void; onDeepL: (text: string) => void; onDelete: () => void }) {
  const [nativeText, setNativeText] = useState('');
  const [notes, setNotes] = useState('');
  useEffect(() => { setNativeText((selected.native || []).join('\n')); setNotes(selected.notes || ''); }, [selected.id, selected.native, selected.notes]);
  return <>
    <header><h2>{selected.target}</h2><button onClick={() => onDeepL(selected.target)}>DeepL</button></header>
    <label>Status<select value={selected.status} onChange={e => onChange({ status: clampStatus(e.target.value) })}>{statusLabel.map((label, i) => <option key={label} value={i}>{i} - {label}</option>)}</select></label>
    <div className="status-actions">{statusLabel.map((label, status) => <button key={label} className={selected.status === status ? 'active' : ''} onClick={() => onChange({ status: clampStatus(status) })}>{label}</button>)}</div>
    <label>Definitions<textarea value={nativeText} onChange={e => setNativeText(e.target.value)} onBlur={() => onChange({ native: splitLines(nativeText) })}/></label>
    <label>Notes<textarea value={notes} onChange={e => setNotes(e.target.value)} onBlur={() => onChange({ notes })}/></label>
    <div className="entry-editor-actions">
      <button className="primary" onClick={() => onChange({ native: splitLines(nativeText), notes })}><Save size={16}/> Save</button>
      <button className="danger" onClick={onDelete}>Delete</button>
    </div>
  </>;
}

function ReviewColumn({ title, entries, actionLabel, onAction }: { title: string; entries: LexiconEntry[]; actionLabel: string; onAction: (entry: LexiconEntry) => void }) {
  const [index, setIndex] = useState(0);
  const entry = entries[index % Math.max(entries.length, 1)];
  return <section className="panel review-card"><h2>{title}</h2>{entry ? <><div className="flash-term">{entry.target}</div><div className="flash-defs">{entry.native.join(' • ') || 'No definition yet'}</div><div className="button-row"><button onClick={() => setIndex(index + 1)}>Next</button><button className="primary" onClick={() => onAction(entry)}>{actionLabel}</button></div></> : <p>No entries here yet.</p>}</section>;
}
