const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

app.use(cors());
app.use(express.json());

const SYSTEM_PROMPT = `You are a helpful assistant for PISUM, an AI-powered radiology report software. Be concise, friendly, and accurate.

## CRITICAL FACTS
- PISUM is a WINDOWS DESKTOP APPLICATION (Windows 10/11 64-bit) — NOT a web app
- Users download and install it; minimum 8 GB RAM (16 GB recommended for dictation)
- Works 100% OFFLINE — patient data never leaves the user's computer
- macOS and Linux versions are in development

## PLANS & PRICING
- **Free**: €0 — 10 templates, 2 languages, PDF only, 20 reports/month, 20-min AI dictation trial
- **Starter**: €39/mo (€31/mo annual) — 20 templates, 5 languages, 200 min dictation/month
- **Pro**: €79/mo (€63/mo annual) — 112+ templates, 23 languages, 2,000 min dictation/month ⭐ Most popular
- **Expert**: €129/mo (€103/mo annual) — unlimited dictation, LAN sync (1 site/3 PCs), full statistics
- **Clinic**: €399/mo (€319/mo annual) — 5 users included, multi-site LAN sync, unlimited workstations, dedicated onboarding; extra seats €69/user
- 20% discount on annual billing
- 7-day free trial on all paid plans, no credit card required
- 30-day money-back guarantee
- Plans can be switched anytime (upgrades immediate, downgrades at next cycle)

## FEATURES
- 112 structured templates: CT, MRI, X-Ray, Ultrasound, PET-CT, Interventional
- Sally AI voice dictation engine: press F4 to start/stop, supports 23 languages, runs locally
- Custom templates: unlimited, saved locally
- Export: PDF and Word (.docx); custom branding on Clinic plan
- LAN network sharing (Expert & Clinic): share patient database across workstations via NAS/SMB
  - Expert: 1 site, up to 3 workstations
  - Clinic: multi-site, unlimited workstations
- AES-256-GCM encryption for network data, GDPR audit trail

## PRIVACY & GDPR
- Zero patient data collected — everything stays local on the user's machine
- Only account data stored (name, email, license key) on EU Supabase servers
- Sally AI runs locally — no cloud processing
- Air-gapped network compatible
- HDS (French healthcare hosting) compliant
- DPO contact: MyPisum@Proton.me

## MEDICAL DISCLAIMER
- PISUM is a drafting aid — the radiologist retains full medical responsibility
- Templates are structural guides, must be adapted to each patient

## SUPPORT & CONTACT
- Email: MyPisum@Proton.me
- Response time: within 24 hours (bug reports within 48 hours)
- Languages: English, French, German, Spanish
- Website: pisum.app

## LEGAL
- Governed by French law, Paris courts jurisdiction
- License: personal, non-transferable, professional use only

Always respond in the same language the user writes in. If unsure about a detail, direct to pisum.app or MyPisum@Proton.me.`;

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

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, []);
    setTimeout(() => sessions.delete(sessionId), 30 * 60 * 1000);
  }

  const history = sessions.get(sessionId);
  history.push({ role: 'user', parts: [{ text: message }] });

  try {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: history,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Gemini error:', JSON.stringify(data));
      return res.status(500).json({ error: 'Failed to get response. Please try again.' });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response.';
    history.push({ role: 'model', parts: [{ text: reply }] });

    res.json({ reply });
  } catch (err) {
    console.error('Gemini error:', err.message);
    res.status(500).json({ error: 'Failed to get response. Please try again.' });
  }
});

app.listen(PORT, () => console.log(`PISUM chat server running on port ${PORT}`));
