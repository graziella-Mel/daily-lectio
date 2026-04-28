// scrape.js — runs daily via GitHub Actions
// Scrapes Henri Nouwen Society + Raiati and writes quotes.json

import FirecrawlApp from '@mendable/firecrawl-js';
import fs from 'fs';

const NOUWEN_URL = 'https://www.henrinouwen.org/daily-meditations';
const RAIATI_URL = 'https://georgeskhodr.org/category/articles-ar/raiati-ar/';

const apiKey = process.env.FIRECRAWL_API_KEY;
if (!apiKey) {
  console.error('Missing FIRECRAWL_API_KEY');
  process.exit(1);
}

const app = new FirecrawlApp({ apiKey });

function clean(str) {
  return (str || '')
    .replace(/\s+/g, ' ')
    .replace(/When you give.*$/s, '')
    .replace(/We use cookies.*$/s, '')
    .replace(/Donate Today.*$/s, '')
    .replace(/Read More.*$/s, '')
    .replace(/Subscribe.*$/s, '')
    .trim();
}

// ── Scrape Henri Nouwen ───────────────────────────────
async function scrapeNouwen() {
  console.log('Scraping Henri Nouwen…');
  const quotes = [];

  try {
    // Get listing page to find individual meditation URLs
    const listing = await app.scrapeUrl(NOUWEN_URL, { formats: ['links'] });
    const links = (listing.links || [])
      .filter(l => l.includes('/daily-meditations/') && l.length > 60)
      .slice(0, 15);

    console.log(`Found ${links.length} Nouwen meditation links`);

    for (const link of links) {
      try {
        const page = await app.scrapeUrl(link, {
          formats: ['markdown'],
          onlyMainContent: true,
        });

        const md = page.markdown || '';

        // Title — first ### or #### heading
        const titleMatch = md.match(/#{3,4}\s+(.+)/);
        const title = titleMatch ? titleMatch[1].trim() : '';

        // Date
        const dateMatch = md.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/);
        const date = dateMatch ? dateMatch[0] : 'Henri Nouwen Society';

        // Body — first substantial paragraph
        const SKIP = ['When you give', 'We use cookies', 'Donate', 'Subscribe', 'Join us', 'Book Club', 'Read More', 'Henri Nouwen Society'];
        const lines = md.split('\n').map(l => l.trim()).filter(Boolean);
        let body = '';
        let pastTitle = false;
        for (const line of lines) {
          if (!pastTitle && title && line.includes(title.slice(0, 20))) { pastTitle = true; continue; }
          if (pastTitle && line.length > 80 && !line.startsWith('#') && !line.startsWith('!') && !line.startsWith('[') && !SKIP.some(s => line.startsWith(s))) {
            body = clean(line);
            break;
          }
        }
        // Fallback: just grab any long paragraph
        if (!body) {
          for (const line of lines) {
            if (line.length > 80 && !line.startsWith('#') && !line.startsWith('!') && !SKIP.some(s => line.startsWith(s))) {
              body = clean(line);
              break;
            }
          }
        }

        if (title && body) {
          quotes.push({ src: 'nouwen', title, body, date });
          console.log(`  ✓ Nouwen: "${title}"`);
        }
      } catch (e) {
        console.warn(`  ✗ Failed page ${link}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('Nouwen listing failed:', e.message);
  }

  return quotes;
}

// ── Scrape Raiati ─────────────────────────────────────
async function scrapeRaiati() {
  console.log('Scraping Raiati…');
  const quotes = [];

  try {
    const page = await app.scrapeUrl(RAIATI_URL, {
      formats: ['markdown'],
      onlyMainContent: true,
    });

    const md = page.markdown || '';
    const sections = md.split(/\n##\s+/).slice(1);

    for (const section of sections.slice(0, 8)) {
      const lines = section.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) continue;

      const rawTitle = lines[0];
      const title = rawTitle.split('/')[0].trim();
      if (!title || title.length > 120) continue;

      let body = '';
      for (const line of lines.slice(1)) {
        if (line.length > 80 && !line.startsWith('#') && !line.startsWith('!') && !line.startsWith('[') && !line.startsWith('Download')) {
          body = clean(line);
          break;
        }
      }

      if (title && body) {
        const dateMatch = rawTitle.match(/\d{1,2}\s+[\u0600-\u06FF]+\s+\d{4}/);
        const date = dateMatch ? 'رعيتي — ' + dateMatch[0] : 'رعيتي — المطران جورج خضر';
        quotes.push({ src: 'raiati', title, body, date });
        console.log(`  ✓ Raiati: "${title}"`);
      }
    }
  } catch (e) {
    console.error('Raiati scrape failed:', e.message);
  }

  return quotes.slice(0, 15);
}

// ── Main ──────────────────────────────────────────────
async function main() {
  const [nouwen, raiati] = await Promise.all([scrapeNouwen(), scrapeRaiati()]);

  // Interleave the two sources
  const maxLen = Math.max(nouwen.length, raiati.length);
  const quotes = [];
  for (let i = 0; i < maxLen; i++) {
    if (nouwen[i]) quotes.push(nouwen[i]);
    if (raiati[i]) quotes.push(raiati[i]);
  }

  if (quotes.length === 0) {
    console.error('No quotes scraped — keeping existing quotes.json');
    process.exit(0); // don't overwrite with empty
  }

  const output = {
    updatedAt: new Date().toISOString(),
    counts: { nouwen: nouwen.length, raiati: raiati.length },
    quotes,
  };

  fs.writeFileSync('quotes.json', JSON.stringify(output, null, 2));
  console.log(`\n✅ Saved ${quotes.length} quotes to quotes.json (${nouwen.length} Nouwen, ${raiati.length} Raiati)`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
