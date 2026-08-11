const loading = document.getElementById('loading');
const hideLoading = () => loading.classList.add('hide');
setTimeout(hideLoading, 2600);

const stage = document.getElementById('stage');
const statusEl = document.getElementById('status');
const userCaption = document.getElementById('userCaption');
const quixCaption = document.getElementById('quixCaption');
const orbZone = document.getElementById('orbZone');
const gearBtn = document.getElementById('gearBtn');
const sheetOverlay = document.getElementById('sheetOverlay');
const sheet = document.getElementById('sheet');
const sheetClose = document.getElementById('sheetClose');
const sheetDone = document.getElementById('sheetDone');
const chatChips = document.getElementById('chatChips');
const ttsChips = document.getElementById('ttsChips');
const voiceChips = document.getElementById('voiceChips');

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let callActive = false;
let thinking = false;
let speaking = false;
let silenceTimer = null;
let voices = [];

let finalTranscript = '';
let interimTranscript = '';

let audioCtx = null;
let analyser = null;
let timeData = null;
let graphAttached = false;
let ttsAudio = null;
let currentUrl = null;
let pendingUrl = null;
let lastUnlock = 0;

const history = [];

/* ---------- MODEL PICKER STATE ---------- */
let CHAT_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview'];
let TTS_MODELS = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts', 'gemini-3.1-flash-tts-preview'];
const VOICES = ['Leda', 'Sulafat', 'Aoede', 'Zephyr', 'Kore', 'Fenrir'];

function store(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
function read(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; } }

let chatModel = read('quix_chat_model', 'gemini-flash-latest');
let ttsModel = read('quix_tts_model', 'gemini-2.5-flash-preview-tts');
let voiceName = read('quix_voice', 'Leda');
if (!VOICES.includes(voiceName)) voiceName = 'Leda';

/* ---------- LIVE ORB ---------- */
const canvas = document.getElementById('orbCanvas');
const ctx = canvas.getContext('2d');

const blobs = [
  { fx: 0.71, fy: 1.13, phase: 0.00, amp: 0.52, r: 90, color: '#00f2ff' },
  { fx: 1.31, fy: 0.83, phase: 1.20, amp: 0.48, r: 84, color: '#ff00c8' },
  { fx: 0.93, fy: 1.41, phase: 2.10, amp: 0.44, r: 78, color: '#39ff14' },
  { fx: 1.17, fy: 0.67, phase: 0.80, amp: 0.50, r: 74, color: '#6e5fff' },
  { fx: 1.53, fy: 1.27, phase: 1.70, amp: 0.38, r: 68, color: '#ff0088' },
  { fx: 0.79, fy: 1.63, phase: 3.00, amp: 0.42, r: 72, color: '#ffff00' },
  { fx: 1.23, fy: 0.91, phase: 4.20, amp: 0.35, r: 66, color: '#00ffdd' },
  { fx: 0.61, fy: 1.37, phase: 5.10, amp: 0.46, r: 80, color: '#a855f7' }
];

const SLOW = 0.12, FAST = 2.2, CYCLE = 5000;
let W = 185, H = 185, R = 92, cx = 92.5, cy = 92.5, scale = 1;
let startTime = performance.now(), lastTime = startTime, t = 0;
let speedSmooth = SLOW, audioLevel = 0;

function sizeOrb() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.max(120, Math.round(rect.width * dpr));
  canvas.width = px; canvas.height = px;
  W = px; H = px; cx = px / 2; cy = px / 2; R = px / 2 - px * 0.004; scale = px / 185;
}
window.addEventListener('resize', sizeOrb);

function currentLevel() {
  if (!analyser || !timeData) return 0;
  analyser.getByteTimeDomainData(timeData);
  let sum = 0;
  for (let i = 0; i < timeData.length; i++) { const v = (timeData[i] - 128) / 128; sum += v * v; }
  return Math.min(1, Math.sqrt(sum / timeData.length) * 4);
}

