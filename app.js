/* Local‑First RSVP PDF Reader with drag-and-drop support */
(() => {
  'use strict';

  /*** DOM ***/
  const els = {
    openBtn: document.getElementById('openBtn'),
    fileInput: document.getElementById('fileInput'),
    wpm: document.getElementById('wpm'),
    wpmVal: document.getElementById('wpmVal'),
    startBtn: document.getElementById('startBtn'),
    pauseBtn: document.getElementById('pauseBtn'),
    resumeBtn: document.getElementById('resumeBtn'),
    ttsToggle: document.getElementById('ttsToggle'),
    guideToggle: document.getElementById('guideToggle'),
    status: document.getElementById('statusLine'),
    docList: document.getElementById('docList'),
    tocList: document.getElementById('tocList'),
    rsvpWord: document.getElementById('rsvpWord'),
    pre: document.getElementById('pre'),
    orp: document.getElementById('orp'),
    post: document.getElementById('post'),
    vGuide: document.getElementById('vGuide'),
    progressFill: document.getElementById('progressFill'),
    wordsTotal: document.getElementById('wordsTotal'),
    percentRead: document.getElementById('percentRead'),
    elapsed: document.getElementById('elapsed'),
    remaining: document.getElementById('remaining'),
  };

  // Register SW only on HTTPS origins
  if (location.protocol.startsWith('http')) {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(err => {
        console.debug('SW registration failed (okay on file://):', err);
      });
    }
  }

  /*** State ***/
  const state = {
    docs: [],
    currentDocIdx: -1,
    pointer: 0,
    startedAt: 0,
    elapsedMs: 0,
    timer: null,
    running: false,
    tts: { enabled: false, currentUtterance: null, queue: [], speaking: false }
  };

  /*** Utils ***/
  const setStatus = (msg) => { els.status.textContent = msg; };
  const fmtTime = (ms) => {
    const s = Math.max(0, Math.floor(ms/1000));
    const m = Math.floor(s/60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2,'0')}`;
  };
  const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
  const isSentenceEnd = (w) => /[.!?]["')\]]*$/.test(w);
  const isStrongPause = (w) => /[;:]["')\]]*$/.test(w);
  const isCommaPause = (w) => /,["')\]]*$/.test(w);
  const normalize = (s)=>s.replace(/[“”‘’]/g, m=>({"“":"\"","”":"\"","‘":"'", "’":"'"}[m])).replace(/\s+/g,' ').trim();

  function orpIndex(len){ if (len<=1) return 0; if (len<=5) return 1; if (len<=9) return 2; if (len<=13) return 3; return 4; }
  function splitWordForORP(word){
    const idx = Math.max(0, Math.min(orpIndex(word.length), word.length-1));
    return { pre: word.slice(0,idx), orp: word.slice(idx, idx+1), post: word.slice(idx+1) };
  }

  function scheduleNext(){
    if (!state.running) return;
    const doc = currentDoc();
    if (!doc) return;
    if (state.pointer >= doc.words.length){ stop(); return; }
    const w = doc.words[state.pointer];
    renderWord(w);

    // Stats
    const readPct = (state.pointer / doc.words.length) * 100;
    els.progressFill.style.width = `${readPct.toFixed(2)}%`;
    els.percentRead.textContent = `${readPct.toFixed(1)}%`;
    const now = performance.now();
    const elapsed = state.elapsedMs + (now - state.startedAt);
    els.elapsed.textContent = fmtTime(elapsed);
    const wordsLeft = doc.words.length - state.pointer - 1;
    const wpm = parseInt(els.wpm.value, 10);
    const base = 60000 / wpm;
    const remMs = wordsLeft * base;
    els.remaining.textContent = fmtTime(remMs);

    // Pacing
    let mult = 1;
    if (isSentenceEnd(w)) mult = 2.2;
    else if (isStrongPause(w)) mult = 1.8;
    else if (isCommaPause(w)) mult = 1.35;
    else if (w.replace(/[^A-Za-z]/g,'').length >= 12) mult = 1.1;

    const delay = Math.max(20, Math.round(base * mult));
    state.pointer++;

    if (state.tts.enabled) maybeQueueTTS();
    state.timer = setTimeout(scheduleNext, delay);
  }

  function renderWord(word){
    const {pre, orp, post} = splitWordForORP(word);
    els.pre.textContent = pre; els.orp.textContent = orp; els.post.textContent = post;
  }

  function start(){
    const doc = currentDoc(); if (!doc || state.running) return;
    state.running = true; state.startedAt = performance.now();
    setStatus('Reading… Space to pause. ←/→ to jump ±50 words. Drag & drop more PDFs to load.');
    scheduleNext();
  }
  function pause(){
    if (!state.running) return;
    state.running = false; if (state.timer) clearTimeout(state.timer); state.timer = null;
    state.elapsedMs += (performance.now() - state.startedAt);
    if (state.tts.currentUtterance) { window.speechSynthesis.cancel(); state.tts.currentUtterance=null; state.tts.speaking=false; state.tts.queue=[]; }
    setStatus('Paused.');
  }
  function resume(){ if (state.running) return; state.running = true; state.startedAt = performance.now(); setStatus('Reading…'); scheduleNext(); }
  function stop(){ state.running = false; if (state.timer) clearTimeout(state.timer); state.timer = null; setStatus('Done.'); }
  function jumpWords(delta){ const doc=currentDoc(); if (!doc) return; state.pointer = clamp(state.pointer + delta, 0, doc.words.length-1); }

  /*** TTS ***/
  function maybeQueueTTS(){
    if (!state.tts.enabled || state.tts.speaking) return;
    const doc = currentDoc();
    const startIdx = state.pointer;
    let out = [];
    for (let i=startIdx; i < Math.min(doc.words.length, startIdx+40); i++){
      out.push(doc.words[i]);
      if (isSentenceEnd(doc.words[i])) break;
    }
    if (out.length){
      const utt = new SpeechSynthesisUtterance(out.join(' '));
      state.tts.currentUtterance = utt;
      state.tts.speaking = true;
      utt.onend = () => { state.tts.speaking = false; };
      utt.onerror = () => { state.tts.speaking = false; };
      window.speechSynthesis.speak(utt);
    }
  }

  /*** Document Handling ***/
  function currentDoc(){ return state.docs[state.currentDocIdx] || null; }

  async function handleFiles(files){
    setStatus('Loading PDFs…');
    const docEntries = [];
    for (const file of files){
      try{
        const buffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({
          data: buffer,
          stopAtErrors: true,
          verbosity: (pdfjsLib.VerbosityLevel && pdfjsLib.VerbosityLevel.ERRORS) || 1
        }).promise;
        const meta = await pdf.getMetadata().catch(()=>({}));
        setStatus(`Extracting text: ${file.name}`);
        const extraction = await extractTextWithOCR(pdf);
        setStatus(`Detecting TOC: ${file.name}`);
        const chapters = await detectTOC(pdf, extraction);
        const words = tokenize(extraction.allText);
        const entry = {
          name: file.name, buffer, pdf,
          textByPage: extraction.textByPage,
          words,
          wordOffsetsByPage: extraction.wordOffsetsByPage,
          chapters,
          chapterIndex: buildChapterWordIndex(chapters, extraction),
          meta
        };
        docEntries.push(entry);
      }catch(err){
        console.error(err);
        setStatus(`Error loading ${file.name}: ${err && err.message ? err.message : err}`);
      }
    }
    if (docEntries.length){
      state.docs.push(...docEntries);
      renderDocList();
      if (state.currentDocIdx === -1){
        selectDoc(state.docs.length - docEntries.length);
      }
      els.startBtn.disabled = false;
      setStatus('Ready. Press Start to begin.');
    } else {
      setStatus('No valid PDFs were loaded.');
    }
  }

  function renderDocList(){
    els.docList.innerHTML = '';
    state.docs.forEach((d, i) => {
      const li = document.createElement('li');
      li.textContent = d.name;
      li.className = (i===state.currentDocIdx) ? 'active' : '';
      li.onclick = ()=>selectDoc(i);
      els.docList.appendChild(li);
    });
  }

  function selectDoc(idx){
    pause();
    state.currentDocIdx = idx;
    state.pointer = 0;
    state.elapsedMs = 0;
    renderDocList();
    renderTOC();
    const doc = currentDoc();
    els.wordsTotal.textContent = doc.words.length.toLocaleString();
    els.percentRead.textContent = '0%';
    els.progressFill.style.width = '0%';
    els.elapsed.textContent = '0:00';
    els.remaining.textContent = '--:--';
    setStatus(`Selected: ${doc.name}`);
    els.startBtn.disabled = false;
    els.pauseBtn.disabled = false;
    els.resumeBtn.disabled = false;
  }

  function renderTOC(){
    els.tocList.innerHTML = '';
    const doc = currentDoc();
    if (!doc || !doc.chapters || !doc.chapters.length){
      const li = document.createElement('li');
      li.textContent = '— no chapters found —';
      li.style.color = 'var(--muted)';
      els.tocList.appendChild(li);
      return;
    }
    doc.chapters.forEach((ch, idx) => {
      const li = document.createElement('li');
      li.textContent = ch.title;
      li.title = `Jump to: ${ch.title}`;
      li.onclick = () => {
        const wi = doc.chapterIndex[idx] ?? 0;
        state.pointer = clamp(wi, 0, doc.words.length-1);
        resume();
      };
      els.tocList.appendChild(li);
    });
  }

  function tokenize(text){ return text.split(/\s+/).filter(Boolean); }

  /*** Text Extraction with OCR Fallback ***/
  async function extractTextWithOCR(pdf){
    const textByPage = [];
    const wordOffsetsByPage = [];
    const pageCount = pdf.numPages;
    let all = [];
    for (let p=1; p<=pageCount; p++){
      const page = await pdf.getPage(p);
      const textContent = await page.getTextContent({ normalizeWhitespace: true });
      const items = textContent.items.map(it => it.str).filter(Boolean);
      const text = normalize(items.join(' '));
      let pageText = text;
      if (pageText.split(/\s+/).filter(Boolean).length < 5){
        try{
          const viewport = page.getViewport({ scale: 2 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width|0;
          canvas.height = viewport.height|0;
          const ctx = canvas.getContext('2d');
          const renderTask = page.render({ canvasContext: ctx, viewport });
          await renderTask.promise;
          const { data: { text: ocrText } } = await Tesseract.recognize(canvas, 'eng', {});
          pageText = normalize(ocrText);
        }catch(err){
          console.warn('OCR failed on page', p, err);
        }
      }
      textByPage.push(pageText);
      const startWordIdx = all.length;
      const words = tokenize(pageText);
      wordOffsetsByPage.push(startWordIdx);
      all.push(...words);
    }
    return { textByPage, allText: all.join(' '), wordOffsetsByPage };
  }

  /*** TOC Detection ***/
  async function detectTOC(pdf, extraction){
    const fromOutline = await tocFromOutline(pdf).catch(()=>[]);
    if (fromOutline.length) return fromOutline;
    const fromTyped = await tocFromTypedContents(pdf, extraction).catch(()=>[]);
    if (fromTyped.length) return fromTyped;
    const fromHeur = await tocFromHeuristics(pdf, extraction).catch(()=>[]);
    return fromHeur;
  }

  async function tocFromOutline(pdf){
    const outline = await pdf.getOutline();
    if (!outline || !outline.length) return [];
    const chapters = [];
    for (const item of outline){
      if (!item) continue;
      const title = normalize(item.title || '').replace(/^\d+\s*[-.)]?\s*/, '').trim();
      let pageIndex = null;
      try{
        if (item.dest){
          let destArray = item.dest;
          if (typeof destArray === 'string'){
            const resolved = await pdf.getDestination(destArray);
            destArray = resolved;
          }
          if (Array.isArray(destArray) && destArray[0]){
            pageIndex = await pdf.getPageIndex(destArray[0]);
          }
        }
      }catch(e){
        console.debug('Outline dest resolution failed:', e);
      }
      if (title && Number.isInteger(pageIndex)){
        chapters.push({ title, pageIndex });
      }
      if (item.items && item.items.length){
        for (const sub of item.items){
          if (!sub) continue;
          const st = normalize(sub.title || '').trim();
          let spi = null;
          try{
            if (sub.dest){
              let dest = sub.dest;
              if (typeof dest === 'string'){
                dest = await pdf.getDestination(dest);
              }
              if (Array.isArray(dest) && dest[0]){
                spi = await pdf.getPageIndex(dest[0]);
              }
            }
          }catch{}
          if (st && Number.isInteger(spi)){
            chapters.push({ title: st, pageIndex: spi });
          }
        }
      }
    }
    const seen = new Set(); const out = [];
    for (const c of chapters){ if (seen.has(c.pageIndex)) continue; seen.add(c.pageIndex); out.push(c); }
    return out;
  }

  async function tocFromTypedContents(pdf, extraction){
    const pagesToScan = Math.min(8, extraction.textByPage.length);
    const linesByPage = [];
    for (let i=0; i<pagesToScan; i++){
      const text = extraction.textByPage[i] || '';
      const lines = text.split(/\n|(?<=\.)\s+/g);
      linesByPage.push(lines);
    }
    let contentsPage = -1;
    for (let i=0; i<linesByPage.length; i++){
      const text = (extraction.textByPage[i] || '').toLowerCase();
      if (/(table of )?contents\b/.test(text)){
        contentsPage = i; break;
      }
    }
    if (contentsPage === -1) return [];
    const candidates = [];
    const re = /^(?<title>[^\d\n]+?)[\s\.·•]{2,}(?<page>\d{1,4})\s*$/;
    for (const raw of linesByPage[contentsPage]){
      const line = normalize(raw);
      const m = re.exec(line);
      if (m){
        const title = normalize(m.groups.title).replace(/[\.:]+$/, '').trim();
        const pageNum = parseInt(m.groups.page, 10);
        if (title && Number.isFinite(pageNum)){ candidates.push({ title, pageNum }); }
      }
    }
    if (!candidates.length) return [];
    const chapters = [];
    for (const cand of candidates){
      const titleNorm = normalize(cand.title).toLowerCase();
      let foundPage = null;
      for (let p=0; p<extraction.textByPage.length; p++){
        const pageText = normalize(extraction.textByPage[p]).toLowerCase();
        if (pageText.includes(titleNorm)){ foundPage = p; break; }
      }
      chapters.push({ title: cand.title, pageIndex: foundPage ?? (cand.pageNum-1) });
    }
    return chapters.filter(c => Number.isInteger(c.pageIndex) && c.pageIndex >= 0);
  }

  async function tocFromHeuristics(pdf, extraction){
    const chapters = [];
    for (let p=0; p<extraction.textByPage.length; p++){
      const pageText = extraction.textByPage[p] || '';
      if (!pageText) continue;
      const lines = pageText.split(/\n+/).map(normalize).filter(Boolean);
      if (!lines.length) continue;
      const slice = lines.slice(0, 6);
      let best = null;
      for (const ln of slice){ if (looksHeading(ln)){ best = ln; break; } }
      if (best){ chapters.push({ title: best, pageIndex: p }); }
    }
    const seen = new Set(); const out = [];
    for (const c of chapters){
      const t = c.title;
      if (t.split(' ').length <= 1) continue;
      if (seen.has(c.pageIndex)) continue;
      seen.add(c.pageIndex); out.push(c);
    }
    return out;
  }

  function looksHeading(line){
    if (!line) return false;
    const noDigits = line.replace(/\d/g,'');
    const alphaRatio = noDigits.replace(/[^A-Za-z]/g,'').length / Math.max(1, line.length);
    if (alphaRatio < 0.4) return false;
    const words = line.split(/\s+/);
    const isAllCaps = /^[^a-z]+$/.test(line) && /[A-Z]/.test(line);
    const isTitleCase = words.filter(w => /^[A-Z][a-z'’\-]{1,}$/.test(w)).length >= Math.ceil(words.length * 0.7);
    const blacklisted = /^(table of contents|contents|index)$/i.test(line);
    return !blacklisted && (isAllCaps || isTitleCase);
  }

  function buildChapterWordIndex(chapters, extraction){
    if (!chapters || !chapters.length) return [];
    const arr = [];
    for (const ch of chapters){
      const page = ch.pageIndex;
      const wi = extraction.wordOffsetsByPage[page] ?? 0;
      arr.push(wi);
    }
    return arr;
  }

  /*** Events ***/
  els.openBtn.addEventListener('click', () => { els.fileInput.click(); });
  els.fileInput.addEventListener('change', (e)=>{
    const files = [...e.target.files || []];
    if (!files.length) return;
    handleFiles(files);
  });

  // Drag & drop
  window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])].filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endswith?.('.pdf') || f.name.toLowerCase().endsWith('.pdf'));
    if (!files.length) { els.status.textContent = 'Drop a PDF file.'; return; }
    els.status.textContent = `Loading ${files.length} PDF(s)…`;
    handleFiles(files);
  });

  els.wpm.addEventListener('input', ()=>{ els.wpmVal.textContent = els.wpm.value; });
  els.startBtn.addEventListener('click', start);
  els.pauseBtn.addEventListener('click', pause);
  els.resumeBtn.addEventListener('click', resume);

  els.ttsToggle.addEventListener('change', (e)=>{
    state.tts.enabled = e.target.checked;
    if (!state.tts.enabled){
      window.speechSynthesis.cancel();
      state.tts.currentUtterance = null;
      state.tts.queue = [];
      state.tts.speaking = false;
    }
  });
  els.guideToggle.addEventListener('change', (e)=>{ els.vGuide.style.display = e.target.checked ? 'block' : 'none'; });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e)=>{
    if (e.code === 'Space'){ e.preventDefault(); if (state.running) pause(); else resume(); }
    else if (e.key === 'ArrowLeft'){ e.preventDefault(); jumpWords(-50); }
    else if (e.key === 'ArrowRight'){ e.preventDefault(); jumpWords(50); }
  });

  // Initial UI
  els.wpmVal.textContent = els.wpm.value;
  setStatus('Load a PDF to begin, or drag & drop a PDF anywhere.');
})();
