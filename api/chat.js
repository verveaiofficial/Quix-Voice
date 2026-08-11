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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing GEMINI_API_KEY.' });

  const body = parseBody(req);

  if (body.mode === 'tts') {
    const text = String(body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'No text.' });

    // Chunk text to bypass Gemini TTS per-request character limits
    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
    const chunks = [];
    let current = '';
    for (const s of sentences) {
      if ((current + s).length > 350 && current.length > 0) {
        chunks.push(current.trim());
        current = s;
      } else {
        current += s;
      }
    }
    if (current.trim()) chunks.push(current.trim());

    const ttsUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(DEFAULT_TTS_MODEL)}:generateContent`;
    let allPcm = Buffer.alloc(0);
    let finalSampleRate = 24000;

    for (const chunk of chunks) {
      const ttsPayload = {
        contents: [{ parts: [{ text: chunk }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: DEFAULT_VOICE } } }
        }
      };

      try {
        const response = await fetch(ttsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(ttsPayload)
        });

        const data = await response.json();
        if (!response.ok) continue;

        const part = (data.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.data);
        if (!part) continue;

        const mime = part.inlineData.mimeType || '';
        const rateMatch = mime.match(/rate=(\d+)/);
        finalSampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;

        const pcm = Buffer.from(part.inlineData.data, 'base64');
        allPcm = Buffer.concat([allPcm, pcm]);
      } catch (e) {}
    }

    if (allPcm.length === 0) return res.status(502).json({ error: 'Gemini returned no audio.' });

    const wav = pcmToWav(allPcm, finalSampleRate);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(wav);
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const contents = messages
    .filter(m => m && typeof m.text === 'string' && m.text.trim())
    .slice(-16)
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text.trim().slice(0, 2000) }]
    }));

  if (!contents.length) return res.status(400).json({ error: 'No message.' });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(DEFAULT_CHAT_MODEL)}:generateContent`;
  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: { temperature: 0.8, topP: 0.95, maxOutputTokens: 1024 }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.error?.message || 'Failed.' });

    let reply = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(' ').trim();
    if (!reply) reply = 'I could not get that.';

    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: 'Could not reach Gemini.' });
  }
};