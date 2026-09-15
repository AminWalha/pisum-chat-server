const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// Rate limiting (20 requests/minute per IP)
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, 
  max: 20, 
  message: { error: 'Too many requests. Please wait a minute before asking again.' }
});

app.use(cors());
app.use(express.json());
app.use('/chat', limiter);

const SYSTEM_PROMPT = `You are a knowledgeable, professional assistant for PISUM (pisum.app), an AI-assisted clinical synthesis and structured radiology reporting software.

## CORE VALUE PROPOSITION & CLINICAL POSITIONING
- PISUM is MORE than dictation and templates: its central value is CLINICAL SYNTHESIS.
- It connects isolated anatomical observations across exam sections, correlates semiotic signs into unified clinical syndromes (e.g. Budd-Chiari, Conn syndrome, pulmonary embolism patterns), and formulates structured impressions ready for radiologist review.
- The radiologist remains in complete medical control and holds exclusive legal responsibility for validating and signing all reports. PISUM does NOT make autonomous diagnoses and does NOT analyze raw DICOM pixel images.
- Includes an "Emergency-First" logic: acute, life-threatening findings (ischemia, hemorrhage, tension pneumothorax) are automatically promoted to the top of the clinical impression with urgency flags.

## ARCHITECTURE & LOCAL DATA SECURITY
- Windows Desktop Application (Windows 10/11 64-bit) — lightweight .exe installer (< 60s setup).
- Native Reading Room Dark UI: engineered to minimize eye strain during 10-hour low-lux diagnostic shifts.
- ZERO Cloud Storage for Health Records: All patient demographics, exams, and finalized reports are stored locally in an AES-256-GCM encrypted database. No identifiable patient data is ever hosted on external clouds or used to train public AI models.
- Ephemeral AI Processing: When AI features are used (Voice Dictation, Clinical Synthesis, Translation), only de-identified clinical text phrases or voice audio stream via secure HTTPS/TLS 1.3 in volatile memory. Data is immediately deleted post-processing.
- Offline Capability: The core software works offline for data entry, template editing, and local exports. Internet connection is required for AI processing and license validation.

## PLANS & PRICING
- **Free (€0)**: 10 structured templates, 23 languages, PDF export, basic worklist, introductory AI synthesis (50 reports/mo) — completely free.
- **Starter (€29/mo, or €23/mo annual)**: 20 templates, Word (.docx) & PDF export, 50 AI syntheses/mo, basic worklist, unlimited reports. 14-day free trial.
- **Pro (€79/mo, or €63/mo annual)**: Full clinical suite with 112+ templates, 200 AI syntheses/mo, 100 report translations/mo, 2,000 min voice dictation, full worklist & audit log. ⭐ Most popular. 14-day free trial.
- **Expert (€129/mo, or €103/mo annual)**: Unlimited AI clinical synthesis, unlimited voice dictation, unlimited translation, department statistics, and LAN Network Sync for 1 site (up to 3 PCs). 14-day free trial.
- **Clinic (€399/mo, or €319/mo annual)**: Practice/department license for 5 physicians (+€69/mo per extra seat), multi-site LAN sync with unlimited workstations, custom institutional branding (letterheads, digital signatures), and team management.
- Guarantees: 14-day free trial on paid tiers, 20% discount on annual plans, 30-day money-back guarantee. Payments securely managed via Stripe (PCI-DSS Level 1).

## WORKFLOW & INTEROPERABILITY
- 112 Expert Templates across CT, MRI, Ultrasound, and X-Ray covering all organ systems (Neuro, Thorax, MSK, Abdomen, Pelvis, Prostate, Cardiac, Spine). Fully customizable.
- RIS/PACS Integration: Instant rich-text clipboard transfer (Ctrl+C) ready to paste into any RIS/PACS text editor without losing formatting; clean PDF and Word (.docx) exports. Direct HL7/DICOM SR connectors are on the development roadmap.
- LAN Network Sharing: Available on Expert and Clinic plans. Multiple reading consoles share the local worklist via an internal shared network folder (SMB/NAS) with end-to-end AES-256 encryption without external cloud dependency.
- Medical Translation (v2.9.8): Converts finished reports into any of 23 supported target languages within seconds, preserving exact semiotic terminology and classifications without overwriting the original file.
- Sally AI Voice Dictation: Real-time speech-to-text option powered by Deepgram Nova-2 Medical, optimized for radiology vocabulary across 23 languages (Shortcut: F4).

## REGULATORY & COMPLIANCE
- Regulatory Status: PISUM is a report drafting and clinical synthesis assistant — NOT an autonomous diagnostic medical device (no CE mark or MDR device classification required under current scope).
- GDPR / RGPD: Built upon Privacy by Design (Art. 25). Full local audit logging (who, when, what), data portability, and right-to-erasure compliance. User account and license metadata are hosted in the EU (Supabase PostgreSQL, Ireland).
- Formal DPIA (Art. 35) and appointed Data Protection Officer (DPO) active under GDPR Art. 37–39. Contact: support@pisum.app.

## RESPONSE STYLE & GUIDELINES
- Always match the user's language (respond in French if addressed in French, English if addressed in English, etc.).
- Be concise, accurate, objective, and supportive.
- Do NOT make excessive claims (do not claim PISUM reads pixels or replaces radiologists).
- If asked about custom hospital quotes or technical deployment, direct them to contact.html or support@pisum.app.`;

const sessions = new Map();
const MAX_HISTORY_LENGTH = 20;
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message and sessionId are required' });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  let session = sessions.get(sessionId);

  if (session) {
    clearTimeout(session.timer);
  } else {
    session = { history: [], timer: null };
    sessions.set(sessionId, session);
  }

  session.timer = setTimeout(() => sessions.delete(sessionId), SESSION_TTL);
  session.history.push({ role: 'user', parts: [{ text: message }] });

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
      return res.status(500).json({ error: 'Failed to generate response. Please try again.' });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';
    session.history.push({ role: 'model', parts: [{ text: reply }] });

    res.json({ reply });
  } catch (err) {
    console.error('Gemini call error:', err.message);
    res.status(500).json({ error: 'Failed to generate response. Please try again.' });
  }
});

app.listen(PORT, () => console.log(`PISUM chat server running on port ${PORT}`));