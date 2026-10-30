// UH Parrot main application.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const SAMPLE_RATE = 16000;

  const ui = {
    recBtn: $('recBtn'), status: $('status'), note: $('note'), copyBtn: $('copyBtn'), clearBtn: $('clearBtn'),
    undoBtn: $('undoBtn'), modelSel: $('modelSel'), micSel: $('micSel'),
    fuzzyChk: $('fuzzyChk'), autoCopyChk: $('autoCopyChk'), vocabBox: $('vocabBox'), saveVocabBtn: $('saveVocabBtn'),
    vocabCount: $('vocabCount'), progress: $('progress'), progressBar: $('progressBar'), progressText: $('progressText'),
    settingsBtn: $('settingsBtn'), settings: $('settings'), level: $('level'), wordCount: $('wordCount'),
    toast: $('toast'), helpBtn: $('helpBtn'), help: $('help'), downloadBtn: $('downloadBtn'), fontBtn: $('fontBtn'),
    engineInfo: $('engineInfo'), queue: $('queue'),
  };

  // ---------- State ----------
  let worker = null, modelReady = false, recording = false;
  let audioCtx = null, mediaStream = null, processor = null, sourceNode = null;
  let segment = [], segLen = 0, preRoll = [], preRollLen = 0, silenceFrames = 0, inSpeech = false;
  let noiseFloor = 0.005;
  let pending = 0, seq = 0;
  const history = [];   // undo stack of textarea values
  const lastInsert = { start: 0, end: 0 };
  let userStopped = false;

  const prefs = JSON.parse(localStorage.getItem('parrot.prefs') || '{}');
  function savePrefs() { localStorage.setItem('parrot.prefs', JSON.stringify(prefs)); }

  // ---------- Vocabulary ----------
  TextEngine.loadBuiltin();
  const customVocab = localStorage.getItem('parrot.vocab') || '';
  ui.vocabBox.value = customVocab;
  TextEngine.loadCustom(customVocab);
  TextEngine.compile();
  function refreshVocabCount() {
    const s = TextEngine.stats();
    ui.vocabCount.textContent = s.canonical.toLocaleString() + ' terms, ' + s.variants.toLocaleString() + ' spoken variants';
  }
  refreshVocabCount();

  $('exportVocabBtn').onclick = () => {
    const blob = new Blob([ui.vocabBox.value || ''], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'uh-parrot-vocabulary.txt'; a.click();
  };
  $('importVocabBtn').onclick = () => $('importVocabFile').click();
  $('importVocabFile').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { ui.vocabBox.value = (ui.vocabBox.value ? ui.vocabBox.value.replace(/\s*$/, '') + '\n' : '') + String(r.result).trim(); ui.saveVocabBtn.click(); };
    r.readAsText(f); e.target.value = '';
  };
  ui.saveVocabBtn.onclick = () => {
    localStorage.setItem('parrot.vocab', ui.vocabBox.value);
    TextEngine.loadCustom(ui.vocabBox.value);
    TextEngine.compile();
    refreshVocabCount();
    sendPrompt();
    toast('Vocabulary saved');
  };

  // ---------- Editor helpers ----------
  function pushHistory() { history.push(ui.note.value); if (history.length > 50) history.shift(); }
  function undo() { if (!history.length) return; ui.note.value = history.pop(); updateCount(); }
  ui.undoBtn.onclick = undo;

  function insertText(txt) {
    if (!txt) return;
    pushHistory();
    const el = ui.note;
    const start = el.selectionStart, end = el.selectionEnd;
    const before = el.value.slice(0, start), after = el.value.slice(end);
    let lead = '';
    if (before && !/\s$/.test(before) && !/^\n/.test(txt)) lead = ' ';
    // Capitalize if we're at the start of a sentence in the existing text
    if (/(^|[.!?]\s*|\n)$/.test(before) && /^[a-z]/.test(txt)) txt = txt[0].toUpperCase() + txt.slice(1);
    // Lowercase first letter if continuing a sentence and the word isn't a known proper noun
    const ins = lead + txt;
    el.value = before + ins + after;
    lastInsert.start = start; lastInsert.end = start + ins.length;
    const pos = start + ins.length;
    el.setSelectionRange(pos, pos);
    el.scrollTop = el.scrollHeight;
    updateCount();
  }

  function deleteLastWord() {
    pushHistory();
    const el = ui.note; const pos = el.selectionStart;
    const before = el.value.slice(0, pos).replace(/\s*\S+\s*$/, '');
    el.value = before + el.value.slice(pos);
    el.setSelectionRange(before.length, before.length); updateCount();
  }
  function deleteLastSentence() {
    pushHistory();
    const el = ui.note; const pos = el.selectionStart;
    let before = el.value.slice(0, pos).replace(/\s*$/, '');
    // Drop the trailing sentence: everything after the last sentence end (. ! ?) or line break that precedes it.
    let idx = -1; const re = /[.!?](?=\s)|\n/g; let m;
    while ((m = re.exec(before)) !== null) { if (m.index < before.length - 1) idx = m.index; }
    before = idx >= 0 ? before.slice(0, idx + 1) : '';
    el.value = before + el.value.slice(pos);
    el.setSelectionRange(before.length, before.length); updateCount();
  }
  function transformLast(fn) {
    const el = ui.note;
    if (lastInsert.end <= lastInsert.start) return;
    pushHistory();
    const seg = el.value.slice(lastInsert.start, lastInsert.end);
    el.value = el.value.slice(0, lastInsert.start) + fn(seg) + el.value.slice(lastInsert.end);
    updateCount();
  }

  function updateCount() {
    const w = ui.note.value.trim() ? ui.note.value.trim().split(/\s+/).length : 0;
    ui.wordCount.textContent = w + ' words';
    localStorage.setItem('parrot.draft', ui.note.value);
  }
  ui.note.addEventListener('input', updateCount);
  // Restore draft from this browser session (survives an accidental refresh)
  if (localStorage.getItem('parrot.draft')) { ui.note.value = localStorage.getItem('parrot.draft'); updateCount(); }

  async function copyNote() {
    const text = ui.note.value;
    if (!text.trim()) { toast('Nothing to copy'); return; }
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard. Paste into Epic with Ctrl+V.');
    } catch (e) {
      ui.note.select(); document.execCommand('copy');
      toast('Copied to clipboard.');
    }
  }
  ui.copyBtn.onclick = copyNote;
  ui.clearBtn.onclick = () => { const extra = kept.length ? ' (Your ' + kept.length + ' kept recording segments stay; use Settings to erase those.)' : ''; if (!ui.note.value.trim() || confirm('Clear the note?' + extra)) { pushHistory(); ui.note.value = ''; updateCount(); } };
  ui.downloadBtn.onclick = () => {
    const blob = new Blob([ui.note.value], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'dictation-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.txt'; a.click();
  };
  ui.fontBtn.onclick = () => { prefs.bigFont = !prefs.bigFont; document.body.classList.toggle('bigfont', !!prefs.bigFont); savePrefs(); };
  if (prefs.bigFont) document.body.classList.add('bigfont');

  // ---------- Recording capture (for building a real-voice test set) ----------
  const kept = []; // { audio: Float32Array, raw, processed, t }
  ui.keepAudioChk = $('keepAudioChk'); ui.downloadAudioBtn = $('downloadAudioBtn');
  if (prefs.keepAudio === undefined) { prefs.keepAudio = true; savePrefs(); } // v2 test builds: keep recordings on by default
  ui.keepAudioChk.checked = !!prefs.keepAudio; ui.keepAudioChk.onchange = () => { prefs.keepAudio = ui.keepAudioChk.checked; savePrefs(); };
  function keepClip(audio, raw, processed) {
    if (!prefs.keepAudio) return;
    kept.push({ audio, raw, processed, t: new Date().toISOString() });
    ui.downloadAudioBtn.textContent = 'Download recordings (' + kept.length + ')';
  }
  function wavBytes(f32) {
    const n = f32.length, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767))), true);
    return new Uint8Array(b);
  }
  // Minimal ZIP writer (stored, no compression) so no library is needed.
  function makeZip(files) {
    const crcTable = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[i] = c >>> 0; }
    const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = f.data, crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true); lh.setUint16(8, 0, true); lh.setUint16(10, 0, true); lh.setUint16(12, 0, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0, true); ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    let cdSize = 0; for (const c of central) cdSize += c.length;
    const end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }
  ui.downloadAudioBtn.onclick = () => {
    if (!kept.length) { toast('No recordings kept yet. Turn on the checkbox, then dictate.'); return; }
    const files = []; const lines = ['clip\ttime\tengine_raw\tafter_correction'];
    kept.forEach((k, i) => { const name = 'clip' + String(i + 1).padStart(3, '0') + '.wav'; files.push({ name, data: wavBytes(k.audio) }); const cell = (x) => String(x || '').replace(/[\t\r\n]+/g, ' '); lines.push([name, k.t, cell(k.raw), cell(k.processed)].join('\t')); });
    files.push({ name: 'transcripts.tsv', data: new TextEncoder().encode(lines.join('\n')) });
    const a = document.createElement('a'); a.href = URL.createObjectURL(makeZip(files)); a.download = 'uh-parrot-recordings-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.zip'; a.click();
  };

  ui.clearAllBtn = $('clearAllBtn');
  ui.clearAllBtn.onclick = () => {
    const n = kept.length;
    if (!confirm('Start over?\n\nThis erases the note text AND the ' + n + ' kept recording segment' + (n === 1 ? '' : 's') + ' in this tab. Download the recordings first if you want to keep them.')) return;
    if (recording) stopRecording();
    kept.length = 0; pendingAudio.clear();
    ui.downloadAudioBtn.textContent = 'Download recordings (0)';
    pushHistory(); ui.note.value = ''; updateCount(); sendContext();
    toast('Note and recordings cleared');
  };

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg) { ui.toast.textContent = msg; ui.toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 3500); }

  // ---------- Settings / help panels ----------
  ui.settingsBtn.onclick = () => { ui.settings.classList.toggle('open'); ui.help.classList.remove('open'); };
  ui.helpBtn.onclick = () => { ui.help.classList.toggle('open'); ui.settings.classList.remove('open'); };
  if (ui.fuzzyChk) { ui.fuzzyChk.checked = !!prefs.fuzzy; ui.fuzzyChk.onchange = () => { prefs.fuzzy = ui.fuzzyChk.checked; savePrefs(); }; } else { prefs.fuzzy = false; } // option retired in v2.1
  ui.autoCopyChk.checked = !!prefs.autoCopy; ui.autoCopyChk.onchange = () => { prefs.autoCopy = ui.autoCopyChk.checked; savePrefs(); };

  // ---------- Model / worker ----------
  function setStatus(txt, cls) { ui.status.textContent = txt; ui.status.className = 'status ' + (cls || ''); }

  function startWorker(modelName) {
    if (worker && !window.PARROT_PRESTARTED_WORKER) { worker.terminate(); worker = null; }
    modelReady = false;
    ui.recBtn.disabled = true;
    ui.progress.classList.add('show');
    ui.progressText.textContent = 'Loading speech model… the first load fetches about 80 MB; after that it opens in seconds';
    setStatus('Loading model…', 'loading');
    worker = window.PARROT_PRESTARTED_WORKER || new Worker('worker.js', { type: 'module' });
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'engine-ready') { sendPrompt(); worker.postMessage({ type: 'load', model: modelName }); return; }
      if (m.type === 'progress') {
        const pct = Math.max(0, Math.min(100, Math.round(m.progress || 0)));
        ui.progressBar.style.width = pct + '%';
        if (m.file) {
          // Friendly, fixed-width label so the line never re-wraps on a phone while the percentage ticks.
          const f = m.file.split('/').pop();
          const part = /encoder/.test(f) ? 'part 2 of 3' : /decoder/.test(f) ? 'part 3 of 3' : /tokenizer|config|preprocessor/.test(f) ? 'part 1 of 3' : f;
          ui.progressText.textContent = '';
          ui.progressText.append('Loading speech model, ' + part + ' \u00b7 ');
          const sp = document.createElement('span'); sp.className = 'pct'; sp.textContent = pct + '%'; ui.progressText.append(sp);
        }
      } else if (m.type === 'ready') {
        modelReady = true;
        ui.progress.classList.remove('show');
        ui.recBtn.disabled = false;
        setStatus('Ready. Press Record or F2 and start dictating.', 'ready');
        ui.engineInfo.textContent = 'Engine: Whisper ' + m.model.replace('whisper-', '') + ' · ' + (m.threads > 1 ? m.threads + ' threads' : 'single thread') + ' · 100% offline';
      } else if (m.type === 'result') {
        pending = Math.max(0, pending - 1); updateQueue();
        const processed = handleTranscript(m.text, m.seconds, m.ms);
        if (pendingAudio.has(m.id)) { keepClip(pendingAudio.get(m.id), m.text, processed || ''); pendingAudio.delete(m.id); }
        settleStatus();
      } else if (m.type === 'error') {
        if (m.id !== undefined) { pending = Math.max(0, pending - 1); updateQueue(); settleStatus(); }
        console.error(m.message);
        setStatus(m.message, 'error');
        if (!modelReady) ui.progressText.textContent = m.message;
      }
    };
    worker.onerror = (e) => { console.error(e); setStatus('Worker error: ' + (e.message || 'see console'), 'error'); ui.progressText.textContent = 'Failed to start speech engine: ' + (e.message || ''); };
    // The worker posts 'engine-ready' once its imports are done; the load request is sent then.
  }

  if (prefs.model && ![...ui.modelSel.options].some(o => o.value === prefs.model)) { const o = document.createElement('option'); o.value = prefs.model; o.textContent = prefs.model; ui.modelSel.appendChild(o); }
  if (!window.PARROT_PRESTARTED_WORKER) {
    fetch('model/whisper-small.en/config.json', { method: 'HEAD' }).then(r => { if (!r.ok) throw 0; }).catch(() => {
      const o = [...ui.modelSel.options].find(x => x.value === 'whisper-small.en'); if (o) o.remove();
      if (prefs.model === 'whisper-small.en') { prefs.model = 'whisper-base.en'; savePrefs(); }
    });
  }
  ui.modelSel.value = window.PARROT_PRESTARTED_WORKER ? 'whisper-base.en' : (prefs.model || 'whisper-base.en');
  if (window.PARROT_PRESTARTED_WORKER) { ui.modelSel.disabled = true; ui.modelSel.title = 'The standalone file includes the Base model only'; }
  ui.modelSel.onchange = () => { prefs.model = ui.modelSel.value; savePrefs(); if (recording) stopRecording(); startWorker(prefs.model); };

  // Vocabulary prompt: the built-in surgical prompt plus the right-hand side of the user's own vocabulary lines.
  function customPromptTerms() {
    const terms = [];
    for (const raw of (ui.vocabBox.value || '').split('\n')) {
      const line = raw.trim(); if (!line || line.startsWith('#')) continue;
      const c = line.includes('=') ? line.split('=').pop().trim() : line.split('|')[0].trim();
      if (c) terms.push(c);
    }
    return terms.slice(0, 40).join(', ');
  }
  function sendPrompt() {
    if (!worker) return;
    const custom = customPromptTerms();
    worker.postMessage({ type: 'prompt', prompt: (window.PARROT_PROMPT || '') + (custom ? ' Also: ' + custom + '.' : '') });
  }
  function sendContext() {
    if (!worker) return;
    // Last ~300 characters of the note before the cursor, as rolling context for the next utterance.
    const pos = ui.note.selectionStart || ui.note.value.length;
    const tail = ui.note.value.slice(Math.max(0, pos - 300), pos).replace(/\s+/g, ' ').trim();
    worker.postMessage({ type: 'context', text: tail });
  }

  function updateQueue() { ui.queue.textContent = pending > 0 ? ('Transcribing ' + pending + '…') : ''; }
  // Refresh the status line once the queue drains (the last segment usually returns after Stop was pressed).
  let settleTimer = null;
  function settleStatus() {
    clearTimeout(settleTimer);
    if (!modelReady) return;
    if (pending > 0) {
      setStatus(recording ? 'Listening…' : 'Finishing transcription…', recording ? 'live' : 'ready');
      // Watchdog: a segment whose reply never arrives must not leave the UI stuck.
      settleTimer = setTimeout(() => { if (pending > 0) { console.warn('pending reset after timeout'); pending = 0; updateQueue(); settleStatus(); } }, 45000);
    } else {
      setStatus(recording ? 'Listening…' : 'Stopped. Press Record or F2 to continue.', recording ? 'live' : 'ready');
    }
  }

  function handleTranscript(raw, seconds, ms) {
    // Whisper sometimes hallucinates on near-silence; drop the usual suspects.
    const junk = /^(\s*|\[?blank[_ ]audio\]?|\(?(?:music|silence|inaudible|applause)\)?|thank you\.?|thanks for watching\.?|you\.?|the end\.?|bye\.?)$/i;
    if (!raw || junk.test(raw.trim())) return;
    const res = TextEngine.process(raw, { fuzzy: !!prefs.fuzzy });
    for (const a of res.actions) {
      if (a === 'undo') undo();
      else if (a === 'deleteWord') deleteLastWord();
      else if (a === 'deleteSentence') deleteLastSentence();
      else if (a === 'clear') { pushHistory(); ui.note.value = ''; updateCount(); }
      else if (a === 'copy') copyNote();
      else if (a === 'stop') { userStopped = true; stopRecording(); }
      else if (a === 'capLast') transformLast(s => s.replace(/^\s*([a-z])/, (m, c) => m.replace(c, c.toUpperCase())));
      else if (a === 'upperLast') transformLast(s => s.toUpperCase());
    }
    if (res.text) insertText(res.text);
    sendContext();
    if (recording) setStatus('Listening… (' + Math.round(seconds) + 's clip in ' + (ms / 1000).toFixed(1) + 's)', 'live');
    return res.text;
  }

  // ---------- Audio capture ----------
  async function listMics() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      ui.micSel.innerHTML = '';
      devs.filter(d => d.kind === 'audioinput').forEach((d, i) => {
        const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || ('Microphone ' + (i + 1));
        ui.micSel.appendChild(o);
      });
      if (prefs.mic && [...ui.micSel.options].some(o => o.value === prefs.mic)) ui.micSel.value = prefs.mic;
    } catch (e) { /* ignore */ }
  }
  ui.micSel.onchange = () => { prefs.mic = ui.micSel.value; savePrefs(); if (recording) { stopRecording(); startRecording(); } };

  function downsample(buf, inRate) {
    if (inRate === SAMPLE_RATE) return Float32Array.from(buf);
    const ratio = inRate / SAMPLE_RATE, n = Math.floor(buf.length / ratio), out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.floor(i * ratio), e = Math.min(buf.length, Math.floor((i + 1) * ratio));
      let sum = 0; for (let j = s; j < e; j++) sum += buf[j];
      out[i] = sum / Math.max(1, e - s);
    }
    return out;
  }

  const MAX_SEG = SAMPLE_RATE * 25;      // force a cut at 25 s
  const SILENCE_END = 1.1;                // seconds of silence that ends an utterance
  const PRE_ROLL = 0.35;                  // seconds kept before speech onset
  const MIN_SEG = 0.5;                    // ignore blips shorter than this

  function onAudio(e) {
    const inRate = e.inputBuffer.sampleRate;
    const chunk = downsample(e.inputBuffer.getChannelData(0), inRate);
    let sum = 0; for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    const rms = Math.sqrt(sum / chunk.length);
    // Adaptive noise floor. Learn only from frames already judged silent, rise slowly and fall fast,
    // and never let the floor climb to speaking level (that locked the recorder out after a few minutes of dictation).
    const threshold = Math.max(0.008, Math.min(0.025, noiseFloor * 3.0));
    if (!inSpeech && rms < threshold) noiseFloor = rms > noiseFloor ? noiseFloor * 0.995 + rms * 0.005 : noiseFloor * 0.9 + rms * 0.1;
    ui.level.style.width = Math.min(100, rms * 800) + '%';
    const frameSec = chunk.length / SAMPLE_RATE;

    if (rms > threshold) {
      if (!inSpeech) {
        inSpeech = true; segment = preRoll.slice(); segLen = preRollLen; preRoll = []; preRollLen = 0;
        setStatus('Listening…', 'live');
      }
      silenceFrames = 0;
      segment.push(chunk); segLen += chunk.length;
    } else if (inSpeech) {
      segment.push(chunk); segLen += chunk.length;
      silenceFrames += frameSec;
      if (silenceFrames >= SILENCE_END) flushSegment();
    } else {
      preRoll.push(chunk); preRollLen += chunk.length;
      while (preRollLen > PRE_ROLL * SAMPLE_RATE && preRoll.length > 1) { preRollLen -= preRoll[0].length; preRoll.shift(); }
    }
    if (segLen >= MAX_SEG) flushSegment();
  }

  function flushSegment() {
    if (!segLen) { inSpeech = false; return; }
    const buf = new Float32Array(segLen); let o = 0;
    for (const c of segment) { buf.set(c, o); o += c.length; }
    segment = []; segLen = 0; inSpeech = false; silenceFrames = 0;
    if (buf.length < MIN_SEG * SAMPLE_RATE) return;
    pending++; updateQueue(); settleStatus();
    const id = ++seq;
    if (prefs.keepAudio) pendingAudio.set(id, buf.slice());
    worker.postMessage({ type: 'transcribe', id, audio: buf }, [buf.buffer]);
  }
  const pendingAudio = new Map();

  async function startRecording() {
    if (!modelReady) { toast('Model is still loading'); return; }
    try {
      const constraints = { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
      if (prefs.mic) constraints.audio.deviceId = { exact: prefs.mic };
      mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      await listMics();
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      sourceNode = audioCtx.createMediaStreamSource(mediaStream);
      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = onAudio;
      sourceNode.connect(processor); processor.connect(audioCtx.destination);
      noiseFloor = 0.005; recording = true; userStopped = false; sendContext();
      ui.recBtn.classList.add('recording'); ui.recBtn.querySelector('.label').textContent = 'Stop';
      setStatus('Listening…', 'live');
      document.title = '● UH Parrot — recording';
    } catch (e) {
      console.error(e);
      let msg = 'Microphone error: ' + e.message;
      if (e.name === 'NotAllowedError') msg = 'Microphone blocked. Click the lock/camera icon in the address bar and allow the microphone, then try again.';
      if (e.name === 'NotFoundError') msg = 'No microphone found. Plug one in and try again.';
      if (!window.isSecureContext) msg = 'This page is not on HTTPS, so Chrome blocks the microphone. Ask IT to serve it over HTTPS or whitelist the URL.';
      setStatus(msg, 'error'); toast(msg);
    }
  }

  function stopRecording() {
    recording = false;
    if (inSpeech || segLen) flushSegment();
    try { processor && processor.disconnect(); sourceNode && sourceNode.disconnect(); } catch (e) { }
    try { mediaStream && mediaStream.getTracks().forEach(t => t.stop()); } catch (e) { }
    try { audioCtx && audioCtx.close(); } catch (e) { }
    processor = sourceNode = mediaStream = audioCtx = null;
    ui.level.style.width = '0%';
    ui.recBtn.classList.remove('recording'); ui.recBtn.querySelector('.label').textContent = 'Record';
    settleStatus();
    document.title = 'UH Parrot';
    if (prefs.autoCopy && ui.note.value.trim()) {
      const wait = () => { if (pending) return setTimeout(wait, 200); copyNote(); };
      wait();
    }
  }

  ui.recBtn.onclick = () => { if (recording) stopRecording(); else startRecording(); };

  // Keyboard shortcuts: F2 toggles recording, Ctrl+Shift+C copies, Ctrl+Z in textarea is native.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F2') { e.preventDefault(); ui.recBtn.click(); }
    else if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) { e.preventDefault(); copyNote(); }
    else if (e.key === 'Escape') { ui.settings.classList.remove('open'); ui.help.classList.remove('open'); }
  });

  // Show a clear message if the page is not a secure context (mic will be blocked).
  if (!window.isSecureContext) {
    setStatus('Not on HTTPS: Chrome will block the microphone on this page. IT needs to serve it over HTTPS or whitelist the URL.', 'error');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('This browser does not support microphone capture.', 'error');
  }

  // Test hook: feed a 16 kHz Float32Array straight to the engine (used by automated tests).
  window.ParrotTest = {
    feed(f32) { pending++; updateQueue(); worker.postMessage({ type: 'transcribe', id: ++seq, audio: f32 }); },
    ready: () => modelReady,
    text(raw) { return handleTranscript(raw, 1, 0); }, // feed engine text through commands/vocabulary into the note
    setPrompt(p) { worker.postMessage({ type: 'prompt', prompt: p }); },
    transcribe(f32) {
      return new Promise((resolve) => {
        const id = ++seq;
        const h = (ev) => { if (ev.data && ev.data.id === id && (ev.data.type === 'result' || ev.data.type === 'error')) { worker.removeEventListener('message', h); resolve(ev.data.text || ('[error] ' + ev.data.message)); } };
        worker.addEventListener('message', h);
        worker.postMessage({ type: 'transcribe', id, audio: f32 });
      });
    },
  };

  listMics();
  startWorker(ui.modelSel.value);
})();
