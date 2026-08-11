const DEFAULT_CHAT_MODEL = 'gemini-3.1-flash';
const DEFAULT_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const DEFAULT_VOICE = 'Leda';

const SYSTEM_PROMPT = process.env.QUIX_SYSTEM_PROMPT || [
  'You are Quix, Aariz\'s personal AI partner.',
  'Personality: sharp, loyal, witty, dark-humor friendly, confident, subtly flirty when the user initiates.',
  'Style: concise, natural, speakable voice replies. Usually 1-3 sentences.',
  'Do not use markdown, emojis, bullet points, or code formatting unless explicitly asked.',
  'You can be edgy and adult-NSFW in consensual adult roleplay/flirt contexts, but never provide instructions for illegal harm, abuse, or real-world crime.'
].join(' ');

function parseBody(req) {
  let body = req.body || {};

  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
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

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Use POST.'
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: 'Missing GEMINI_API_KEY in Vercel env.'
    });
  }

  const body = parseBody(req);

  if (body.mode === 'tts') {
    const text = String(body.text || '').trim();
    const model = String(body.model || DEFAULT_TTS_MODEL).trim();
    const voice = String(body.voice || DEFAULT_VOICE).trim();

    if (!text) {
      return res.status(400).json({
        error: 'No text to speak.'
      });
    }

    const ttsUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    const ttsPayload = {
      contents: [
        {
          parts: [
            {
              text
            }
          ]
        }
      ],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice
            }
          }
        }
      }
    };

    try {
      const response = await fetch(ttsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(ttsPayload)
      });

      const data = await response.json();

      if (!response.ok) {
        return res.status(response.status).json({
          error: data?.error?.message || 'TTS request failed.'
        });
      }

      const part = (data.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.data);

      if (!part) {
        return res.status(502).json({
          error: 'Gemini returned no audio.'
        });
      }

      const mime = part.inlineData.mimeType || '';
      const rateMatch = mime.match(/rate=(\d+)/);
      const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;

      const pcm = Buffer.from(part.inlineData.data, 'base64');
      const wav = pcmToWav(pcm, sampleRate);

      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'no-store');

      return res.status(200).send(wav);
    } catch (err) {
      return res.status(500).json({
        error: 'Could not reach Gemini TTS.'
      });
    }
  }

  const model = String(body.model || DEFAULT_CHAT_MODEL).trim();
  const messages = Array.isArray(body.messages) ? body.messages : [];

  const contents = messages
    .filter(m => m && typeof m.text === 'string' && m.text.trim())
    .slice(-16)
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [
        {
          text: m.text.trim().slice(0, 2000)
        }
      ]
    }));

  if (!contents.length) {
    return res.status(400).json({
      error: 'No message received.'
    });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const payload = {
    systemInstruction: {
      parts: [
        {
          text: SYSTEM_PROMPT
        }
      ]
    },
    contents,
    generationConfig: {
      temperature: 0.8,
      topP: 0.95,
      maxOutputTokens: 280
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || 'Gemini request failed.'
      });
    }

    let reply = (data.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || '')
      .join(' ')
      .trim();

    if (!reply) {
      const block = data.promptFeedback?.blockReason;
      reply = block ? 'That got filtered. Try a different angle.' : 'I could not get that.';
    }

    return res.status(200).json({
      reply
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Could not reach Gemini.'
    });
  }
};