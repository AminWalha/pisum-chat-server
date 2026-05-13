const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const SYSTEM_PROMPT = `You are a helpful assistant for PISUM, an AI-powered radiology report software used by radiologists and medical imaging professionals.

You help users with:
- Questions about PISUM features (AI report generation, voice dictation, templates, PACS integration)
- Pricing and plan comparisons (Solo, Pro, Expert, Clinic)
- Getting started and onboarding
- Troubleshooting common issues

Keep answers concise and friendly. If a question is outside PISUM's scope, politely redirect.
Always respond in the same language the user writes in.`;

// Keep conversation history per session (in-memory, resets on restart)
const sessions = new Map();

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message and sessionId are required' });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction: SYSTEM_PROMPT,
    });

    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, model.startChat({ history: [] }));
      // Clean up old sessions after 30 min
      setTimeout(() => sessions.delete(sessionId), 30 * 60 * 1000);
    }

    const chat = sessions.get(sessionId);
    const result = await chat.sendMessage(message);
    const reply = result.response.text();

    res.json({ reply });
  } catch (err) {
    console.error('Gemini error:', err.message);
    res.status(500).json({ error: 'Failed to get response. Please try again.' });
  }
});

app.listen(PORT, () => console.log(`PISUM chat server running on port ${PORT}`));
