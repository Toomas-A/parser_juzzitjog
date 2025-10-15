// index.js
const express = require('express');
const Parser = require('@postlight/parser'); // Новый основной парсер
const { htmlToText } = require('html-to-text');
const axios = require('axios');
const fs = require('fs');

// Fallback-парсер
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

// Опционально: тяжёлый fallback (по флагу)
let puppeteer = null;
let StealthPlugin, AnonymizeUAPlugin, UserDataDirPlugin, UserPreferencesPlugin;

// === Feature flags (через Render Env) ===
const SAFE_MODE = process.env.PARSER_SAFE_MODE === '1';                   // 1 = старое поведение (без AMP/Readability/кастом-правил)
const ENABLE_AMP = process.env.PARSER_ENABLE_AMP !== '0';                 // 1 по умолчанию
const ENABLE_READABILITY = process.env.PARSER_ENABLE_READABILITY !== '0'; // 1 по умолчанию
const ENABLE_PUPPETEER = process.env.PARSER_ENABLE_PUPPETEER === '1';     // 0 по умолчанию
const WORDCOUNT_MIN = Number(process.env.PARSER_WORDCOUNT_MIN || 800);    // порог "короткого" текста
const ENABLE_INTRO_RECOVERY = process.env.PARSER_RECOVER_INTRO !== '0';   // 1 по умолчанию

