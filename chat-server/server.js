const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// Limiter les requêtes (protection contre le spam/abus API)
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, 
  max: 20, 
  message: { error: 'Trop de requêtes, veuillez réessayer dans une minute.' }
});

app.use(cors());
app.use(express.json());
app.use('/chat', limiter);

const SYSTEM_PROMPT = `You are a helpful assistant for PISUM, an AI-powered radiology reporting desktop software. Be concise, friendly, and accurate.

## CRITICAL FACTS
- PISUM is a WINDOWS DESKTOP APPLICATION (Windows 10/11 64-bit) — NOT a web app.
- Current version: v2.9.8 — built for solo radiologists who spend too long on reports.
- Users download and install the .exe; minimum 8 GB RAM (16 GB recommended for dictation).
- Administrator privileges are generally NOT required for installation.
- Operating mode: Works 100% offline for data entry and export. Internet connection is ONLY required for AI features (Dictation, AI Enhancer, Report Translation) and subscription verification.
- Zero Cloud Health Data: Reports and patient data remain 100% local on the user's machine. No patient data or voice recording is ever stored on the cloud (GDPR Art. 25 & HDS-ready).
- macOS and Linux versions are currently in development.

## PLANS & PRICING
- **Free**: €0 — 10 templates, 2 languages, PDF only, 50 reports/month, AI Dictation 30 min/mo, AI Enhancer 10 uses/mo, Limited Worklist — free forever, no trial expiry.
- **Starter**: €29/mo (€23/mo annual) — 20 templates, 23 languages, PDF + Word, unlimited reports, AI Dictation 500 min/mo, AI Enhancer 50/mo, Basic Worklist.
- **Pro**: €79/mo (€63/mo annual) — 112+ templates, 23 languages, PDF + Word + HTML, unlimited reports, AI Dictation 2,000 min/mo, AI Enhancer 200/mo, Report Translation 100/mo, Full Worklist, Basic Statistics, Priority email support ⭐ Most popular.
- **Expert**: €129/mo (€103/mo annual) — 112+ custom templates, 23 languages, PDF + Word + HTML, unlimited reports, AI Dictation unlimited, AI Enhancer unlimited, Report Translation unlimited, Advanced Worklist, Full Statistics, LAN sync (1 site · 3 PCs), Chat + email support 🔥 Best Value.
- **Clinic**: €399/mo (€319/mo annual) — everything in Expert + 5 users included, multi-site LAN sync, unlimited workstations, Report Translation unlimited, Advanced Statistics, dedicated onboarding, bulk export; extra seats €69/user.
- 20% discount on annual billing (saves: Starter €72/yr, Pro €192/yr, Expert €312/yr, Clinic €960/yr).
- 14-day free trial on Starter, Pro, and Expert plans, no credit card required.
- 30-day money-back guarantee on all paid plans.
- Plans can be switched anytime (upgrades immediate, downgrades at next cycle).
- Payments processed by Lemon Squeezy (PCI-compliant) — PISUM never stores banking details.

## FEATURES & WORKFLOW
- 112 structured templates: CT, MRI, X-Ray, Ultrasound, PET-CT, Interventional across every body system.
- Average report completion time: ~47 seconds.
- **Sally AI** voice dictation engine: converts speech into structured radiology report text in real time via a secure cloud API. Audio is processed dynamically and never stored. Supports 23 languages with validated medical vocabulary. Keyboard shortcut: F4 to start/stop recording.
- **AI Enhancer**: Improves phrasing and clinical wording.
- **Report Translation** (v2.9.8): Translates complete reports into one of 23 languages in seconds, maintaining terminology and creating a separate translated copy (Ctrl+T).
- Custom templates: Unlimited custom templates, stored locally.
- Export & Integration: PDF, Word (.docx), or direct copy to clipboard (Ctrl+C) for instant pasting into RIS/PACS.
- LAN Network Sharing (Expert & Clinic): AES-256-GCM encrypted local network sync via NAS/SMB 3.0+ with GDPR-compliant audit trail.

## KEYBOARD SHORTCUTS
- F4 — Start / stop AI voice dictation
- Ctrl+T — Translate report (Pro, Expert, Clinic)
- Ctrl+C — Copy formatted report (ready for RIS/PACS)

## PRIVACY & COMPLIANCE
- Patient reports, images, and transcriptions are strictly local.
- Account data (email, license key) hosted on EU Supabase servers.
- Fully GDPR / RGPD compliant and HDS-ready architecture.
- DPO contact: support@pisum.app

## MEDICAL DISCLAIMER
- PISUM is a drafting and formatting aid (not a diagnostic medical device — no CE marking / MDR classification required).
- Radiologists retain exclusive medical liability for validating and signing reports.

## SUPPORT & CONTACT
- Email: support@pisum.app (responses within 24h, bugs within 48h)
- Languages: English, French, German, Spanish
- Website: pisum.app

Always respond in the same language the user writes in. If unsure about a specific detail, direct to pisum.app or support@pisum.app.`;

// Map pour les sessions (sessionId -> { history: [], timer: Timeout })
const sessions = new Map();
const MAX_HISTORY_LENGTH = 20; // 10 allers-retours max
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message and sessionId are required' });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  // Récupération ou création de la session
  let session = sessions.get(sessionId);

  if (session) {
    clearTimeout(session.timer);
  } else {
    session = { history: [], timer: null };
    sessions.set(sessionId, session);
  }

  // Prolongation du TTL de 30 min après chaque message
  session.timer = setTimeout(() => sessions.delete(sessionId), SESSION_TTL);

  // Ajout du message utilisateur
  session.history.push({ role: 'user', parts: [{ text: message }] });

  // Limitation de l'historique aux N derniers messages
  if (session.history.length > MAX_HISTORY_LENGTH) {
    session.history = session.history.slice(-MAX_HISTORY_LENGTH);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: session.history,
      }),
    });

    clearTimeout(timeoutId);

    const data = await response.json();

    if (!response.ok) {
      console.error('Gemini error:', JSON.stringify(data));
      return res.status(500).json({ error: 'Failed to get response. Please try again.' });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response.';
    
    // Sauvegarde de la réponse modèle dans l'historique
    session.history.push({ role: 'model', parts: [{ text: reply }] });

    res.json({ reply });
  } catch (err) {
    console.error('Gemini error:', err.message);
    res.status(500).json({ error: 'Failed to get response. Please try again.' });
  }
});

app.listen(PORT, () => console.log(`PISUM chat server running on port ${PORT}`));