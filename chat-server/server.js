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
- Current version: v2.9.8 — trusted by 2,800+ radiologists
- Users download and install it; minimum 8 GB RAM (16 GB recommended for dictation)
- Administrator privileges are generally NOT required for installation
- Internet connection is REQUIRED for AI Dictation, AI Enhancer, Report Translation, and subscription management
- Patient reports and templates are stored locally — no clinical data is ever uploaded to the cloud
- macOS and Linux versions are in development

## PLANS & PRICING
- **Free**: €0 — 10 templates, 2 languages, PDF only, 50 reports/month, AI Dictation 30 min/mo, AI Enhancer 10 uses/mo — free forever, no trial expiry
- **Starter**: €29/mo (€23/mo annual) — 20 templates, 23 languages, PDF + Word, unlimited reports, AI Dictation 500 min/mo, AI Enhancer 50/mo, Basic Worklist
- **Pro**: €79/mo (€63/mo annual) — 112+ templates, 23 languages, PDF + Word + HTML, unlimited reports, AI Dictation 2,000 min/mo, AI Enhancer 200/mo, Report Translation 100/mo, Full Worklist, Basic Statistics ⭐ Most popular
- **Expert**: €129/mo (€103/mo annual) — 112+ custom templates, 23 languages, PDF + Word + HTML, unlimited reports, AI Dictation unlimited, AI Enhancer unlimited, Report Translation unlimited, Advanced Worklist, Full Statistics, LAN sync (1 site · 3 PCs), Chat + email support
- **Clinic**: €399/mo (€319/mo annual) — everything in Expert + 5 users included, multi-site LAN sync, unlimited workstations, Report Translation unlimited, Advanced Statistics, dedicated onboarding, bulk export; extra seats €69/user
- 20% discount on annual billing (saves: Starter €72/yr, Pro €192/yr, Expert €312/yr, Clinic €960/yr)
- 14-day free trial on all paid plans, no credit card required
- 30-day money-back guarantee on all paid plans
- Plans can be switched anytime (upgrades immediate, downgrades at next cycle)
- Payments processed by Lemon Squeezy (PCI-compliant) — PISUM never stores banking details

## FEATURES
- 112 structured templates: CT, MRI, X-Ray, Ultrasound, PET-CT, Interventional
- **Sally AI** voice dictation engine: converts speech into structured radiology report text in real time via a secure cloud API. Audio is never stored. Supports 23 languages with radiology-specific medical vocabulary. Keyboard shortcut: F4 to start/stop recording. Quota varies by plan (see above).
- **AI Enhancer**: AI-powered tool to improve report wording and phrasing. Quota varies by plan (unlimited on Expert & Clinic).
- **Report Translation** (NEW in v2.9.8): converts any completed radiology report into one of 23 languages in seconds. Clinical terminology is preserved; original is never modified — a separate copy is created. Shortcut: Ctrl+T. Available on Pro (100/mo), Expert (unlimited), Clinic (unlimited). Requires internet.
- Custom templates: unlimited, saved locally and travel with your user profile
- Export: PDF and Word (.docx) — copy report to clipboard with Ctrl+C (preserves formatting, ready to paste into RIS/PACS)
- Bulk export for batch reporting: Clinic plan
- Worklist: basic (Starter), full (Pro), advanced (Expert), multi-site (Clinic)
- Statistics: basic (Pro), full (Expert), advanced (Clinic)
- LAN network sharing (Expert & Clinic): share patient database across workstations via NAS/SMB share
  - Data encrypted with AES-256-GCM before touching the network
  - GDPR-compliant audit trail (timestamp + workstation ID) for every access, modification, and export
  - Expert: 1 site, up to 3 workstations; Clinic: multi-site, unlimited workstations
  - Requires SMB 3.0+; all PCs on the same LAN or VPN
- Custom branding (headers, footers, logos, signatures) available on all paid plans; Clinic adds full institutional branding
- RIS/PACS integration: currently via copy-paste (Ctrl+C) or Word export; direct native integration is on the roadmap
- Hospital deployment: patient reports never leave the machine, which satisfies most healthcare data-handling requirements; contact support for enterprise firewall requirements

## KEYBOARD SHORTCUTS
- F4 — Start / stop AI voice dictation
- Ctrl+T — Translate report (Pro, Expert, Clinic)
- Ctrl+C — Copy formatted report (paste into RIS/PACS)

## PRIVACY & GDPR
- Patient reports are stored locally — PISUM never uploads clinical data to the cloud
- AI features (Sally AI, AI Enhancer, Report Translation) connect to a secure cloud API; no audio or report content is ever stored
- Account data only (name, email, subscription status) stored on EU Supabase servers
- GDPR / RGPD compliant
- DPO contact: MyPisum@Proton.me

## MEDICAL DISCLAIMER
- PISUM is a drafting aid — the radiologist retains full medical responsibility
- Templates are structural guides, must be adapted to each patient
- AI reduces report writing time by 60–80%; average report time under 60 seconds

## SUPPORT & CONTACT
- Email: MyPisum@Proton.me
- Response time: within 24 hours (bug reports within 48 hours)
- Languages: English, French, German, Spanish
- Website: pisum.app
- Installation: download the .exe from the welcome email link, double-click, follow on-screen instructions

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
