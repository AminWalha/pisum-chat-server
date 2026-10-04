// Live knowledge for the assistant. Every refresh it re-reads:
//   - the whole website: home page + sitemap, then every internal link (new pages are found automatically),
//   - plans and prices from the pricing page,
//   - the FAQ,
//   - the software version and changelog from the same version.json the desktop app uses.
// Default refresh: every 5 minutes.
// Nothing has to be updated here when the website or the software changes.

const { readList } = require('./secrets');

const SITE_URL = (process.env.SITE_URL || 'https://pisum.app').replace(/\/$/, '');
const VERSION_URL = process.env.VERSION_URL || 'https://raw.githubusercontent.com/AminWalha/Pisum/refs/heads/main/version.json';
const REFRESH_MS = Math.max(5, Number(process.env.KNOWLEDGE_REFRESH_MINUTES) || 5) * 60 * 1000;
const FETCH_TIMEOUT = 10000;
const PAGE_BUDGET = Number(process.env.KNOWLEDGE_PAGE_CHARS) || 7000;
const MAX_BLOCK_LENGTH = Number(process.env.KNOWLEDGE_MAX_CHARS) || 80000;
const MAX_PAGES = Number(process.env.KNOWLEDGE_MAX_PAGES) || 40;
// Pages without useful public content, or handled by a dedicated parser below
const EXCLUDED_PAGES = (process.env.KNOWLEDGE_EXCLUDE || 'auth.html,dashboard.html,faq.html,pricing.html')
  .split(',').map((s) => s.trim()).filter(Boolean);
const FALLBACK_PAGES = ['/', '/documentation.html', '/contact.html', '/rgpd.html', '/terms.html', '/mentions-legales.html', '/dpia.html', '/dpo.html'];

// Defense in depth: never pass along a sentence that would reveal how the AI works internally.
// Generic technical terms are listed here; vendor names come from a private list
// (Render Secret File confidential-terms.txt or the CONFIDENTIAL_TERMS variable).
const GENERIC_TERMS = ['endpoint', 'endpoints', 'websocket', 'websockets', 'stream', 'streams', 'streamed', 'streaming', 'after each pause', 'sentence by sentence'];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CONFIDENTIAL_TERMS = [...GENERIC_TERMS, ...readList('CONFIDENTIAL_TERMS', 'confidential-terms.txt')];
const CONFIDENTIAL = new RegExp('\\b(' + CONFIDENTIAL_TERMS.map(escapeRe).join('|') + ')\\b', 'i');

let block = '';
let lastContent = '';
let fetchedAt = null;
let lastError = null;
let pagesRead = 0;
let resolveReady;
const ready = new Promise((r) => { resolveReady = r; });

async function get(pathOrUrl, asJson) {
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${SITE_URL}${pathOrUrl}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}kb=${Date.now()}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`${pathOrUrl}: HTTP ${res.status}`);
    return asJson ? res.json() : res.text();
  } finally {
    clearTimeout(timer);
  }
}

function clean(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(li|p|div|h[1-6]|tr|td|th)>/gi, '. ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&euro;/g, '€')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/([.:!?])(\s*\.)+/g, '$1')
    .replace(/(\.\s*){2,}/g, '. ')
    .trim();
}

function redact(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !CONFIDENTIAL.test(s))
    .join(' ')
    .trim();
}

const safe = (html) => redact(clean(html));

// Visible content of a page, without navigation, footer, assistant widget, cookie banner or code
function pageContent(html) {
  const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
  let body = (html.match(/<main\b[\s\S]*?<\/main>/i) || html.match(/<body\b[\s\S]*<\/body>/i) || [html])[0];
  body = body
    .replace(/<!-- ── PISUM AI Agent Widget[\s\S]*?end AI Agent Widget ── -->/g, ' ')
    .replace(/<div id="piw"[\s\S]*?<\/script>/g, ' ')
    .replace(/<div id="pisum-cookie-banner"[\s\S]*?<\/div>\s*<\/div>/g, ' ')
    .replace(/<(nav|footer|header)\b[\s\S]*?<\/\1>/gi, ' ');
  return { title: safe(title), text: safe(body) };
}

