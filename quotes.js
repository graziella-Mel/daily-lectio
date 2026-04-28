import FirecrawlApp from '@mendable/firecrawl-js';

// ── In-memory cache (persists across warm invocations on Vercel) ──────────
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

// ── Sources ───────────────────────────────────────────────────────────────
const NOUWEN_URL  = 'https://www.henrinouwen.org/daily-meditations';
const RAIATI_URL  = 'https://georgeskhodr.org/category/articles-ar/raiati-ar/';

// ── Helpers ───────────────────────────────────────────────────────────────
function clean(str) {
  return (str || '')
    .replace(/\s+/g, ' ')
    .replace(/When you give.*$/s, '')
    .replace(/We use cookies.*$/s, '')
    .replace(/Donate Today.*$/s, '')
    .replace(/Read More.*$/s, '')
    .trim();
}

// ── Scrape Henri Nouwen ───────────────────────────────────────────────────
async function scrapeNouwen(app) {
  const quotes = [];

  // 1. Scrape the listing page to get individual meditation URLs
  const listing = await app.scrapeUrl(NOUWEN_URL, {
    formats: ['links'],
  });

  const links = (listing.links || [])
    .filter(l => l.includes('/daily-meditations/') && l.length > 60)
    .slice(0, 6);

  // 2. Scrape each individual meditation page
  for (const link of links) {
    try {
      const page = await app.scrapeUrl(link, {
        formats: ['markdown'],
        onlyMainContent: true,
      });

      const md = page.markdown || '';

      // Extract title — first ### or #### heading
      const titleMatch = md.match(/#{3,4}\s+(.+)/);
      const title = titleMatch ? titleMatch[1].trim() : '';

      // Extract date from page metadata or markdown
      const dateMatch = md.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/);
      const date = dateMatch ? dateMatch[0] : '';

      // Extract body — first substantial paragraph after the title
      const lines = md.split('\n').map(l => l.trim()).filter(Boolean);
      let body = '';
      let pastTitle = false;
      for (const line of lines) {
        if (!pastTitle && (line.startsWith('#') || line.includes(title))) {
          pastTitle = true;
          continue;
        }
        if (pastTitle && line.length > 80 && !line.startsWith('#') && !line.startsWith('!') && !line.startsWith('[')) {
          body = clean(line);
          break;
        }
      }

      if (title && body) {
        quotes.push({ src: 'nouwen', title, body, date: date || 'Henri Nouwen Society' });
      }
    } catch (e) {
      console.error('Nouwen page error:', e.message);
    }
  }

  return quotes;
}

// ── Scrape Raiati ─────────────────────────────────────────────────────────
async function scrapeRaiati(app) {
  const page = await app.scrapeUrl(RAIATI_URL, {
    formats: ['markdown'],
    onlyMainContent: true,
  });

  const md = page.markdown || '';
  const quotes = [];

  // Split by ## headings — each one is a bulletin entry
  const sections = md.split(/\n##\s+/).slice(1);

  for (const section of sections.slice(0, 8)) {
    const lines = section.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    // Title is the first line (the ## heading content), strip date suffixes
    const rawTitle = lines[0];
    const title = rawTitle.split('/')[0].trim();
    if (!title || title.length > 120) continue;

    // Find first meaty Arabic paragraph
    let body = '';
    for (const line of lines.slice(1)) {
      if (line.length > 80 && !line.startsWith('#') && !line.startsWith('!') && !line.startsWith('[') && !line.startsWith('Download')) {
        body = clean(line);
        break;
      }
    }

    if (title && body) {
      // Try to extract a date from the raw title
      const dateMatch = rawTitle.match(/\d{1,2}\s+[\u0600-\u06FF]+\s+\d{4}/);
      const date = dateMatch ? 'رعيتي — ' + dateMatch[0] : 'رعيتي — المطران جورج خضر';
      quotes.push({ src: 'raiati', title, body, date });
    }
  }

  return quotes.slice(0, 6);
}

// ── Main handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Serve from cache if fresh
  if (cache && Date.now() - cacheTime < CACHE_TTL) {
    return res.status(200).json({ quotes: cache, cached: true, cachedAt: new Date(cacheTime).toISOString() });
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'FIRECRAWL_API_KEY not set' });
  }

  try {
    const app = new FirecrawlApp({ apiKey });

    // Scrape both sources in parallel
    const [nouwen, raiati] = await Promise.allSettled([
      scrapeNouwen(app),
      scrapeRaiati(app),
    ]);

    const nouwenQuotes = nouwen.status === 'fulfilled' ? nouwen.value : [];
    const raiatiQuotes = raiati.status === 'fulfilled' ? raiati.value : [];

    // Interleave: Nouwen, Raiati, Nouwen, Raiati...
    const maxLen = Math.max(nouwenQuotes.length, raiatiQuotes.length);
    const interleaved = [];
    for (let i = 0; i < maxLen; i++) {
      if (nouwenQuotes[i]) interleaved.push(nouwenQuotes[i]);
      if (raiatiQuotes[i]) interleaved.push(raiatiQuotes[i]);
    }

    if (interleaved.length === 0) {
      return res.status(502).json({ error: 'No quotes scraped from either source' });
    }

    // Update cache
    cache = interleaved;
    cacheTime = Date.now();

    return res.status(200).json({
      quotes: interleaved,
      cached: false,
      cachedAt: new Date(cacheTime).toISOString(),
      counts: { nouwen: nouwenQuotes.length, raiati: raiatiQuotes.length },
    });

  } catch (e) {
    console.error('Scrape error:', e);
    // Return stale cache if available
    if (cache) {
      return res.status(200).json({ quotes: cache, cached: true, stale: true, cachedAt: new Date(cacheTime).toISOString() });
    }
    return res.status(500).json({ error: e.message });
  }
}
