const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const knowledge = require('./knowledge');
const { readSecret } = require('./secrets');

const app = express();
const PORT = process.env.PORT || 3000;
// AI service settings come from the environment (never committed)
const AI_API_URL = process.env.AI_API_URL;
const AI_API_KEY = process.env.AI_API_KEY;
const AI_API_KEY_HEADER = process.env.AI_API_KEY_HEADER || 'Authorization';
function jsonEnv(name, fallback) {
  if (!process.env[name]) return fallback;
  try {
    return JSON.parse(process.env[name]);
  } catch (e) {
    console.error(`${name} is not valid JSON: ignored.`);
    return fallback;
  }
}
// Optional generation settings merged into the request (temperature, reasoning level…), as a JSON object.
// Model defaults are used when unset, which keeps the server compatible with new model versions.
const AI_GENERATION_CONFIG = jsonEnv('AI_GENERATION_CONFIG_JSON', {});
// Sent when the output filter removed the whole reply
const PROPRIETARY_REPLY = 'These technical details are proprietary. Our data protection information is available at [pisum.app/rgpd.html](https://pisum.app/rgpd.html).';

const MAX_MESSAGE_LENGTH = 1000;
const MAX_HISTORY_LENGTH = 20;
const MAX_SESSIONS = 2000;
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes
const UPSTREAM_TIMEOUT = 25000;

// Only the PISUM website (and local previews) may call /chat
const ALLOWED_ORIGINS = [/^https:\/\/(www\.)?pisum\.app$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
const isAllowedOrigin = (origin) => !!origin && ALLOWED_ORIGINS.some((re) => re.test(origin));

// Rate limiting (20 requests/minute per IP)
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a minute before asking again.', code: 'rate_limit' }
});

// Render sits behind a proxy: use X-Forwarded-For so the limit is per client, not global
app.set('trust proxy', 1);

app.use(cors({ origin: (origin, cb) => cb(null, !origin || isAllowedOrigin(origin)) }));
app.use(express.json({ limit: '16kb' }));
app.use('/chat', limiter);



// The assistant instructions are private: they are loaded from a Render Secret File
// (system-prompt.txt) or an environment variable, never stored in this repository.
const DEFAULT_PROMPT = `You are the assistant of the pisum.app website. Help visitors understand PISUM, a structured radiology reporting software, using only the LIVE WEBSITE DATA below.
- Do not discuss technical implementation, vendors or internal architecture; say these details are proprietary.
- Do not give medical advice. Never ask for or repeat patient data.
- If you do not know, point to the contact page pisum.app/contact.html.
- Answer in the visitor's language, concisely.`;

const SYSTEM_PROMPT = readSecret('SYSTEM_PROMPT', 'system-prompt.txt').trim() || DEFAULT_PROMPT;
if (SYSTEM_PROMPT === DEFAULT_PROMPT) console.warn('Private system prompt not found: using the default prompt.');
const LANG_NAMES = {
  en: 'English', fr: 'French', da: 'Danish', de: 'German', el: 'Greek', es: 'Spanish', hi: 'Hindi', id: 'Indonesian',
  it: 'Italian', ja: 'Japanese', ko: 'Korean', ms: 'Malay', nl: 'Dutch', no: 'Norwegian', pl: 'Polish', pt: 'Portuguese',
  ro: 'Romanian', ru: 'Russian', sv: 'Swedish', th: 'Thai', tl: 'Tagalog', tr: 'Turkish', zh: 'Chinese'
};

const sessions = new Map();

function getSession(sessionId) {
  let session = sessions.get(sessionId);
  if (session) {
    clearTimeout(session.timer);
    sessions.delete(sessionId); // re-insert to keep Map order = least recently used first
  } else {
    session = { history: [], timer: null };
    while (sessions.size >= MAX_SESSIONS) {
      const [oldestId, oldest] = sessions.entries().next().value;
      clearTimeout(oldest.timer);
      sessions.delete(oldestId);
    }
  }
  sessions.set(sessionId, session);
  session.timer = setTimeout(() => sessions.delete(sessionId), SESSION_TTL);
  return session;
}