function draw(now) {
  const dt = Math.min(50, now - lastTime); lastTime = now;
  let target;
  if (speaking && analyser) {
    const lvl = currentLevel(); audioLevel += (lvl - audioLevel) * 0.25;
    target = SLOW + (FAST - SLOW) * Math.min(1, 0.18 + audioLevel * 1.4);
  } else {
    audioLevel += (0 - audioLevel) * 0.08;
    const cycleT = (now - startTime) % CYCLE;
    const s = (Math.sin((cycleT / CYCLE) * Math.PI * 2 - Math.PI / 2) + 1) / 2;
    target = SLOW + (FAST - SLOW) * s;
  }
  speedSmooth += (target - speedSmooth) * 0.12;
  t += speedSmooth * dt * 0.001;

  ctx.clearRect(0, 0, W, H);
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();

  const bg = ctx.createRadialGradient(cx * 0.84, cy * 0.76, 4, cx, cy, R);
  bg.addColorStop(0.00, '#1a1a2e'); bg.addColorStop(0.30, '#0f1f3d'); bg.addColorStop(0.55, '#2a1b4d'); bg.addColorStop(0.80, '#3d1f4d'); bg.addColorStop(1.00, '#0f2a3d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'screen';

  blobs.forEach(b => {
    const bx = cx + Math.sin(b.fx * t + b.phase) * R * b.amp;
    const by = cy + Math.cos(b.fy * t + b.phase * 1.4) * R * b.amp;
    const pulse = 1 + 0.08 * Math.sin(b.fx * t * 2.3 + b.phase) + audioLevel * 0.25;
    const br = b.r * scale * pulse;
    const grad = ctx.createRadialGradient(bx, by, 0, bx, by, br);
    grad.addColorStop(0.00, b.color + 'cc'); grad.addColorStop(0.35, b.color + '88'); grad.addColorStop(0.70, b.color + '33'); grad.addColorStop(1.00, b.color + '00');
    ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fillStyle = grad; ctx.fill();
  });
  ctx.restore(); requestAnimationFrame(draw);
}
sizeOrb(); requestAnimationFrame(draw);

/* ---------- AUDIO UNLOCK ---------- */
function attachGraph() {
  if (graphAttached || !audioCtx || !ttsAudio) return;
  try {
    const src = audioCtx.createMediaElementSource(ttsAudio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    timeData = new Uint8Array(analyser.fftSize);
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
    graphAttached = true;
  } catch (e) {}
}

function unlock() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      if (audioCtx.state === 'running') attachGraph();
    }
  } catch (e) {}

  if (pendingUrl && ttsAudio) {
    lastUnlock = performance.now();
    ttsAudio.src = pendingUrl;
    pendingUrl = null;
    ttsAudio.play().catch(() => {});
  }

  if (!callActive) startCall();
}
window.addEventListener('pointerdown', unlock);

/* ---------- MODEL PICKER ---------- */
function press(el, fn) {
  el.classList.add('press');
  setTimeout(() => { el.classList.remove('press'); fn(); }, 140);
}

function renderChips(container, list, current, onPick) {
  container.innerHTML = '';
  list.forEach(item => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (item === current ? ' active' : '');
    chip.textContent = item;
    chip.addEventListener('click', () => press(chip, () => onPick(item)));
    container.appendChild(chip);
  });
}

function renderAllChips() {
  renderChips(chatChips, CHAT_MODELS, chatModel, item => { chatModel = item; store('quix_chat_model', item); renderAllChips(); });
  renderChips(ttsChips, TTS_MODELS, ttsModel, item => { ttsModel = item; store('quix_tts_model', item); renderAllChips(); });
  renderChips(voiceChips, VOICES, voiceName, item => { voiceName = item; store('quix_voice', item); renderAllChips(); });
}

