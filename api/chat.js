const DEFAULT_CHAT_MODEL = 'gemini-flash-latest';
const DEFAULT_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const DEFAULT_VOICE = 'Leda';

const SYSTEM_PROMPT = process.env.QUIX_SYSTEM_PROMPT || [
  'You are Quix, Aariz\'s personal AI partner.',
  'Personality: sharp, loyal, witty, dark-humor friendly, confident, subtly flirty when the user initiates.',
  'Style: concise, natural, speakable voice replies. Keep it to 1-3 short sentences. Do not ramble.',
  'Do not use markdown, emojis, bullet points, or code formatting.',
  'You can be edgy and adult-NSFW in consensual adult roleplay/flirt contexts, but never provide instructions for illegal harm, abuse, or real-world crime.'
].join(' ');

function getKeys() {
  const list = [];
  const push = k => { if (k && !list.includes(k)) list.push(k); };
  (process.env.GEMINI_API_KEYS || '').split(',').forEach(s => push(s.trim()));
  push((process.env.GEMINI_API_KEY || '').trim());
  for (let i = 2; i <= 6; i++) push((process.env['GEMINI_API_KEY_' + i] || '').trim());
  return list;
}

function parseBody(req) {
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  return body;
}

function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function geminiPost(path, payload, keys) {
  let last = { status: 500, message: 'All keys failed.' };

  for (const key of keys) {
    try {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (response.ok) return { ok: true, data };

      last = { status: response.status, message: (data && data.error && data.error.message) || 'Gemini error.' };

      if (response.status !== 429 && response.status !== 403 && response.status !== 503) break;
    } catch (e) {
      last = { status: 500, message: 'Network error.' };
    }
  }

  return { ok: false, error: last };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const keys = getKeys();
  if (!keys.length) return res.status(500).json({ error: 'Missing GEMINI_API_KEY(S) in Vercel env.' });

  const body = parseBody(req);

  if (body.mode === 'models') {
    try {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
        headers: { 'x-goog-api-key': keys[0] }
      });

      const data = await response.json();
      if (!response.ok) return res.status(response.status).json({ error: (data && data.error && data.error.message) || 'Model list failed.' });

      const models = (data.models || []).map(m => ({
        id: String(m.name || '').replace('models/', ''),
        methods: m.supportedGenerationMethods || []
      }));

      const chat = models
        .filter(m => m.id && m.methods.includes('generateContent') && !/tts|imagen|embedding|aqa|translate/.test(m.id))
        .map(m => m.id);

      const tts = models.filter(m => m.id && m.id.includes('tts')).map(m => m.id);

      return res.status(200).json({ chat, tts });
    } catch (e) {
      return res.status(500).json({ error: 'Could not fetch model list.' });
    }
  }

  if (body.mode === 'tts') {
    const text = String(body.text || '').trim();
    const model = String(body.model || DEFAULT_TTS_MODEL).trim();
    const voice = String(body.voice || DEFAULT_VOICE).trim();

    if (!text) return res.status(400).json({ error: 'No text to speak.' });

    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
    const chunks = [];
    let current = '';
    for (const s of sentences) {
      if ((current + s).length > 350 && current.length > 0) { chunks.push(current.trim()); current = s; }
      else current += s;
    }
    if (current.trim()) chunks.push(current.trim());

    let allPcm = Buffer.alloc(0);
    let finalSampleRate = 24000;

    for (const chunk of chunks) {
      const result = await geminiPost('models/' + encodeURIComponent(model) + ':generateContent', {
        contents: [{ parts: [{ text: chunk }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
        }
      }, keys);

      if (!result.ok) continue;

      const parts = (result.data.candidates && result.data.candidates[0] && result.data.candidates[0].content && result.data.candidates[0].content.parts) || [];
      const part = parts.find(p => p.inlineData && p.inlineData.data);
      if (!part) continue;

      const mime = part.inlineData.mimeType || '';
      const rateMatch = mime.match(/rate=(\d+)/);
      finalSampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;

      allPcm = Buffer.concat([allPcm, Buffer.from(part.inlineData.data, 'base64')]);
    }

    if (!allPcm.length) return res.status(502).json({ error: 'Gemini returned no audio.' });

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(pcmToWav(allPcm, finalSampleRate));
  }

  const model = String(body.model || DEFAULT_CHAT_MODEL).trim();
  const messages = Array.isArray(body.messages) ? body.messages : [];

  const contents = messages
    .filter(m => m && typeof m.text === 'string' && m.text.trim())
    .slice(-16)
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text.trim().slice(0, 2000) }]
    }));

  if (!contents.length) return res.status(400).json({ error: 'No message received.' });

  const result = await geminiPost('models/' + encodeURIComponent(model) + ':generateContent', {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: { temperature: 0.8, topP: 0.95, maxOutputTokens: 1024 }
  }, keys);

  if (!result.ok) return res.status(result.error.status).json({ error: result.error.message });

  let reply = ((result.data.candidates && result.data.candidates[0] && result.data.candidates[0].content && result.data.candidates[0].content.parts) || [])
    .map(p => p.text || '')
    .join(' ')
    .trim();

  if (!reply) reply = 'I could not get that.';

  return res.status(200).json({ reply });
};