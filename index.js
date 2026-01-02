// index.js
const express = require('express');
const Parser = require('@postlight/parser');
const { htmlToText } = require('html-to-text');
const axios = require('axios');
const fs = require('fs');
const { buildContentTextV2 } = require('./lib/buildContentTextV2');

// Fallback-парсер
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

// Опционально: тяжёлый fallback (по флагу)
let puppeteer = null;
let StealthPlugin, AnonymizeUAPlugin, UserDataDirPlugin, UserPreferencesPlugin;

// === Feature flags ===
const SAFE_MODE = process.env.PARSER_SAFE_MODE === '1';
const ENABLE_AMP = process.env.PARSER_ENABLE_AMP !== '0';
const ENABLE_READABILITY = process.env.PARSER_ENABLE_READABILITY !== '0';
const ENABLE_PUPPETEER = process.env.PARSER_ENABLE_PUPPETEER === '1';
const WORDCOUNT_MIN = Number(process.env.PARSER_WORDCOUNT_MIN || 800);
const ENABLE_INTRO_RECOVERY = process.env.PARSER_RECOVER_INTRO !== '0';
const ENABLE_CARD_HEADERS_RECOVERY = process.env.PARSER_RECOVER_CARD_HEADERS !== '0'; // <— НОВОЕ

// Кастомный экстрактор Runner's World
try {
  const rwRule = require('./rules/www.runnersworld.com.js');
  Parser.addExtractor(rwRule);
} catch (e) {
  console.log('Custom extractor not loaded (optional):', e.message);
}

const HEARST_DOMAINS = new Set([
  'www.runnersworld.com',
  'www.menshealth.com',
  'www.womenshealthmag.com',
  'www.goodhousekeeping.com',
  'www.prevention.com'
]);

const app = express();
const port = process.env.PORT || 3000;

