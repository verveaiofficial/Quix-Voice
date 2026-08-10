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

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

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