async function loadModels() {
  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'models' })
    });
    const data = await res.json();
    if (data.chat && data.chat.length) CHAT_MODELS = data.chat;
    if (data.tts && data.tts.length) TTS_MODELS = data.tts;
    if (!CHAT_MODELS.includes(chatModel)) { chatModel = CHAT_MODELS.find(m => /flash/.test(m)) || CHAT_MODELS[0]; store('quix_chat_model', chatModel); }
    if (!TTS_MODELS.includes(ttsModel)) { ttsModel = TTS_MODELS.find(m => /flash/.test(m)) || TTS_MODELS[0]; store('quix_tts_model', ttsModel); }
    renderAllChips();
  } catch (e) {}
}

function openSheet() { sheetOverlay.classList.add('open'); sheet.classList.add('open'); loadModels(); }
function closeSheet() { sheetOverlay.classList.remove('open'); sheet.classList.remove('open'); }

gearBtn.addEventListener('click', () => press(gearBtn, openSheet));
sheetClose.addEventListener('click', () => press(sheetClose, closeSheet));
sheetDone.addEventListener('click', () => press(sheetDone, closeSheet));
sheetOverlay.addEventListener('click', closeSheet);

renderAllChips();
loadModels();

/* ---------- CALL LOGIC ---------- */
function setStatus(text) { statusEl.textContent = text; }
function setState(state) {
  stage.dataset.state = state;
  if (state === 'idle') setStatus('...');
  if (state === 'listening') setStatus('Listening...');
  if (state === 'thinking') setStatus('Thinking...');
  if (state === 'speaking') setStatus('Quix is speaking... tap orb to interrupt.');
}

if ('speechSynthesis' in window) {
  const loadVoices = () => { voices = speechSynthesis.getVoices(); };
  loadVoices(); speechSynthesis.onvoiceschanged = loadVoices;
}

if (!SpeechRecognition) {
  setStatus('Speech recognition is not supported in this browser.');
} else {
  initRecognition();
}

orbZone.addEventListener('click', () => {
  if (!callActive || !speaking) return;
  if (performance.now() - lastUnlock < 600) return;
  if (ttsAudio && !ttsAudio.paused) { stopSpeaking(); resumeListening(); }
});

function initRecognition() {
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';

  recognition.onresult = (event) => {
    if (!callActive || speaking || thinking) return;

    let interim = '';
    let finalAdd = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript || '';
      if (event.results[i].isFinal) finalAdd += chunk + ' ';
      else interim += chunk;
    }

    if (finalAdd && finalTranscript) {
      const cleanFinal = finalAdd.trim();
      const cleanBuffer = finalTranscript.trim();
      if (cleanFinal.startsWith(cleanBuffer) || cleanFinal === cleanBuffer) {
        finalTranscript = cleanFinal;
      } else if (cleanBuffer.includes(cleanFinal)) {
        // duplicate, ignore
      } else {
        finalTranscript += ' ' + cleanFinal;
      }
    } else {
      finalTranscript += ' ' + finalAdd;
    }

    finalTranscript = finalTranscript.replace(/\s+/g, ' ').trim();
    interimTranscript = interim.replace(/\s+/g, ' ').trim();

    const live = [finalTranscript, interimTranscript].filter(Boolean).join(' ');
    userCaption.textContent = live || '—';

    clearTimeout(silenceTimer);
    if (live.trim()) {
      silenceTimer = setTimeout(() => {
        const text = live.trim().slice(0, 500);
        if (text) {
          sendToQuix(text);
          finalTranscript = '';
          interimTranscript = '';
        }
      }, 1200);
    }
  };

  recognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      callActive = false; setState('idle');
      setStatus('Mic blocked. Tap anywhere and allow mic.');
      return;
    }
    if (callActive && !speaking && !thinking) setTimeout(safeStart, 250);
  };

  recognition.onend = () => {
    if (callActive && !speaking && !thinking) setTimeout(safeStart, 180);
  };
}

function safeStart() {
  if (!recognition || !callActive) return;
  try { recognition.start(); setState('listening'); } catch (e) {}
}

