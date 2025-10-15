// index.js
const express = require('express');
const Parser = require('@postlight/parser');
const { htmlToText } = require('html-to-text');
const axios = require('axios');
const fs = require('fs');

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
const ENABLE_CARD_HEADERS_RECOVERY = process.env.PARSER_RECOVER_CARD_HEADERS !== '0'; // по умолчанию 1

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

// --- Card header recovery (усовершенствовано) ---
function extractFirstCardMeta(rawHtml, urlForDom) {
  try {
    const dom = new JSDOM(rawHtml, { url: urlForDom });
    const doc = dom.window.document;

    const root =
      doc.querySelector('main article, article, [itemprop="articleBody"], [data-article-body], .content article, .content') ||
      doc.body;

    const textIsMarker = (txt) => /our full .*running .*gloves .*reviews/i.test(txt);

    // 1) найдём узел-маркер
    let markerNode = null;
    const allEls = root.querySelectorAll('*');
    for (const el of allEls) {
      const t = (el.textContent || '').trim();
      if (t && textIsMarker(t)) { markerNode = el; break; }
    }

    // область поиска — от маркера вниз (или весь root)
    let scope = root;
    if (markerNode && markerNode.parentElement) scope = markerNode.parentElement;

    // 2) ищем первую цену в области
    const priceCandidates = Array.from(scope.querySelectorAll('*')).filter(n =>
      /\$\s*\d{1,4}(?:[\.,]\d{2})?/.test((n.textContent || ''))
    );
    let priceText = '';
    let anchorForMeta = null;
    if (priceCandidates.length) {
      const priceEl = priceCandidates[0];
      priceText = (priceEl.textContent || '').match(/\$\s*\d{1,4}(?:[\.,]\d{2})?/)[0];
      // поднимаемся к небольшому контейнеру (до 4 уровней), где есть заголовок/ссылка с названием
      let up = priceEl;
      for (let i = 0; i < 4 && up; i++) {
        const hasHeading = up.querySelector && (up.querySelector('h1,h2,h3,h4,a,[data-hed],[data-title]'));
        if (hasHeading) { anchorForMeta = up; break; }
        up = up.parentElement;
      }
      if (!anchorForMeta) anchorForMeta = priceEl.parentElement || scope;
    }

    // 3) извлекаем название
    let title = '';
    if (anchorForMeta) {
      const titleEl =
        anchorForMeta.querySelector('h1,h2,h3,h4,[data-hed],[data-title]') ||
        anchorForMeta.querySelector('a[title], a[aria-label]') ||
        anchorForMeta.querySelector('a');

      title = (titleEl && (titleEl.getAttribute?.('title') || titleEl.getAttribute?.('aria-label') || titleEl.textContent)) || '';
      title = (title || '').replace(/\s+/g, ' ').trim();

      // Если не нашли, возьмём самый длинный внутр. текст с "Glove"
      if (!title || title.length < 8) {
        const texts = Array.from(anchorForMeta.querySelectorAll('*'))
          .map(n => (n.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(s => /glove/i.test(s));
        if (texts.length) title = texts.sort((a,b)=>b.length-a.length)[0];
      }
    }

    // 4) бейдж поблизости
    let badge = '';
    if (anchorForMeta) {
      const nearText = (anchorForMeta.textContent || '').replace(/\s+/g, ' ');
      const m = nearText.match(/\b(Best\s+(?:Overall|Budget|Value|for [^,.;]+)|Editor'?s Choice|Top Pick)\b/i);
      badge = m ? m[0] : '';
      // если не нашли — посмотри на 2 родителя вверх
      if (!badge && anchorForMeta.parentElement) {
        const upText = (anchorForMeta.parentElement.textContent || '').replace(/\s+/g, ' ');
        const m2 = upText.match(/\b(Best\s+(?:Overall|Budget|Value|for [^,.;]+)|Editor'?s Choice|Top Pick)\b/i);
        badge = m2 ? m2[0] : '';
      }
    }

    if (!title && !priceText && !badge) return null;
    return { badge: badge || '', title: title || '', price: priceText || '' };
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

    // Если уже есть заголовок — не дублируем
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

    // --- Восстановление шапки первой карточки ---
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

    // Санитайз HTML → text (карточки не скрываем)
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
        // НЕ скрываем карточки и гриды — иначе пропадут заголовки/цены/бейджи
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
        const hasBadge = /\b(Best|Top|Editor'?s Choice|Overall|Budget|Value|Pick)\b/i.test(line);
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

    return res.json({
      content: finalContent,
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