async function sitemapPages() {
  try {
    const xml = await get('/sitemap.xml');
    const paths = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)]
      .map((m) => m[1])
      .filter((u) => u.startsWith(SITE_URL))
      .map((u) => u.slice(SITE_URL.length) || '/');
    if (paths.length) return paths;
  } catch (e) {
    // fall back to the known pages
  }
  return FALLBACK_PAGES;
}

const SITE_HOST = new URL(SITE_URL).hostname.replace(/^www\./, '');
const isExcluded = (p) => EXCLUDED_PAGES.some((x) => p.endsWith(x));

// Internal links of a page, as site paths ("/", "/docs.html", "/saas/frontend/pricing.html")
function internalLinks(html, fromPath) {
  const out = new Set();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)/gi)) {
    let url;
    try { url = new URL(m[1], `${SITE_URL}${fromPath}`); } catch (e) { continue; }
    if (!/^https?:$/.test(url.protocol) || url.hostname.replace(/^www\./, '') !== SITE_HOST) continue;
    const p = url.pathname.replace(/\/index\.html$/, '/');
    if (p === '/' || /\.html$/i.test(p)) out.add(p);
  }
  return [...out];
}

// Crawls the whole website: starts from the home page and the sitemap, then follows internal links.
async function loadPages() {
  const queue = ['/', ...(await sitemapPages())];
  const seen = new Set();
  const pages = [];
  while (queue.length && seen.size < MAX_PAGES) {
    const batch = [];
    while (queue.length && batch.length < 8 && seen.size + batch.length < MAX_PAGES) {
      const p = queue.shift();
      if (!seen.has(p) && !batch.includes(p) && !isExcluded(p)) batch.push(p);
    }
    batch.forEach((p) => seen.add(p));
    const results = await Promise.allSettled(batch.map(async (p) => ({ p, html: await get(p) })));
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { p, html } = r.value;
      internalLinks(html, p).forEach((l) => { if (!seen.has(l)) queue.push(l); });
      const { title, text } = pageContent(html);
      if (text) pages.push({ p, title, text });
    }
  }
  pagesRead = pages.length;
  return pages.map(({ p, title, text }) => {
    const body = text.length > PAGE_BUDGET ? text.slice(0, PAGE_BUDGET).replace(/\s\S*$/, '') + ' …' : text;
    return `#### ${title || p} (${SITE_URL}${p})\n${body}`;
  }).join('\n\n');
}

async function loadPricing() {
  const [page, tr] = await Promise.all([
    get('/saas/frontend/pricing.html'),
    get('/saas/frontend/translations/en.json', true),
  ]);
  const prices = { free: { monthly: 0, annual: 0 } };
  for (const m of page.matchAll(/id="price-(\w+)"[^>]*data-monthly="(\d+)"[^>]*data-annual="(\d+)"/g)) {
    prices[m[1]] = { monthly: Number(m[2]), annual: Number(m[3]) };
  }
  const p = tr.pricing || {};
  const lines = [];
  for (const [id, plan] of Object.entries(p.plans || {})) {
    if (!plan || typeof plan !== 'object') continue;
    const price = prices[id];
    const features = Object.keys(plan)
      .filter((k) => /^f\d+$/.test(k))
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
      .map((k) => safe(plan[k]))
      .filter(Boolean);
    let head = `- ${safe(plan.name || id)}`;
    if (price) {
      head += ` — €${price.monthly}/month`;
      if (price.annual && price.annual !== price.monthly) head += ` (€${price.annual}/month billed annually)`;
    }
    const extras = [plan.subtitle, plan.trial, plan.microcopy].map(safe).filter(Boolean).join('. ');
    lines.push(`${head}. ${extras ? extras + '. ' : ''}Includes: ${features.join('; ')}.`);
  }
  if (p.clinic && p.clinic.users) lines.push(`- Clinic seats: ${safe(p.clinic.users)}.`);
  if (p.guarantee) lines.push(`- ${safe(p.guarantee)}.`);

  const faq = [];
  const f = p.faq || {};
  for (let i = 1; f[`q${i}`]; i++) {
    const q = safe(f[`q${i}`]);
    const a = safe(f[`a${i}`]);
    if (q && a) faq.push(`Q: ${q}\nA: ${a}`);
  }
  return { plans: lines.join('\n'), faq: faq.join('\n\n') };
}

