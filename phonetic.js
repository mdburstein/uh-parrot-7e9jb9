// UH Parrot phonetic matcher. Collapses a word to a consonant "sound key" and matches it against the sound keys
// of the medical dictionary, so misspellings like "coasistectimy" or "laproscopic" snap to the right term.
// Guard rails: only words of 7+ letters that are not already known and are not ordinary English words are touched.
(function () {
  'use strict';

  function key(word) {
    let w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (!w) return '';
    w = w.replace(/^(kn|gn|pn|ps|pt|wr)/, (m) => m[1]);
    w = w.replace(/sch/g, 'sk').replace(/ph/g, 'f').replace(/ch/g, 'k').replace(/ck/g, 'k').replace(/qu/g, 'kw').replace(/x/g, 'ks');
    w = w.replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/g(?=[eiy])/g, 'j').replace(/g/g, 'k');
    w = w.replace(/z/g, 's').replace(/q/g, 'k').replace(/v/g, 'f').replace(/d/g, 't').replace(/b/g, 'p').replace(/w/g, 'f');
    const first = w[0];
    w = first + w.slice(1).replace(/h/g, '');
    let rest = w.slice(1).replace(/[aeiouy]/g, '');
    let k = (/[aeiouy]/.test(first) ? 'a' : first) + rest;
    k = k.replace(/(.)\1+/g, '$1');
    return k;
  }

  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const prev = new Array(b.length + 1); for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      let cur = [i]; let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        cur.push(v); if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
  }

  const index = new Map(); // key -> canonical word (first wins; longer canonical phrase words are added by caller)
  const exact = new Set();   // lowercased canonical words
  let english = new Set();   // English words that must never be rewritten (built at build time)

  function build(canonicalWords, englishList) {
    index.clear(); exact.clear();
    english = new Set(englishList || []);
    for (const w of canonicalWords) {
      const lw = w.toLowerCase();
      exact.add(lw);
      const k = key(lw);
      if (k.length >= 4 && !index.has(k)) index.set(k, w);
    }
  }

  function candidate(word, strict) {
    const lw = word.toLowerCase();
    if (lw.length < 7 || exact.has(lw) || english.has(lw)) return null;
    const k = key(lw); if (k.length < 4) return null;
    const rawOk = (canon) => { const lim = Math.floor(lw.length * 0.5); return lev(lw, canon.toLowerCase(), lim) <= lim; };
    if (index.has(k)) return rawOk(index.get(k)) ? index.get(k) : null;
    if (strict) return null; // capitalized mid-sentence words (possible names) need an exact sound match
    // Short keys must match exactly (protects names like Burstein); longer keys get a small budget.
    const max = k.length >= 8 ? 2 : (k.length >= 6 ? 1 : 0);
    if (max === 0) return null;
    let best = null, bestD = max + 1;
    for (const [ik, canon] of index) {
      if (ik[0] !== k[0]) continue;
      if (Math.abs(ik.length - k.length) > (k.length >= 7 && ik.length >= 7 ? 2 : 1)) continue;
      // The written word must also be roughly the right length to be the same word.
      if (Math.abs(canon.length - lw.length) > 3) continue;
      const d = lev(k, ik, max);
      if (d < bestD) { bestD = d; best = canon; if (d === 0) break; }
    }
    if (bestD > max) return null;
    // Second signal: the raw spelling must be reasonably close too (sound keys alone are too forgiving).
    return rawOk(best) ? best : null;
  }

  // Try joining two adjacent tokens ("coli cystectomy") before single-token matching.
  function apply(text, isKnown) {
    // Split so that words, whitespace and punctuation are separate tokens; punctuation stays untouched.
    const tokens = text.split(/(\s+|[.,;:!?()"]+)/);
    let sentenceStart = true;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (/^[.!?]+$/.test(t) || /\n/.test(t)) { sentenceStart = true; continue; }
      if (/^\s+$/.test(t) || t === '' || /^[,;:()"]+$/.test(t)) continue;
      const wasStart = sentenceStart; sentenceStart = false;
      if (!/^[A-Za-z]{4,}$/.test(t)) continue;
      // Capitalized word mid-sentence may be a name: only an exact sound match may change it.
      const maybeName = !wasStart && /^[A-Z][a-z]/.test(t);
      const nxt = tokens[i + 2];
      if (nxt && /^\s+$/.test(tokens[i + 1] || '') && /^[A-Za-z]{4,}$/.test(nxt) && !english.has(t.toLowerCase()) && !english.has(nxt.toLowerCase()) && ((t.length >= 5 && !isKnown(t)) || (nxt.length >= 5 && !isKnown(nxt))) && !english.has(t.toLowerCase() + nxt.toLowerCase())) {
        const joined = t + nxt;
        const jk = key(joined);
        const c = index.get(jk);
        if (c && Math.abs(c.length - joined.length) <= 3 && lev(joined.toLowerCase(), c.toLowerCase(), Math.floor(joined.length * 0.5)) <= Math.floor(joined.length * 0.5)) { tokens[i] = c; tokens[i + 1] = ''; tokens[i + 2] = ''; i += 2; continue; }
      }
      if (isKnown(t)) continue;
      const c = candidate(t, maybeName);
      if (c) tokens[i] = c;
    }
    return applyWindows(tokens.join(''), isKnown);
  }

  // Whisper often breaks an unknown long word into several short English-looking words
  // ("coalsis tech to me" = cholecystectomy, "up and deck to me" = appendectomy, "fund application" = fundoplication).
  // Slide a window of 2-5 words, run the letters together, and collapse the window when the sound key matches a
  // long medical word exactly and the raw spelling is close enough.
  function applyWindows(text, isKnown) {
    const parts = text.split(/(\s+|[.,;:!?()"]+)/);
    const words = []; // indices in parts that are plain words
    for (let i = 0; i < parts.length; i++) if (/^[A-Za-z][A-Za-z'-]*$/.test(parts[i])) words.push(i);
    for (let wi = 0; wi < words.length; wi++) {
      let best = null;
      for (let len = 5; len >= 2; len--) {
        if (wi + len > words.length) continue;
        const idxs = words.slice(wi, wi + len);
        // All members must be adjacent (only whitespace between them): no crossing punctuation.
        let contiguous = true;
        for (let j = 1; j < idxs.length; j++) { for (let k = idxs[j - 1] + 1; k < idxs[j]; k++) if (!/^\s+$/.test(parts[k])) contiguous = false; }
        if (!contiguous) continue;
        const toks = idxs.map(i => parts[i]);
        // Skip windows made entirely of known medical words (already correct) and windows with a long known word.
        if (toks.every(t => isKnown(t))) continue;
        if (toks.some(t => t.length >= 8 && isKnown(t))) continue;
        const joined = toks.join('').replace(/[^A-Za-z]/g, '');
        if (joined.length < 9) continue;
        const k = key(joined); if (k.length < 6) continue;
        let canon = index.get(k);
        // One sound-edit of slack is allowed when the window contains a clearly garbled token (not English, not known).
        if (!canon && k.length >= 7 && toks.some(t => t.length >= 5 && !isKnown(t) && !english.has(t.toLowerCase()))) {
          for (const [ik, c2] of index) { if (ik[0] === k[0] && c2.length >= 10 && Math.abs(ik.length - k.length) <= 1 && lev(k, ik, 1) <= 1) { canon = c2; break; } }
        }
        if (!canon || canon.length < 9) continue;
        const lim = Math.floor(joined.length * 0.5);
        if (lev(joined.toLowerCase(), canon.toLowerCase(), lim) > lim) continue;
        best = { idxs, canon }; break; // longest window wins
      }
      if (best) {
        const first = best.idxs[0], last = best.idxs[best.idxs.length - 1];
        const cap = /^[A-Z]/.test(parts[first]) ? best.canon[0].toUpperCase() + best.canon.slice(1) : best.canon;
        parts[first] = cap; for (let k = first + 1; k <= last; k++) parts[k] = '';
        wi += best.idxs.length - 1;
      }
    }
    return parts.join('');
  }

  window.Phonetic = { key, build, candidate, apply };
})();