function stopRecognition() {
  if (!recognition) return;
  try { if (recognition.abort) recognition.abort(); else recognition.stop(); } catch (e) {}
}

function stopSpeaking() {
  if (ttsAudio) { ttsAudio.onended = null; ttsAudio.onerror = null; ttsAudio.pause(); }
  if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
  if (pendingUrl) { URL.revokeObjectURL(pendingUrl); pendingUrl = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  speaking = false;
}

function startCall() {
  if (callActive || !SpeechRecognition) return;
  callActive = true;
  finalTranscript = ''; interimTranscript = ''; history.length = 0;
  userCaption.textContent = '—'; quixCaption.textContent = 'Connected. Speak.';
  setState('listening'); safeStart();
}

function endCall() {
  callActive = false; thinking = false;
  clearTimeout(silenceTimer); stopRecognition(); stopSpeaking();
  setState('idle'); setStatus('Call ended. Tap anywhere to call again.');
  userCaption.textContent = '—';
}

function cleanForSpeech(text) {
  return String(text || '').replace(/[*_#`~>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function sendToQuix(text) {
  if (!callActive || !text.trim()) return;
  clearTimeout(silenceTimer);
  const clean = text.trim();
  userCaption.textContent = clean;

  if (/\b(stop|end|hang up|quit)( the)? call\b|\bhang up\b/i.test(clean)) { endCall(); return; }

  history.push({ role: 'user', text: clean });
  thinking = true; setState('thinking'); stopRecognition();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history.slice(-16), model: chatModel })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'API failed');

    const reply = cleanForSpeech(data.reply || 'I could not get that.');
    history.push({ role: 'assistant', text: reply });
    quixCaption.textContent = reply;
    thinking = false; speak(reply);
  } catch (err) {
    thinking = false;
    quixCaption.textContent = (err.message || 'Signal slipped. Try again.').slice(0, 140);
    if (callActive) resumeListening();
  }
}

async function speak(text) {
  if (!callActive) return;
  speaking = true; setState('speaking');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'tts', text, model: ttsModel, voice: voiceName })
    });
    if (!res.ok) throw new Error('TTS failed');
    const blob = await res.blob();
    if (!blob.size) throw new Error('Empty audio');
    if (!callActive) { speaking = false; return; }

    if (!ttsAudio) ttsAudio = new Audio();

    const url = URL.createObjectURL(blob);
    currentUrl = url;

    ttsAudio.onended = null; ttsAudio.onerror = null;
    ttsAudio.src = url;

    let done = false;
    const finish = () => {
      if (done) return; done = true;
      if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
      speaking = false;
      if (callActive) resumeListening();
    };
    ttsAudio.onended = finish;
    ttsAudio.onerror = finish;

    try {
      await ttsAudio.play();
    } catch (e) {
      pendingUrl = url;
      setStatus('Tap anywhere to unlock her voice');
    }
  } catch (e) {
    browserSpeak(text);
  }
}

function browserSpeak(text) {
  if (!callActive) return;
  speaking = true; setState('speaking');
  if (!('speechSynthesis' in window)) {
    setTimeout(() => { speaking = false; if (callActive) resumeListening(); }, Math.min(2200, 400 + text.length * 28));
    return;
  }
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.03; utterance.pitch = 1.05;
  const voice = voices.find(v => /en/i.test(v.lang) && /female|samantha|zira|aria|jenny|google us english/i.test(v.name)) || voices.find(v => v.lang.startsWith('en')) || voices[0];
  if (voice) utterance.voice = voice;
  utterance.onend = () => { speaking = false; if (callActive) resumeListening(); };
  utterance.onerror = () => { speaking = false; if (callActive) resumeListening(); };
  speechSynthesis.speak(utterance);
}

function resumeListening() {
  if (!callActive) return;
  setState('listening'); safeStart();
}

window.addEventListener('load', () => {
  setTimeout(hideLoading, 650);
  setTimeout(startCall, 400);
});