async function loadFaq() {
  const html = await get('/faq.html');
  const out = [];
  for (const m of html.matchAll(/<span class="acc-q-text">([\s\S]*?)<\/span>[\s\S]*?<div class="acc-body-inner">([\s\S]*?)<\/div>/g)) {
    const q = safe(m[1]);
    const a = safe(m[2]);
    if (q && a) out.push(`Q: ${q}\nA: ${a}`);
  }
  return out.join('\n\n');
}

async function loadVersion() {
  const v = await get(VERSION_URL, true);
  if (!v || !v.version) return '';
  let text = `PISUM ${v.version}${v.release_date ? `, released ${v.release_date}` : ''}.`;
  const log = v.changelog && (safe(v.changelog.en) || safe(v.changelog.fr));
  if (log) text += `\nWhat's new in this version: ${log}`;
  return text;
}

async function refresh() {
  const results = await Promise.allSettled([loadVersion(), loadPricing(), loadFaq(), loadPages()]);
  const [version, pricing, faq, pages] = results.map((r) => (r.status === 'fulfilled' ? r.value : null));
  const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason && r.reason.message);

  const parts = [];
  if (version) parts.push(`### Current software version\n${version}`);
  if (pricing && pricing.plans) parts.push(`### Plans and prices\n${pricing.plans}`);
  if (pricing && pricing.faq) parts.push(`### Pricing FAQ\n${pricing.faq}`);
  if (faq) parts.push(`### Website FAQ\n${faq}`);
  if (pages) parts.push(`### Website pages\n${pages}`);

  if (parts.length) {
    const now = new Date();
    let content = parts.join('\n\n');
    if (content.length > MAX_BLOCK_LENGTH) content = content.slice(0, MAX_BLOCK_LENGTH).replace(/\s\S*$/, '') + ' …';
    // Rebuild the block only when the website actually changed: an identical prompt prefix
    // lets the AI service reuse its cache, which makes requests cheaper and faster.
    if (content !== lastContent) {
      lastContent = content;
      block = `## LIVE WEBSITE DATA (read from ${SITE_URL}, last change detected on ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC)\n` +
        'This is the current information published on the website and by the software. It is the source of truth: when it differs from anything else in these instructions, this data wins.\n\n' +
        content;
    }
    fetchedAt = now;
  }
  lastError = failed.length ? failed.join('; ') : null;
  if (lastError) console.error('Knowledge refresh incomplete:', lastError);
  else console.log(`Knowledge refreshed: ${block.length} chars, ${pagesRead} pages`);
  resolveReady();
}

function start() {
  refresh().catch((e) => { lastError = e.message; resolveReady(); });
  setInterval(() => refresh().catch((e) => { lastError = e.message; }), REFRESH_MS).unref();
}

// Output filter: removes from an assistant reply every sentence that mentions a confidential term,
// whatever the source (live data or general knowledge).
function redactReply(text) {
  return String(text || '')
    .split('\n')
    .map((line) => {
      if (!CONFIDENTIAL.test(line)) return line;
      const kept = line.split(/(?<=[.!?])\s+/).filter((s) => !CONFIDENTIAL.test(s)).join(' ');
      return kept.trim() ? kept : null;
    })
    .filter((line) => line !== null)
    .join('\n')
    .trim();
}

module.exports = {
  start,
  ready,
  refresh,
  redactReply,
  getBlock: () => block,
  hasPricing: () => block.includes('### Plans and prices'),
  status: () => ({ fetchedAt: fetchedAt && fetchedAt.toISOString(), chars: block.length, pages: pagesRead, error: lastError }),
};