// CORS
app.use((_, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Логи
console.log = (...args) => {
  const message = args.join(' ');
  fs.appendFileSync('parser.log', `${new Date().toISOString()} - ${message}\n`, 'utf8');
  process.stdout.write(`${message}\n`, 'utf8');
};
console.error = (...args) => {
  const message = args.join(' ');
  fs.appendFileSync('error.log', `${new Date().toISOString()} - ${message}\n`, 'utf8');
  process.stderr.write(`${message}\n`, 'utf8');
};

// HTTP с ретраями
async function fetchWithRetry(url, options, retries = 7, delay = 20000) {
  let currentUrl = url;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios({
        method: options?.method || 'get',
        url: currentUrl,
        headers: {
          ...options?.headers,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
        },
        timeout: 500000,
        maxRedirects: 10,
        validateStatus: s => s >= 200 && s < 400,
      });
      const finalUrl = response.request?.res?.responseUrl || currentUrl;
      console.log(`Fetch OK: ${finalUrl}`);
      return { response, body: response.data, finalUrl };
    } catch (error) {
      console.error(`Attempt ${attempt} failed for ${currentUrl}: ${error.message}. Left: ${retries - attempt}`);
      if (attempt === retries) throw error;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function wordCountFromHtml(html = '') {
  return (html.replace(/<[^>]+>/g, ' ').match(/\w+/g) || []).length;
}

async function parseWithPostlight(url, html) {
  return Parser.parse(url, { html, contentType: 'text/html' });
}

async function tryAmp(url) {
  const { body } = await fetchWithRetry(url, { headers: {} });
  const m = body.match(/<link[^>]+rel=["']amphtml["'][^>]+href=["']([^"']+)["']/i);
  const ampUrl = m ? m[1] : (url.endsWith('/') ? url + 'amp' : url + '/amp');
  console.log('AMP candidate:', ampUrl);
  const ampFetch = await fetchWithRetry(ampUrl, { headers: {} });
  return parseWithPostlight(ampUrl, ampFetch.body);
}

function readabilityFallback(url, html) {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (!article) return null;
  return { title: article.title, content: article.content };
}

// --- Intro recovery ---
function extractIntroHTML(rawHtml, urlForDom) {
  try {
    const dom = new JSDOM(rawHtml, { url: urlForDom });
    const doc = dom.window.document;

    const root =
      doc.querySelector('main article, article, [itemprop="articleBody"], [data-article-body], .content article, .content') ||
      doc.body;

    const collected = [];

    const lede = root.querySelector('.content-lede, .article-dek, .dek, .intro, .content-info, .css-lede, .css-dek');
    if (lede) {
      lede.querySelectorAll('p').forEach(p => {
        const t = p.textContent.trim();
        if (t.length > 40) collected.push(`<p>${p.innerHTML}</p>`);
      });
    }

    const firstSubhead = root.querySelector('h2, h3');
    const walker = doc.createTreeWalker(root, dom.window.NodeFilter.SHOW_ELEMENT, null);
    let el;
    while ((el = walker.nextNode())) {
      if (el === firstSubhead) break;
      if (el.tagName === 'P') {
        const t = el.textContent.trim();
        if (t.length > 40) collected.push(`<p>${el.innerHTML}</p>`);
      }
    }

    const uniq = [];
    const seen = new Set();
    for (const html of collected) {
      const key = html.replace(/\s+/g, ' ').slice(0, 120);
      if (!seen.has(key)) { seen.add(key); uniq.push(html); }
    }
    return uniq.join('');
  } catch {
    return '';
  }
}

// --- Card header recovery (badge + title + price) ---
function extractFirstCardMeta(rawHtml, urlForDom) {
  try {
    const dom = new JSDOM(rawHtml, { url: urlForDom });
    const doc = dom.window.document;

    const root =
      doc.querySelector('main article, article, [itemprop="articleBody"], [data-article-body], .content article, .content') ||
      doc.body;

    // Найдём маркер «Our Full Running Gloves Reviews»
    let seenMarker = false;
    const isMarker = (txt) => /our full .*running .*gloves .*reviews/i.test(txt);

    // Пройдём документ в порядке следования
    const walker = doc.createTreeWalker(root, dom.window.NodeFilter.SHOW_ELEMENT, null);
    let el, titleNode = null, titleText = '';
    while ((el = walker.nextNode())) {
      const txt = (el.textContent || '').trim();
      if (!seenMarker && txt && isMarker(txt)) {
        seenMarker = true;
        continue;
      }
      if (seenMarker && (el.tagName === 'H2' || el.tagName === 'H3')) {
        const t = (el.textContent || '').trim();
        if (t && t.length >= 8 && t.length <= 160) {
          titleNode = el;
          titleText = t;
          break;
        }
      }
    }
    if (!titleNode) return null;

    // Ищем бейдж и цену "рядом" с заголовком (в пределах нескольких соседей / того же контейнера)
    const container = titleNode.parentElement || root;
    const neighborhood = [];
    // соберём текст ближайших 12 соседей (в обе стороны)
    const siblings = Array.from(container.childNodes);
    const idx = siblings.indexOf(titleNode);
    const from = Math.max(0, idx - 8);
    const to = Math.min(siblings.length, idx + 9);
    for (let i = from; i < to; i++) {
      if (siblings[i].textContent) neighborhood.push(siblings[i].textContent);
    }
    // плюс немного текста снизу по DOM (следующие несколько элементов)
    let step = 0, cursor = titleNode;
    while (cursor && step < 10) {
      cursor = cursor.nextElementSibling;
      if (cursor && cursor.textContent) neighborhood.push(cursor.textContent);
      step++;
    }

    const joined = neighborhood.join(' \n ').replace(/\s+/g, ' ').trim();

    const badgeMatch = joined.match(/\b(Best\s+(?:Overall|Budget|Value|for [^,.;]+)|Editor'?s Choice|Top Pick)\b/i);
    const badge = badgeMatch ? badgeMatch[0] : '';

    // Цена + возможный ритейлер
    const priceMatch = joined.match(/\$\s*\d{1,4}(?:[\.,]\d{2})?/);
    let priceLine = priceMatch ? priceMatch[0] : '';
    if (priceLine) {
      const retailerMatch = joined.match(/\b(Backcountry|Amazon|REI|Nike|Adidas|New Balance|Zappos|Running Warehouse)\b/i);
      if (retailerMatch) priceLine = `${priceLine} ${retailerMatch[0]}`;
    }

    return {
      badge: badge || '',
      title: titleText || '',
      price: priceLine || ''
    };
  } catch (e) {
    console.log('extractFirstCardMeta failed:', e.message);
    return null;
  }
}

function injectFirstCardHeaderIntoContent(contentHTML, meta) {
  if (!meta || !(meta.badge || meta.title || meta.price)) return contentHTML;

  const frag = [
    meta.badge ? `<p><strong>${meta.badge}</strong></p>` : '',
    meta.title ? `<h3>${meta.title}</h3>` : '',
    meta.price ? `<p>${meta.price}</p>` : ''
  ].join('');

  try {
    const dom = new JSDOM(`<div id="__root">${contentHTML}</div>`);
    const doc = dom.window.document;
    const root = doc.getElementById('__root');

    // Ищем маркер секции обзоров
    let markerEl = null;
    const all = root.querySelectorAll('*');
    for (const el of all) {
      const txt = (el.textContent || '').trim();
      if (txt && /our full .*running .*gloves .*reviews/i.test(txt)) {
        markerEl = el;
        break;
      }
    }

    // Если в тексте уже есть заголовок/бейдж/цена — не дублируем
    const plain = root.textContent.replace(/\s+/g, ' ');
    if (meta.title && plain.includes(meta.title)) {
      console.log('Card title already present — skip inject.');
      return contentHTML;
    }

    if (markerEl) {
      markerEl.insertAdjacentHTML('afterend', frag);
      console.log('Inserted card header after marker.');
    } else {
      root.insertAdjacentHTML('afterbegin', frag);
      console.log('Inserted card header at beginning (marker not found).');
    }
    return root.innerHTML;
  } catch (e) {
    console.log('injectFirstCardHeaderIntoContent failed:', e.message);
    // если не удалось — просто припрячем в начало
    return frag + contentHTML;
  }
}

// --- Эндпоинт ---
app.get('/parse', async (req, res) => {
  let url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let result = null;

  try {
    // 1) Базовый парс
    const fetched = await fetchWithRetry(url, { headers: {} });
    url = fetched.finalUrl;
    console.log(`Parse start for: ${url}`);
    result = await parseWithPostlight(url, fetched.body);

    if (!SAFE_MODE) {
      const isHearst = HEARST_DOMAINS.has(new URL(url).hostname);
      const tooShort = !result?.content || wordCountFromHtml(result.content) < WORDCOUNT_MIN;

      if (ENABLE_AMP && (isHearst || tooShort)) {
        try {
          const amp = await tryAmp(url);
          if (amp?.content && wordCountFromHtml(amp.content) > wordCountFromHtml(result?.content || '')) {
            console.log('AMP version chosen.');
            result = amp;
          }
        } catch (e) { console.log('AMP fallback failed:', e.message); }
      }

      if (ENABLE_READABILITY && wordCountFromHtml(result?.content || '') < WORDCOUNT_MIN) {
        try {
          const rb = readabilityFallback(url, fetched.body);
          if (rb?.content && wordCountFromHtml(rb.content) > wordCountFromHtml(result?.content || '')) {
            console.log('Readability fallback chosen.');
            result = { ...result, title: rb.title || result?.title, content: rb.content };
          }
        } catch (e) { console.log('Readability fallback failed:', e.message); }
      }
    }

    if (!result?.content) {
      return res.status(200).json({
        message: 'No main content extracted, but other data available.',
        fullResult: result,
        possibleIssues: 'Non-standard layout or protection.',
      });
    }

    // --- Восстановление Intro ---
    if (ENABLE_INTRO_RECOVERY) {
      try {
        const introHTML = extractIntroHTML(fetched.body, url);
        if (introHTML) {
          const haveIntroAlready =
            result.content && result.content.replace(/\s+/g, ' ').includes(introHTML.replace(/\s+/g, ' ').slice(0, 80));
          if (!haveIntroAlready) {
            result.content = introHTML + '\n' + (result.content || '');
            console.log('Intro prepended.');
          }
        }
      } catch (e) { console.log('Intro recovery failed:', e.message); }
    }

    // --- Восстановление шапки первой карточки (бейдж/название/цена) ---
    if (ENABLE_CARD_HEADERS_RECOVERY) {
      try {
        const meta = extractFirstCardMeta(fetched.body, url);
        if (meta) {
          result.content = injectFirstCardHeaderIntoContent(result.content, meta);
        }
      } catch (e) { console.log('Card header recovery failed:', e.message); }
    }

    // Автор
    const author = result?.author || 'N/A';

    // Санитайз HTML → text
    const cleanHtml = result.content
      .replace(/[\u0019\u2018\u2019]/g, "'")
      .replace(/[\u0014-\u001F\u007F-\u009F]/g, '')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/&#xA0;/g, ' ')
      .replace(/&[#A-Za-z0-9]+;/g, (match) => {
        const entities = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&lt;': '<', '&gt;': '>' };
        return entities[match] || '';
      });

    const plainContent = htmlToText(cleanHtml, {
      wordwrap: 130,
      ignoreHref: true,
      formatters: {
        image: () => '',
        listItem: (str, { tag }) => (tag === 'li' && !str.trim() ? '' : `${str}\n`),
      },
      selectors: [
        { selector: 'script', format: 'skip' },
        { selector: 'style', format: 'skip' },
        { selector: 'iframe', format: 'skip' },
        { selector: '.ad', format: 'skip' },
        { selector: '.advertisement', format: 'skip' },
        { selector: '.related-posts', format: 'skip' },
        { selector: '.comments', format: 'skip' },
        // важно: карточки не скрываем
        // { selector: '.article-card', format: 'skip' },
        // { selector: '.custom-card', format: 'skip' },
        // { selector: '.section.article-grid', format: 'skip' },
        // { selector: '.container.color-dark-gray', format: 'skip' },
      ],
    });

    const finalContent = plainContent
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => {
        if (line.length === 0) return false;
        if (/^\d+\.\s*$/.test(line)) return false;

        // Сохраняем цену/бейджи/названия
        const hasPrice = /\$\s*\d{1,4}(?:[\.,]\d{2})?/.test(line);
        const hasBadge = /\b(Best|Top|Editor'?s Choice|Overall|Budget|Value)\b/i.test(line);
        if (hasPrice || hasBadge) return true;

        // Вырубим только явные CTA без цены
        if (/newsletter|subscribe|read article|leave a reply|your email address|previous post|next post|notifications/i.test(line)) return false;
        if (/(compare prices|shop the shoe|available at|buy now)/i.test(line) && !hasPrice) return false;

        return true;
      })
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    console.log(`Content sample: ${finalContent.slice(0, 500)}`);

    const content_text_v2 = result?.content
      ? buildContentTextV2(result.content)
      : "";

    return res.json({
      content: finalContent,
      content_text_v2,
      title: result.title || 'N/A',
      author,
      fullResult: result,
    });
  } catch (error) {
    console.error('Error:', error.message, error.stack);
    return res.status(500).json({
      error: 'Parsing error',
      details: error.message,
      suggestion: 'Check site accessibility; try enabling fallbacks or SAFE_MODE.',
    });
  }
});

// Root
app.get('/', (_req, res) => {
  res.send('Article Parser Service is running. Use /parse?url=your-article-url');
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