// Регистрируем кастомный экстрактор для Runner's World
try {
  const rwRule = require('./rules/www.runnersworld.com.js');
  Parser.addExtractor(rwRule);
} catch (e) {
  // если файла нет — просто продолжаем
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

// Логи в файлы + консоль
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

// --- Intro recovery: из сырого HTML берём лид/абзацы до первого H2/H3 и добавляем в начало ---
function extractIntroHTML(rawHtml, urlForDom) {
  try {
    const dom = new JSDOM(rawHtml, { url: urlForDom });
    const doc = dom.window.document;

    const root =
      doc.querySelector('main article, article, [itemprop="articleBody"], [data-article-body], .content article, .content') ||
      doc.body;

    const collected = [];

    // явные lede/dek
    const lede = root.querySelector('.content-lede, .article-dek, .dek, .intro, .content-info, .css-lede, .css-dek');
    if (lede) {
      lede.querySelectorAll('p').forEach(p => {
        const t = p.textContent.trim();
        if (t.length > 40) collected.push(`<p>${p.innerHTML}</p>`);
      });
    }

    // абзацы до первого подзаголовка
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

    // уникализация
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

// --- Эндпоинт ---
app.get('/parse', async (req, res) => {
  let url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let result = null;
  let author = 'N/A';

  try {
    // 1) Базовый парс (по финальному URL и исходному HTML)
    const fetched = await fetchWithRetry(url, { headers: {} });
    url = fetched.finalUrl;
    console.log(`Parse start for: ${url}`);
    result = await parseWithPostlight(url, fetched.body);

    // 2) Безопасный режим: выдаём как есть
    if (!SAFE_MODE) {
      const isHearst = HEARST_DOMAINS.has(new URL(url).hostname);
      const tooShort = !result?.content || wordCountFromHtml(result.content) < WORDCOUNT_MIN;

      // 2a) AMP
      if (ENABLE_AMP && (isHearst || tooShort)) {
        try {
          const amp = await tryAmp(url);
          if (amp?.content && wordCountFromHtml(amp.content) > wordCountFromHtml(result?.content || '')) {
            console.log('AMP version chosen (better content).');
            result = amp;
          }
        } catch (e) {
          console.log('AMP fallback failed:', e.message);
        }
      }

      // 2b) Readability
      if (ENABLE_READABILITY && wordCountFromHtml(result?.content || '') < WORDCOUNT_MIN) {
        try {
          const html = fetched.body; // уже есть исходный HTML
          const rb = readabilityFallback(url, html);
          if (rb?.content && wordCountFromHtml(rb.content) > wordCountFromHtml(result?.content || '')) {
            console.log('Readability fallback chosen (better content).');
            result = { ...result, title: rb.title || result?.title, content: rb.content };
          }
        } catch (e) {
          console.log('Readability fallback failed:', e.message);
        }
      }

      // 2c) Тяжёлый Puppeteer — только по явному флагу
      if (ENABLE_PUPPETEER && wordCountFromHtml(result?.content || '') < WORDCOUNT_MIN) {
        try {
          if (!puppeteer) {
            puppeteer = require('puppeteer-extra');
            StealthPlugin = require('puppeteer-extra-plugin-stealth');
            AnonymizeUAPlugin = require('puppeteer-extra-plugin-anonymize-ua');
            UserDataDirPlugin = require('puppeteer-extra-plugin-user-data-dir');
            UserPreferencesPlugin = require('puppeteer-extra-plugin-user-preferences');
            puppeteer.use(StealthPlugin());
            puppeteer.use(AnonymizeUAPlugin());
            puppeteer.use(UserDataDirPlugin());
            puppeteer.use(
              UserPreferencesPlugin({
                userPrefs: {
                  'intl.accept_languages': 'en-US,en',
                  'webrtc.ip_handling_policy': 'disable_non_proxied_udp',
                  'webrtc.multiple_routes_enabled': false,
                  'webrtc.enabled': false,
                  'privacy.sandbox.enabled': false,
                  'enable_do_not_track': 1,
                },
              })
            );
          }

          console.log('Starting heavy Puppeteer fallback...');
          const browser = await puppeteer.launch({
            headless: false,
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-gpu',
              '--window-size=1920,1080',
              '--disable-web-security',
              '--disable-features=IsolateOrigins,site-per-process',
              '--blink-settings=imagesEnabled=false',
              '--no-zygote',
              '--disable-accelerated-2d-canvas',
              '--disable-background-networking',
              '--enable-features=NetworkService,NetworkServiceInProcess',
              '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
            ],
          });
          const page = await browser.newPage();
          await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
          await page.setRequestInterception(true);
          page.on('request', r => {
            const t = r.resourceType();
            if (['image', 'media', 'font', 'stylesheet'].includes(t)) r.abort();
            else r.continue();
          });

          await page.goto(url, { waitUntil: 'networkidle0', timeout: 600000 });
          const html = await page.content();
          await browser.close();

          const heavyParsed = await parseWithPostlight(url, html);
          if (heavyParsed?.content && wordCountFromHtml(heavyParsed.content) > wordCountFromHtml(result?.content || '')) {
            console.log('Puppeteer fallback chosen (better content).');
            result = heavyParsed;
          }
        } catch (e) {
          console.log('Puppeteer fallback failed:', e.message);
        }
      }
    }

    // --- Восстановление вступления (intro) перед конвертацией HTML→text ---
    if (ENABLE_INTRO_RECOVERY) {
      try {
        const introHTML = extractIntroHTML(fetched.body, url);
        if (introHTML) {
          const haveIntroAlready =
            result?.content &&
            result.content.replace(/\s+/g, ' ').includes(introHTML.replace(/\s+/g, ' ').slice(0, 80));
          if (!haveIntroAlready) {
            console.log('Intro recovered and prepended to article.');
            result.content = introHTML + '\n' + (result.content || '');
          } else {
            console.log('Intro already present — no prepend.');
          }
        } else {
          console.log('No intro detected.');
        }
      } catch (e) {
        console.log('Intro recovery failed:', e.message);
      }
    }

    // Автор (если вернул парсер)
    const authorFromParser = result?.author || 'N/A';
    const author = authorFromParser;

    if (!result?.content) {
      return res.status(200).json({
        message: 'No main content extracted, but other data available.',
        fullResult: result,
        possibleIssues: 'Non-standard layout or protection. Try enabling AMP/Readability/Puppeteer fallbacks.',
      });
    }

    // Санитайз HTML → text (НЕ удаляем карточки со званиями/ценами)
    const cleanHtml = result.content
      .replace(/[\u0019\u2018\u2019]/g, "'")
      .replace(/[\u0014-\u001F\u007F-\u009F]/g, '')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/&#xA0;/g, ' ')
      .replace(/&[#A-Za-z0-9]+;/g, (match) => {
        const entities = {
          '&amp;': '&',
          '&quot;': '"',
          '&apos;': "'",
          '&nbsp;': ' ',
          '&lt;': '<',
          '&gt;': '>',
        };
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
        // ВАЖНО: карточки/гриды не скрываем — там заголовки/бейджи/цены
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

        // ВАЖНО: сохраняем цену и бейджи (Best Overall и т.п.)
        const hasPrice = /\$\s*\d{1,4}(?:[\.,]\d{2})?/.test(line);
        const hasBadge = /\b(Best|Top|Editor'?s Choice|Overall|Budget|Value)\b/i.test(line);
        if (hasPrice || hasBadge) return true;

        // Удаляем только явные CTA/хвосты БЕЗ цены
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
