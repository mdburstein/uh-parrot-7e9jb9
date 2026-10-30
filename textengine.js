// UH Parrot text engine: voice commands, medical vocabulary correction, formatting.
(function () {
  'use strict';

  // ---------- Vocabulary index ----------
  // Each MEDTERMS line: "Canonical|variant|variant". The canonical term itself,
  // lowercased, is also a variant so "nissen fundoplication" -> "Nissen fundoplication".
  const ENGLISH_STOP = new Set(('a an the is are was were be been am all and or but if so no not yes hit fast map pad pet lift flip hi id sis mess bid sat mac mi ms pe ot si cap tap pod bun tis aka gist poem tee era doe ned nad hap cad ale ami ali tar vats sits bolt bun pals oasis stop clear good poor fair stable pending daily clean dirty frail it in on at to of for by with from as that this these those his her he she we they you i my me our us them their its had has have do did does done can could will would shall should may might must about above after again against below between both down during each few further here how more most other out over own same some such than then there through too under until up very what when where which who whom why into onto upon off per via plus minus times less least last next first second third one two three four five six seven eight nine ten lap pt rt lt sob dot bar jar cat rat hat bat mat fat vat sap gap nap rap tab lab dab jab cab fab mob job rob sob cob fog log dog hog bog hug jug mug rug tug bug pin tin bin fin din win sin kin gin ten pen hen men den fen gun run sun fun bun nun pun hum gum sum rum bum mum cut hut nut rut but put jut gut tut sat bat cat rat hat mat fat pat tat vat sit bit fit hit kit lit pit wit nit zit set bet get jet let met net pet wet yet vet rot cot dot got hot jot lot not pot tot art ant arm ash ask age ace act add aid aim air ale ale any ape apt arc are ark asp ate awe axe aye bad bag ban bay bed bee beg bud bus buy bye cam cap car caw cod cog con cop cow coy cry cub cue cup cur dam day dew dig dim dip doe dry dub due dug dye ear eat eel egg ego eke elf elk elm end eon era err eve ewe eye fad fan far fax fed fee few fig fir fix flu fly foe fop for fox fro fry fur gab gag gal gas gay gel gem god goo gym had hag ham has hay hem hew hex hey hid him hip hoe hop how hue icy ilk ill imp ink inn ion ire irk ivy jam jaw jay jig jog joy key kid kin lad lag lam law lax lay lea led leg lid lie lip lob lug lye mad man mar maw may mew mid mix moo mop mow mud nab nag nay new nil nip nod nor now oaf oak oar oat odd ode oft oil old one opt orb ore our out owe owl own pal pan paw pay pea peg pew pie pig ply pod pop pox pro pry pub pug pus rag raj ram ran raw ray red rib rid rig rim rip rod roe row rub rue rum rye sad sag saw say sea see sew sex shy ski sky sly sob sod son sop sow soy spa spy sty sub sue tan tap tar tax tea thy tic tie tip toe ton top tow toy try tub two urn use van vex vie vow wad wag war wax way web wed wee wig wok won woo wry yak yam yap yaw yen yew yon zap zip zoo').split(/\s+/));
  const variantToCanonical = new Map();   // lowercased variant -> canonical
  const canonicalSet = new Set();
  let compiled = null;

  function norm(s) {
    return s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
  }

  function addEntry(line) {
    const parts = line.split('|').map(p => p.trim()).filter(Boolean);
    if (!parts.length) return;
    const canonical = parts[0];
    canonicalSet.add(canonical);
    const lc = norm(canonical);
    // Don't let an acronym capture an ordinary English word ("IS", "HIT", "FAST", "MAP", "PAD" ...).
    if (lc !== canonical && !(/^[A-Z0-9&\/-]{1,6}$/.test(canonical) && ENGLISH_STOP.has(lc))) variantToCanonical.set(lc, canonical);
    for (let i = 1; i < parts.length; i++) {
      const v = norm(parts[i]);
      if (!v || v === canonical) continue;
      // A variant that is a proper sub-phrase of its canonical form would expand on every pass
      // ("cholangiogram" -> "intraoperative cholangiogram" -> "intraoperative intraoperative ..."). Skip those.
      if (v !== lc && (' ' + lc + ' ').includes(' ' + v + ' ')) continue;
      variantToCanonical.set(v, canonical);
    }
  }

  function loadBuiltin() {
    (window.MEDTERMS || []).forEach(addEntry);
  }

  function loadCustom(text) {
    // One per line: "variant = Canonical"  or  "Canonical|variant|variant"
    (text || '').split('\n').forEach(raw => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      if (line.includes('=') && !line.includes('|')) {
        const [v, c] = line.split('=').map(s => s.trim());
        if (v && c) addEntry(c + '|' + v);
      } else {
        addEntry(line);
      }
    });
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Build one big alternation per length bucket so longest phrases win.
  function buildPhonetic() {
    if (!window.Phonetic) return;
    const words = new Set();
    for (const c of canonicalSet) for (const t of c.split(/[\s\/,()-]+/)) if (/^[A-Za-z]{7,}$/.test(t)) words.add(t);
    window.Phonetic.build([...words], window.ENGLISH_EXCLUSIONS || []);
    phoneticKnown = (w) => {
      const lw = w.toLowerCase();
      if (variantToCanonical.has(lw) || ENGLISH_STOP.has(lw) || knownWords.has(lw)) return true;
      // Inflections of known words (circumferentially, dissections) are known too.
      for (const suf of ['ly', 'ally', 's', 'es', 'ed', 'ing', 'ies']) {
        if (!lw.endsWith(suf) || lw.length - suf.length < 5) continue;
        const stem = lw.slice(0, -suf.length);
        if (knownWords.has(stem) || knownWords.has(stem + 'e') || knownWords.has(stem + 'y') || variantToCanonical.has(stem)) return true;
      }
      return false;
    };
    knownWords = new Set(); for (const w of words) knownWords.add(w.toLowerCase());
  }
  let phoneticKnown = null, knownWords = new Set();

  function compile() {
    buildPhonetic();
    const variants = Array.from(variantToCanonical.keys()).sort((a, b) => b.length - a.length);
    // Chunk into regexes of ~400 alternatives to keep each pattern manageable.
    const chunks = [];
    for (let i = 0; i < variants.length; i += 400) {
      const slice = variants.slice(i, i + 400).map(v =>
        escapeRe(v).replace(/ /g, '[\\s-]+').replace(/'/g, "['’]?"));
      chunks.push(new RegExp('(?<![A-Za-z0-9])(' + slice.join('|') + ')(?![A-Za-z0-9])', 'gi'));
    }
    compiled = chunks;
  }

  function applyVocabulary(text) {
    if (!compiled) compile();
    let out = text;
    for (const re of compiled) {
      out = out.replace(re, (m) => {
        const key = norm(m.replace(/[\s-]+/g, ' '));
        const c = variantToCanonical.get(key);
        if (!c) return m;
        return c;
      });
    }
    return out;
  }

  // ---------- Conservative fuzzy correction (optional) ----------
  const singleWordCanon = () => {
    const arr = [];
    for (const c of canonicalSet) if (!/\s/.test(c) && c.length >= 7 && /^[A-Za-z-]+$/.test(c)) arr.push(c);
    return arr;
  };
  let fuzzyList = null;

  function editDistance1(a, b) {
    // true if Damerau-Levenshtein distance <= 1
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < la && j < lb) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (edits) return false;
      edits++;
      if (la === lb) {
        if (a[i + 1] === b[j] && a[i] === b[j + 1]) { i += 2; j += 2; } else { i++; j++; }
      } else if (la > lb) i++; else j++;
    }
    return edits + (la - i) + (lb - j) <= 1;
  }

  function applyFuzzy(text) {
    if (!fuzzyList) fuzzyList = singleWordCanon();
    return text.replace(/[A-Za-z][A-Za-z-]{6,}/g, (w) => {
      const lw = w.toLowerCase();
      if (variantToCanonical.has(lw) || canonicalSet.has(w)) return w;
      for (const c of fuzzyList) {
        const lc = c.toLowerCase();
        if (lc[0] !== lw[0]) continue; // keep it conservative
        if (editDistance1(lw, lc)) return c;
      }
      return w;
    });
  }

  // ---------- Number and suture formatting ----------
  const wordNum = { zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const sutureNames = '(Vicryl|Monocryl|PDS|Prolene|Ethibond|Ethilon|Nurolon|Mersilene|Ti-Cron|Maxon|Biosyn|Polysorb|Dexon|V-Loc|Stratafix|Quill|Surgipro|Novafil|Dermalon|Monosof|silk|nylon|chromic|plain gut|gut|catgut|Gore-Tex|Fiberwire|Surgilon|Pronova|Caprosyn|polypropylene|polydioxanone)';

  function formatSutures(text) {
    let t = text;
    // "three oh vicryl", "3 oh vicryl", "3-oh vicryl", "three o vicryl", "3 0 vicryl" -> "3-0 Vicryl"
    t = t.replace(new RegExp('\\b(?<!figure[\\s-]of[\\s-])(\\d|zero|one|two|three|four|five|six|seven|eight|nine|ten)[\\s-]+(oh|o|0|zero)[\\s-]+(?=' + sutureNames + ')', 'gi'),
      (m, n) => (isNaN(n) ? wordNum[n.toLowerCase()] : n) + '-0 ');
    // "double oh vicryl" -> "2-0 Vicryl"; "triple oh" -> "3-0"
    t = t.replace(new RegExp('\\bdouble[\\s-]+(oh|o|zero)[\\s-]+(?=' + sutureNames + ')', 'gi'), '2-0 ');
    t = t.replace(new RegExp('\\btriple[\\s-]+(oh|o|zero)[\\s-]+(?=' + sutureNames + ')', 'gi'), '3-0 ');
    // "number one PDS", "number 1 PDS" -> "#1 PDS"
    t = t.replace(new RegExp('\\bnumber[\\s-]+(\\d|one|two|three|four|five|zero|oh)[\\s-]+(?=' + sutureNames + ')', 'gi'),
      (m, n) => '#' + (isNaN(n) ? wordNum[n.toLowerCase()] : n) + ' ');
    // "5 o' nylon", "4 o nylon" -> "5-0 nylon"
    t = t.replace(new RegExp("\\b(\\d)[\\s-]*o['’]?[\\s-]+(?=" + sutureNames + ')', 'gi'), '$1-0 ');
    // bare "oh vicryl" / "zero vicryl" at word start -> "0 Vicryl"
    t = t.replace(new RegExp('(^|[\\s(])(oh|o|zero)[\\s-]+(?=' + sutureNames + ')', 'gi'), '$10 ');
    // "3 oh" without suture following but preceded by "a" e.g. "a 3-0 was used": leave.
    return t;
  }

  // Spoken numbers -> digits, only when followed by a unit or measurement word, so prose like
  // "two drains" or "one liter" stays natural unless a unit follows.
  const ones = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
  const tens = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  const numWordRe = '(?:(?:one|two|three|four|five|six|seven|eight|nine)\\s+hundred(?:\\s+(?:and\\s+)?)?)?(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?|(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen))(?:\\s+point\\s+(?:zero|one|two|three|four|five|six|seven|eight|nine))?';
  const unitFollow = '(?=\\s+(?:cc|ccs|ml|mls|milliliters?|millilitres?|mils?|cm|centimeters?|centimetres?|mm|millimeters?|millimetres?|mg|milligrams?|mcg|micrograms?|grams?|kilograms?|kilos?|liters?|litres?|units?|french|percent|degrees?|millimeters? of mercury|mmhg|by|times|o\'?clock|out of|over|weeks?|days?|hours?|minutes?|seconds?|pounds?|inch|inches|feet|foot|years? old|year old|liters? of|hundred|thousand|gauge|french)\\b)';
  const numRe = new RegExp('\\b(' + numWordRe + ')' + unitFollow, 'gi');

  function wordsToNumber(s) {
    s = s.toLowerCase().replace(/-/g, ' ');
    let frac = null; const pm = s.match(/\s+point\s+(\w+)$/); if (pm) { frac = ones[pm[1]]; s = s.replace(/\s+point\s+\w+$/, ''); }
    let total = 0, cur = 0;
    for (const w of s.split(/\s+/)) {
      if (w === 'and') continue;
      if (w === 'hundred') { cur = (cur || 1) * 100; total += cur; cur = 0; }
      else if (w in tens) cur += tens[w];
      else if (w in ones) cur += ones[w];
    }
    total += cur;
    return frac === null ? String(total) : total + '.' + frac;
  }

  function formatNumbers(text) {
    return text.replace(numRe, (m) => wordsToNumber(m));
  }

  function formatUnits(text) {
    let t = formatNumbers(text);
    t = t.replace(/\bE\.\s?A\.(?=\s|$)/g, 'EEA');
    t = t.replace(/\b(\d+)\s+by\s+(\d+)\b(?=\s+(?:cm|mm|centimeter|millimeter))/gi, '$1 x $2');
    t = t.replace(/\b(\d+(?:\.\d+)?)\s*(?:milliliters?|millilitres?|mils?|m\.?\s?l\.?)\b/gi, '$1 mL');
    t = t.replace(/\b(\d+(?:\.\d+)?)\s*(?:cc'?s|c\.?\s?c\.?)\b/gi, '$1 mL');
    t = t.replace(/\b(\d+(?:\.\d+)?)\s*(?:centimeters?|centimetres?)\b/gi, '$1 cm');
    t = t.replace(/\b(\d+(?:\.\d+)?)\s*(?:millimeters?|millimetres?)\b/gi, '$1 mm');
    t = t.replace(/\b(\d+(?:\.\d+)?)\s*(?:milligrams?)\b/gi, '$1 mg');
    t = t.replace(/\b(\d+(?:\.\d+)?)\s*(?:micrograms?|mcg)\b/gi, '$1 mcg');
    t = t.replace(/\b(\d+(?:\.\d+)?)\s*(?:kilograms?|kilos?)\b/gi, '$1 kg');
    t = t.replace(/\b(\d+(?:\.\d+)?)\s*(?:millimeters? of mercury|millimeters? mercury)\b/gi, '$1 mmHg');
    t = t.replace(/\b(\d+)\s*(?:percent)\b/gi, '$1%');
    t = t.replace(/\b(\d+)\s*(?:degrees?)\b(?!\s*(?:celsius|fahrenheit|c\b|f\b))/gi, '$1 degrees');
    t = t.replace(/\b(\d+)\s*(?:French)\b/g, '$1 French');
    t = t.replace(/\b(\d+)\s*by\s*(\d+)\s*(cm|mm)\b/gi, '$1 x $2 $3');
    t = t.replace(/\btimes\s+(\d+)\b/gi, 'x$1');
    t = t.replace(/\b(\d+)\s+out of\s+(\d+)\b/gi, '$1/$2');
    t = t.replace(/\b(\d+)\s+over\s+(\d+)\b/g, '$1/$2');
    t = t.replace(/\b(\d{1,2}) o'?clock\b/gi, "$1 o'clock");
    t = t.replace(/\b(\d+)[\s-]+year[\s-]+old\b/gi, '$1-year-old');
    t = t.replace(/\b(\d+)[\s-]+(?:month|week|day)[\s-]+old\b/gi, (m, n) => m.replace(/[\s-]+/g, '-'));
    return t;
  }

  // ---------- Voice commands ----------
  // Returns {text, actions:[...]} where actions are editor-level operations.
  const punct = [
    [/\b(?:full stop|period)\b/gi, '.'],
    [/\bcomma\b/gi, ','],
    [/\bsemicolon\b/gi, ';'],
    [/(?<!\b(?:the|sigmoid|transverse|descending|ascending|right|left|entire|his|her|of|proximal|distal|remaining|normal|redundant|dilated|collapsed)\s)\bcolon\b(?=\s+[a-z0-9])(?!\s*(?:cancer|resection|mass|polyp|wall|was|is|and|or|mucosa|the|to|a|an|were|appeared|appears|looked|had|has)\\b)/gi, ':'],
    [/\bquestion mark\b/gi, '?'],
    [/\bexclamation (?:point|mark)\b/gi, '!'],
    [/\bopen (?:paren|parenthesis|parentheses)\b/gi, '('],
    [/\bclose (?:paren|parenthesis|parentheses)\b/gi, ')'],
    [/\bopen quotes?\b/gi, '"'],
    [/\bclose quotes?\b/gi, '"'],
    [/\b(?:hyphen|dash)\b/gi, '-'],
    [/\bslash\b/gi, '/'],
    [/\bampersand\b/gi, '&'],
    [/\bat sign\b/gi, '@'],
    [/\bpercent sign\b/gi, '%'],
    [/\bplus sign\b/gi, '+'],
    [/\bnumber sign\b/gi, '#'],
    [/\bdegree sign\b/gi, '°'],
  ];

  function applyCommands(raw) {
    const actions = [];
    let t = ' ' + raw + ' ';

    // Editing commands (consume the whole utterance if it is only a command)
    const only = t.trim().replace(/[.,!?]+$/, '').toLowerCase();
    // Dragon-style: "scratch that" removes back to the end of the previous sentence. "undo" reverts the last insertion.
    if (/^(scratch that|delete that|strike that|erase that|take that back|scratch)$/.test(only)) return { text: '', actions: ['deleteSentence'] };
    if (/^(undo that|undo)$/.test(only)) return { text: '', actions: ['undo'] };
    if (/^(delete (?:last|previous) word|scratch (?:last|previous) word)$/.test(only)) return { text: '', actions: ['deleteWord'] };
    if (/^(delete (?:last|previous) sentence|scratch (?:last|previous) sentence)$/.test(only)) return { text: '', actions: ['deleteSentence'] };
    if (/^(select all|clear (?:all|everything|the )?(?:note|text)?|clear)$/.test(only)) return { text: '', actions: ['clear'] };
    if (/^(copy (?:that|note|text|all|it)?|copy to clipboard)$/.test(only)) return { text: '', actions: ['copy'] };
    if (/^(stop (?:dictation|dictating|recording|listening)|stop)$/.test(only)) return { text: '', actions: ['stop'] };
    if (/^(cap(?:italize)? that|capitalize)$/.test(only)) return { text: '', actions: ['capLast'] };
    if (/^(all caps that)$/.test(only)) return { text: '', actions: ['upperLast'] };

    // Inline structure commands
    t = t.replace(/\b(?:new paragraph|next paragraph|paragraph break|new paragraphs|new paragraf|new pair of graph)\b[.,]?/gi, '\n\n');
    t = t.replace(/\b(?:new line|next line|line break|next slide|new slide|newline|nextline|next lime|new lime|new lion|next lion)\b[.,]?/gi, '\n');
    t = t.replace(/\b(?:tab key|insert tab)\b/gi, '\t');
    t = t.replace(/\b(?:bullet point|new bullet|next bullet)\b[.,]?/gi, '\n• ');
    t = t.replace(/\bnumber next\b/gi, '\n');

    // Spoken punctuation
    for (const [re, rep] of punct) t = t.replace(re, rep);

    // Tidy spacing around punctuation and newlines
    t = t.replace(/\s+([.,;:?!)])/g, '$1');
    t = t.replace(/\(\s+/g, '(');
    t = t.replace(/([.,;:?!])(?=[A-Za-z])/g, '$1 ');
    t = t.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n');
    t = t.replace(/\.{2,}/g, '.').replace(/,{2,}/g, ',');
    t = t.replace(/[ \t]{2,}/g, ' ');
    return { text: t.trim(), actions };
  }

  // A decoder can fall into a loop ("the sutures period. the sutures period. ..."); keep one copy of any phrase of
  // two or more words that repeats three or more times in a row.
  function collapseLoops(t) {
    return t.replace(/((?:[A-Za-z0-9'’#%.\-]+[ \t]+){1,12}[A-Za-z0-9'’#%\-]+[.,;:]?[ \t]*)(?:\1){2,}/g, '$1');
  }

  function tidyPunctuation(t) {
    return t
      .replace(/(^|[^0-9])\.(\d)/g, '$10.$2')     // ".5%" -> "0.5%"
      .replace(/,(?=[A-Za-z0-9])/g, ', ')           // "skin,0.5%" -> "skin, 0.5%"
      .replace(/([.!?:;])\s*,\s*/g, '$1 ')      // "marked., antibiotic" -> "marked. antibiotic"
      .replace(/,\s*([.!?])/g, '$1')             // "suture,." -> "suture."
      .replace(/(\d\s*%)\s+(marking|markin|marcane)\b/gi, '$1 Marcaine') // "0.5% marking" -> "0.5% Marcaine"
      .replace(/\s{2,}/g, ' ');
  }

  function stripPauseCommas(t) {
    // A pause between an approach word and the procedure name becomes a stray comma; remove it.
    return t.replace(/\b(laparoscopic|robotic|robotic-assisted|open|bilateral|right|left|total|partial|diagnostic|exploratory|revision|redo)\s*,\s+(?=[A-Za-z]+(?:ectomy|ostomy|otomy|plasty|scopy|oscopy|pexy|rrhaphy|lysis|desis)\b|(?:inguinal|ventral|umbilical|hiatal|incisional|paraesophageal|femoral|hernia|appendectomy|cholecystectomy|colectomy|fundoplication|repair)\b)/gi, '$1 ');
  }

  function capitalizeSentences(text) {
    // Capitalize after sentence end and at the beginning, without touching mid-sentence proper nouns.
    return text.replace(/(^|[.!?]\s+|\n+)([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }

  // ---------- Pipeline ----------
  function process(raw, opts) {
    opts = opts || {};
    const cmd = applyCommands(raw);
    let t = cmd.text;
    if (t) {
      t = applyVocabulary(t);
      if (window.Phonetic && phoneticKnown) t = window.Phonetic.apply(t, phoneticKnown);
      t = applyVocabulary(t);
      if (opts.fuzzy) t = applyFuzzy(t);
      t = formatSutures(t);
      t = formatUnits(t);
      t = applyVocabulary(t); // second pass catches phrases exposed by formatting
      t = stripPauseCommas(t);
      t = collapseLoops(t);
      t = tidyPunctuation(t);
      t = capitalizeSentences(t);
    }
    return { text: t, actions: cmd.actions };
  }

  function stats() {
    return { variants: variantToCanonical.size, canonical: canonicalSet.size };
  }

  window.TextEngine = { loadBuiltin, loadCustom, compile, process, applyVocabulary, applyCommands, formatSutures, formatUnits, stats };
})();