app.get('/health', (req, res) => res.json({ status: 'ok', knowledge: knowledge.status() }));

app.post('/chat', async (req, res) => {
  if (!isAllowedOrigin(req.get('origin'))) {
    return res.status(403).json({ error: 'Forbidden', code: 'origin' });
  }

  const { message, sessionId, lang, page, name } = req.body || {};
  const text = typeof message === 'string' ? message.trim() : '';

  if (!text || typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) {
    return res.status(400).json({ error: 'message and a valid sessionId are required', code: 'bad_request' });
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters).`, code: 'too_long' });
  }
  if (!AI_API_URL || !AI_API_KEY) {
    return res.status(500).json({ error: 'AI service not configured on server', code: 'config' });
  }

  const langName = LANG_NAMES[typeof lang === 'string' ? lang.slice(0, 2).toLowerCase() : ''] || 'English';
  const pageName = typeof page === 'string' ? page.replace(/[^\w.\-]/g, '').slice(0, 60) : '';
  // First name of a signed-in visitor (sent by the website widget only when logged in).
  // One word of letters, apostrophes or hyphens only, so it cannot carry instructions.
  const firstName = typeof name === 'string' ? name.normalize('NFC').replace(/[^\p{L}\p{M}' -]/gu, ' ').trim().split(/\s+/)[0].slice(0, 30) : '';
  const visitor = firstName
    ? ` The visitor is signed in to their PISUM account; their first name is ${firstName}. Address them by their first name naturally (for example in a greeting), without overdoing it, and never ask for other personal details.`
    : ' The visitor is not signed in.';
  const context = `\n\n## CONTEXT\nThe visitor is on the page "${pageName || 'index.html'}" with the site language set to ${langName}.${visitor}`;

  // On a cold start, give the first live-data load a few seconds before answering
  await Promise.race([knowledge.ready, new Promise((r) => setTimeout(r, 4000))]);
  const live = knowledge.getBlock();
  const systemText = [SYSTEM_PROMPT, live].filter(Boolean).join('\n\n') + context;

  const session = getSession(sessionId);
  session.history.push({ role: 'user', parts: [{ text }] });

  // Trim from the front, keeping the first turn a 'user' turn (required by the API)
  while (session.history.length > MAX_HISTORY_LENGTH || session.history[0].role !== 'user') {
    session.history.shift();
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);

    const response = await fetch(AI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [AI_API_KEY_HEADER]: AI_API_KEY },
      signal: controller.signal,
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemText }] },
        contents: session.history,
        generationConfig: { maxOutputTokens: 1024, ...AI_GENERATION_CONFIG }
      }),
    });

    clearTimeout(timeoutId);

    const data = await response.json();

    if (!response.ok) {
      console.error('Upstream error:', response.status, JSON.stringify(data).slice(0, 500));
      session.history.pop();
      const status = response.status === 429 ? 429 : 502;
      return res.status(status).json({ error: 'Failed to generate response. Please try again.', code: status === 429 ? 'rate_limit' : 'upstream' });
    }

    const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
    let reply = knowledge.redactReply(raw);
    if (raw && !reply) reply = PROPRIETARY_REPLY;
    if (!reply) {
      session.history.pop();
      return res.status(502).json({ error: 'Failed to generate response. Please try again.', code: 'empty' });
    }

    session.history.push({ role: 'model', parts: [{ text: reply }] });

    res.json({ reply });
  } catch (err) {
    console.error('Upstream call error:', err.name === 'AbortError' ? 'timeout' : err.message);
    session.history.pop();
    res.status(504).json({ error: 'Failed to generate response. Please try again.', code: 'timeout' });
  }
});

knowledge.start();
app.listen(PORT, () => console.log(`PISUM chat server running on port ${PORT}`));
