/*
 * Live Translate ES ⇄ EN
 * Continuous microphone transcription (Web Speech API) + instant translation.
 * Left panel: everything as spoken (Spanish + English).
 * Right panel: English only — spoken English verbatim, Spanish translated live.
 * No backend, no API keys: recognition runs in the browser, translation goes
 * straight to Google's public endpoint (MyMemory as fallback).
 */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);

  const micBtn = $('#micBtn');
  const clearBtn = $('#clearBtn');
  const langSelect = $('#langSelect');
  const statusDot = $('#statusDot');
  const statusText = $('#statusText');
  const entriesMixed = $('#entriesMixed');
  const entriesEnglish = $('#entriesEnglish');
  const liveMixed = $('#liveMixed');
  const liveEnglish = $('#liveEnglish');
  const feedMixed = $('#feedMixed');
  const feedEnglish = $('#feedEnglish');
  const overlay = $('#overlay');
  const overlayMsg = $('#overlayMsg');

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const SUPPORTED = Boolean(SpeechRec) && window.isSecureContext;

  if (!SpeechRec) {
    overlay.hidden = false;
  } else if (!window.isSecureContext) {
    overlay.hidden = false;
    overlayMsg.innerHTML =
      'Microphone access needs a secure page. Open this site over <strong>https://</strong> (or localhost) — opening the file directly will not work.';
  }

  // ---------- Constants ----------

  const GTX_URL =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&dj=1&q=';
  const MYMEMORY_URL = 'https://api.mymemory.translated.net/get?langpair=es|en&q=';
  const INTERIM_DEBOUNCE_MS = 220;

  // ---------- State ----------

  const state = {
    listening: false,
    rec: null,
    restartTimer: null,
    lastFinal: { text: '', at: 0 },
  };

  let segSeq = 0;
  const translationCache = new Map(); // text -> { english, src }
  let interimTimer = null;
  let interimAbort = null;
  let currentInterim = '';
  let wakeLock = null;

  // ---------- Language guessing (instant, local — refined by the API) ----------

  const ES_WORDS = new Set(
    ('el la los las un una unos unas de del al que y o pero es soy eres está estás estoy son somos en no sí ' +
      'un por con sin sobre como cómo más menos para porque qué cuándo cuándo dónde quién cuál hay este esta ' +
      'esto ese esa eso aquí allí ahora luego entonces también muy bien mal gracias hola señor señora usted ' +
      'ustedes yo tú él ella nosotros ellos ellas mi tu su nuestro me te se le lo nos les hacer tiene tengo ' +
      'tienes vamos puede puedo quiero quiere sabe sé dice digo días bueno buena todo toda nada algo').split(/\s+/)
  );
  const EN_WORDS = new Set(
    ('the a an of and or but is am are was were be been being to in on at it its this that these those you ' +
      'i we they he she what when where who which how very well thanks thank hello mr mrs miss my your his ' +
      'her our their me him them us do does did done have has had can could will would should want need know ' +
      'think say said go going get got yes no not with without about because so if then now here there').split(/\s+/)
  );

  function guessLang(text) {
    if (/[¿¡ñ]/i.test(text)) return 'es';
    let es = 0;
    let en = 0;
    const words = text.toLowerCase().replace(/[^\p{L}\s']/gu, ' ').split(/\s+/);
    for (const w of words) {
      if (!w) continue;
      if (ES_WORDS.has(w)) es++;
      if (EN_WORDS.has(w)) en++;
    }
    if (/[áéíóúü]/i.test(text)) es += 2;
    if (es === en) return langSelect.value.startsWith('en') ? 'en' : 'es';
    return es > en ? 'es' : 'en';
  }

  // ---------- Translation ----------

  async function translate(text, signal) {
    const cached = translationCache.get(text);
    if (cached) return cached;

    let out;
    try {
      const res = await fetch(GTX_URL + encodeURIComponent(text), { signal });
      if (!res.ok) throw new Error('gtx http ' + res.status);
      const json = await res.json();
      out = {
        english: (json.sentences || []).map((s) => s.trans || '').join('').trim(),
        src: json.src || guessLang(text),
      };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // Fallback: MyMemory (free, CORS-enabled, rate-limited)
      const src = guessLang(text);
      if (src === 'en') {
        out = { english: text, src: 'en' };
      } else {
        const res = await fetch(MYMEMORY_URL + encodeURIComponent(text), { signal });
        const json = await res.json();
        out = {
          english: (json && json.responseData && json.responseData.translatedText) || '',
          src: 'es',
        };
      }
    }

    if (out.english) {
      translationCache.set(text, out);
      if (translationCache.size > 500) {
        translationCache.delete(translationCache.keys().next().value);
      }
    }
    return out;
  }

  // ---------- Rendering ----------

  function stick(feed) {
    // Auto-scroll only if the user is already near the bottom.
    const gap = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
    if (gap < 120) feed.scrollTop = feed.scrollHeight;
  }

  function chipClass(lang) {
    if (lang === 'es') return 'es';
    if (lang === 'en') return 'en';
    return 'xx';
  }

  function fmtTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function makeEntry({ chip, chipCls, time, text, pending }) {
    const el = document.createElement('div');
    el.className = 'entry';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const chipEl = document.createElement('span');
    chipEl.className = 'chip ' + chipCls + (pending ? ' pending' : '');
    chipEl.textContent = chip;
    meta.appendChild(chipEl);
    if (time) {
      const timeEl = document.createElement('span');
      timeEl.className = 'time';
      timeEl.textContent = time;
      meta.appendChild(timeEl);
    }
    const textEl = document.createElement('p');
    textEl.className = 'text' + (pending ? ' pending' : '');
    textEl.textContent = text;
    el.appendChild(meta);
    el.appendChild(textEl);
    return el;
  }

  function finalizeUtterance(raw) {
    const text = raw.trim();
    if (!text) return;

    // Chrome occasionally re-fires the same final result after a restart.
    const now = Date.now();
    if (text === state.lastFinal.text && now - state.lastFinal.at < 2500) return;
    state.lastFinal = { text, at: now };

    clearLive();

    const seg = {
      id: ++segSeq,
      text,
      at: new Date(),
      lang: guessLang(text),
      english: null,
      ms: null,
    };

    const guessedEnglish = seg.lang === 'en';

    const mixedEl = makeEntry({
      chip: seg.lang.toUpperCase(),
      chipCls: chipClass(seg.lang),
      time: fmtTime(seg.at),
      text: seg.text,
      pending: true,
    });
    entriesMixed.appendChild(mixedEl);

    const engEl = makeEntry({
      chip: guessedEnglish ? 'EN' : '···',
      chipCls: guessedEnglish ? 'en' : 'xx',
      time: fmtTime(seg.at),
      text: guessedEnglish ? seg.text : 'translating…',
      pending: true,
    });
    entriesEnglish.appendChild(engEl);

    stick(feedMixed);
    stick(feedEnglish);

    const t0 = performance.now();
    translate(seg.text)
      .then((res) => {
        seg.lang = res.src === 'en' ? 'en' : res.src;
        seg.english = res.src === 'en' ? seg.text : res.english || seg.text;
        seg.ms = Math.round(performance.now() - t0);
        applySegment(seg, mixedEl, engEl);
      })
      .catch(() => {
        seg.english = seg.lang === 'en' ? seg.text : '(translation unavailable)';
        applySegment(seg, mixedEl, engEl);
      });
  }

  function applySegment(seg, mixedEl, engEl) {
    const isEnglish = seg.lang === 'en';

    const mixedChip = mixedEl.querySelector('.chip');
    mixedChip.textContent = (seg.lang || 'es').toUpperCase();
    mixedChip.className = 'chip ' + chipClass(seg.lang);
    mixedEl.querySelector('.text').classList.remove('pending');

    const engChip = engEl.querySelector('.chip');
    const engText = engEl.querySelector('.text');
    if (isEnglish) {
      engChip.textContent = 'EN';
      engChip.className = 'chip en';
      engText.textContent = seg.text;
    } else {
      engChip.textContent = (seg.lang || 'es').toUpperCase() + '→EN';
      engChip.className = 'chip trans';
      engText.textContent = seg.english;
      if (seg.ms != null) {
        const ms = document.createElement('span');
        ms.className = 'ms';
        ms.textContent = seg.ms + ' ms';
        engEl.querySelector('.meta').appendChild(ms);
      }
    }
    engText.classList.remove('pending');

    stick(feedMixed);
    stick(feedEnglish);
  }

  // ---------- Interim (live) results ----------

  function showInterim(text) {
    if (text === currentInterim) return;
    currentInterim = text;

    if (!text) {
      clearLive();
      return;
    }

    liveMixed.hidden = false;
    liveMixed.textContent = text;
    stick(feedMixed);

    // Instant path: if it already reads as English, mirror it right away.
    if (guessLang(text) === 'en') {
      setLiveEnglish(text);
    }

    // Debounced live translation of the in-flight utterance.
    clearTimeout(interimTimer);
    interimTimer = setTimeout(async () => {
      if (interimAbort) interimAbort.abort();
      interimAbort = new AbortController();
      const snapshot = text;
      try {
        const res = await translate(snapshot, interimAbort.signal);
        // Only apply if this interim is still what's on screen (or grew from it).
        if (currentInterim && (currentInterim === snapshot || currentInterim.startsWith(snapshot))) {
          setLiveEnglish(res.src === 'en' ? currentInterim : res.english);
        }
      } catch (err) {
        /* aborted or offline — final pass will handle it */
      }
    }, INTERIM_DEBOUNCE_MS);
  }

  function setLiveEnglish(text) {
    if (!text) return;
    liveEnglish.hidden = false;
    liveEnglish.textContent = text;
    stick(feedEnglish);
  }

  function clearLive() {
    currentInterim = '';
    clearTimeout(interimTimer);
    if (interimAbort) interimAbort.abort();
    liveMixed.hidden = true;
    liveMixed.textContent = '';
    liveEnglish.hidden = true;
    liveEnglish.textContent = '';
  }

  // ---------- Status ----------

  function setStatus(mode, msg) {
    statusDot.className = 'dot ' + mode;
    statusText.textContent = msg;
  }

  // ---------- Recognition ----------

  function buildRecognizer() {
    const rec = new SpeechRec();
    rec.lang = langSelect.value;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => setStatus('on', 'Listening…');

    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        if (result.isFinal) {
          finalizeUtterance(result[0].transcript);
        } else {
          interim += result[0].transcript;
        }
      }
      showInterim(interim.trim());
    };

    rec.onerror = (ev) => {
      switch (ev.error) {
        case 'not-allowed':
        case 'service-not-allowed':
          stopListening();
          setStatus('error', 'Mic blocked — allow microphone access');
          break;
        case 'audio-capture':
          stopListening();
          setStatus('error', 'No microphone found');
          break;
        case 'network':
          setStatus('warn', 'Speech service hiccup — retrying…');
          break;
        default:
          // 'no-speech' / 'aborted' are routine; onend handles the restart.
          break;
      }
    };

    // Chrome ends sessions after silence or ~a few minutes: restart seamlessly.
    rec.onend = () => {
      if (!state.listening) {
        setStatus('off', 'Mic off');
        return;
      }
      clearTimeout(state.restartTimer);
      try {
        rec.start();
      } catch (e) {
        state.restartTimer = setTimeout(() => {
          if (!state.listening) return;
          state.rec = buildRecognizer();
          try { state.rec.start(); } catch (e2) { /* next onend retries */ }
        }, 250);
      }
    };

    return rec;
  }

  function startListening() {
    if (!SUPPORTED || state.listening) return;
    state.listening = true;
    state.rec = buildRecognizer();
    try {
      state.rec.start();
    } catch (e) { /* onend will retry */ }
    micBtn.textContent = '■ Stop';
    micBtn.classList.add('on');
    setStatus('warn', 'Starting mic…');
    requestWakeLock();
  }

  function stopListening() {
    state.listening = false;
    clearTimeout(state.restartTimer);
    if (state.rec) {
      state.rec.onend = null;
      try { state.rec.stop(); } catch (e) { /* already stopped */ }
      state.rec = null;
    }
    clearLive();
    micBtn.textContent = '▶ Start listening';
    micBtn.classList.remove('on');
    setStatus('off', 'Mic off');
    releaseWakeLock();
  }

  // ---------- Wake lock (keep the screen on mid-conversation) ----------

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { /* not critical */ }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.listening) requestWakeLock();
  });

  // ---------- Wiring ----------

  micBtn.addEventListener('click', () => {
    if (state.listening) stopListening();
    else startListening();
  });

  clearBtn.addEventListener('click', () => {
    entriesMixed.innerHTML = '';
    entriesEnglish.innerHTML = '';
    clearLive();
  });

  langSelect.addEventListener('change', () => {
    if (state.listening) {
      stopListening();
      startListening();
    }
  });

  // Debug/demo hook: feed a phrase through the full pipeline without a mic.
  // In DevTools: __feed('hola, ¿cómo estás?')
  window.__feed = (text) => finalizeUtterance(text);
})();
