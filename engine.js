// Shared speech-engine loop used by both the hosted worker (worker.js) and the standalone build.
// Calls the Whisper model directly (not through the pipeline) so we can feed it a vocabulary prompt:
// Whisper conditions on prior text, and a prompt full of surgical terms makes it spell them correctly.
export function startEngine(T) {
  const { env, AutoProcessor, AutoTokenizer, WhisperForConditionalGeneration } = T;
  let model = null, processor = null, tokenizer = null;
  let currentModel = null;
  let ids = { sot: null, prev: null, nots: null, eot: null };
  let promptText = '';          // vocabulary prompt (set by the page)
  let contextTail = '';         // last transcribed sentence, used as rolling context
  const MAX_PROMPT_TOKENS = 200; // Whisper allows ~224 prompt tokens
  const post = (msg) => self.postMessage(msg);

  async function load(modelName) {
    if (model && currentModel === modelName) { post({ type: 'ready', model: modelName }); return; }
    model = processor = tokenizer = null;
    currentModel = modelName;
    const seen = {};
    const progress_callback = (p) => {
      if (p.status === 'progress' && p.file) {
        seen[p.file] = p.progress || 0;
        const files = Object.values(seen);
        post({ type: 'progress', file: p.file, progress: files.reduce((a, b) => a + b, 0) / files.length });
      } else if (p.status === 'initiate' || p.status === 'download') post({ type: 'progress', file: p.file, progress: 0 });
    };
    try {
      [processor, tokenizer, model] = await Promise.all([
        AutoProcessor.from_pretrained(modelName, { progress_callback }),
        AutoTokenizer.from_pretrained(modelName, { progress_callback }),
        WhisperForConditionalGeneration.from_pretrained(modelName, { dtype: 'q8', device: 'wasm', progress_callback }),
      ]);
      ids.sot = tokenizer.convert_tokens_to_ids(['<|startoftranscript|>'])[0];
      ids.prev = tokenizer.convert_tokens_to_ids(['<|startofprev|>'])[0];
      ids.nots = tokenizer.convert_tokens_to_ids(['<|notimestamps|>'])[0];
      ids.eot = tokenizer.convert_tokens_to_ids(['<|endoftext|>'])[0];
      // Warm up so the first real utterance is fast.
      try { await transcribeRaw(new Float32Array(16000)); } catch (e) { /* ignore */ }
      post({ type: 'ready', model: modelName, threads: env.backends.onnx.wasm.numThreads });
    } catch (e) {
      post({ type: 'error', message: 'Model load failed: ' + (e && e.message ? e.message : String(e)) });
    }
  }

  function buildDecoderIds() {
    const start = [ids.sot, ids.nots];
    const text = [promptText, contextTail].filter(Boolean).join(' ').trim();
    if (!text) return start;
    let ptoks = tokenizer.encode(' ' + text, { add_special_tokens: false });
    if (ptoks.length > MAX_PROMPT_TOKENS) ptoks = ptoks.slice(ptoks.length - MAX_PROMPT_TOKENS); // keep the tail (context) if too long
    return [ids.prev, ...ptoks, ...start];
  }

  async function transcribeRaw(audio) {
    const inputs = await processor(audio);
    const dec = buildDecoderIds();
    const out = await model.generate({
      ...inputs,
      decoder_input_ids: dec,
      max_new_tokens: Math.min(220, 20 + Math.ceil(audio.length / 16000) * 12),
    });
    const seq = out[0].tolist ? out[0].tolist() : Array.from(out[0]);
    const gen = seq.slice(dec.length);
    return tokenizer.decode(gen, { skip_special_tokens: true }).trim();
  }

  async function transcribe(id, audio) {
    if (!model) { post({ type: 'error', id, message: 'Model not loaded' }); return; }
    const t0 = performance.now();
    try {
      const text = await transcribeRaw(audio);
      post({ type: 'result', id, text, ms: Math.round(performance.now() - t0), seconds: audio.length / 16000 });
    } catch (e) {
      post({ type: 'error', id, message: 'Transcription failed: ' + (e && e.message ? e.message : String(e)) });
    }
  }

  self.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'load') load(m.model);
    else if (m.type === 'transcribe') transcribe(m.id, m.audio);
    else if (m.type === 'prompt') { promptText = String(m.prompt || '').replace(/\s+/g, ' ').trim(); }
    else if (m.type === 'context') { contextTail = String(m.text || '').replace(/\s+/g, ' ').trim().slice(-300); }
  };
  post({ type: 'engine-ready' });
}
