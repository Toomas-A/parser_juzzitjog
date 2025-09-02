const express = require('express');
const Mercury = require('@postlight/mercury-parser');
const { htmlToText } = require('html-to-text');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AnonymizeUAPlugin = require('puppeteer-extra-plugin-anonymize-ua');
const UserDataDirPlugin = require('puppeteer-extra-plugin-user-data-dir');
const UserPreferencesPlugin = require('puppeteer-extra-plugin-user-preferences');
const axios = require('axios');
const fs = require('fs');

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

const app = express();
const port = process.env.PORT || 3000;

// Middleware для CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Настройка логирования
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

// Функция для HTTP-запроса с ретраями и следованием редиректам
async function fetchWithRetry(url, options, retries = 7, delay = 20000) {
  let currentUrl = url;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios({
        method: options.method || 'get',
        url: currentUrl,
        headers: {
          ...options.headers,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'DNT': '1',
        },
        timeout: 500000,
        maxRedirects: 10,
        followRedirect: true,
      });
      console.log(`Fetch successful for ${currentUrl}`);
      return { response, body: response.data, finalUrl: response.request.res.responseUrl || currentUrl };
    } catch (error) {
      console.error(`Request attempt ${attempt} failed for ${currentUrl}: ${error.message}. Retries left: ${retries - attempt}`);
      if (attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Эндпоинт для парсинга статьи
app.get('/parse', async (req, res) => {
  let url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  let browser;
  try {
    // Попытка парсинга с Mercury
    let result;
    try {
      const fetchResult = await fetchWithRetry(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      });
      url = fetchResult.finalUrl; // Обновляем URL на финальный после редиректов
      console.log(`Mercury parsing with final URL: ${url}`);
      result = await Mercury.parse(url, {
        contentType: 'html',
        prune: false,
        html: fetchResult.body,
        customExtractor: {
          content: [
            '.post-content',
            '.single-post',
            '.entry',
            '.entry-content',
            '.article-body',
            '.single-content',
            '.single-post-content',
            '.post-body',
            '.wysiwyg-wrapper',
            '.content',
            'article',
            '.article',
            '[role="main"]',
            '.main-content',
            '.main-article',
            '.post',
            '.story-content',
            '.bitr-post-content',
            '.bitr-content',
          ].join(','),
          title: [
            '.entry-title',
            'h1',
            '.post-title',
            '.article-title',
            '.title',
            '.bitr-post-title',
            '.bitr-title',
          ].join(','),
          author: [
            '.contributor .profile-name h5',
            '.author-name',
            '.byline a',
            '.author',
            '.byline',
            '[rel="author"]',
            '.post-author',
            '.author-bio',
            '.author-info .name',
            '.bitr-author',
            '.bitr-author-name',
          ].join(','),
        },
      });
      console.log('Mercury result:', JSON.stringify(result, null, 2));
    } catch (mercuryError) {
      console.error(`Mercury parse failed: ${mercuryError.message}`);
    }

    let author = result?.author || 'N/A';
    let contentExtracted = result?.content && result.content.length > 200;

    // Если Mercury не справился, используем Puppeteer
    if (!contentExtracted) {
      console.log('Mercury failed to extract sufficient content, switching to Puppeteer...');
      browser = await puppeteer.launch({
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

      // Подмена свойств браузера
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        window.navigator.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'mimeTypes', { get: () => [{ type: 'application/pdf' }] });
      });

      // Устанавливаем viewport
      await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

      // Отслеживание редиректов
      let redirectChain = [url];
      page.on('response', (response) => {
        console.log('Response:', response.url(), response.status());
        if (response.status() === 301 || response.status() === 302) {
          const redirectUrl = response.headers()['location'];
          if (redirectUrl && !redirectChain.includes(redirectUrl)) {
            console.log(`Redirect detected to: ${redirectUrl}`);
            redirectChain.push(redirectUrl);
          }
        }
      });

      // Блокируем ненужные ресурсы
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const resourceType = request.resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
          request.abort();
        } else {
          console.log('Request:', request.url());
          request.continue();
        }
      });

      // Retry-логика для загрузки страницы
      let retries = 7;
      let loaded = false;
      while (retries > 0 && !loaded) {
        try {
          await page.goto(url, { waitUntil: 'networkidle0', timeout: 600000 });
          loaded = true;
        } catch (e) {
          console.log(`Navigation attempt failed: ${e.message}. Retries left: ${retries}`);
          retries--;
          if (retries === 0) throw e;
          await new Promise((resolve) => setTimeout(resolve, 20000));
        }
      }

      // Проверка конечного URL
      const finalUrl = await page.url();
      console.log(`Final URL after navigation: ${finalUrl}, Redirect chain: ${redirectChain.join(' -> ')}`);

      // Ожидание специфичного селектора или текста
      try {
        await page.waitForFunction(
          () =>
            document.querySelector('.bitr-content, .bitr-post-content, .post-content, article') ||
            document.body.innerText.includes('Puma Velocity Nitro 4'),
          { timeout: 60000 }
        );
        console.log('Main content or Puma Velocity Nitro 4 text found');
      } catch (e) {
        console.log('Main content selector or text not found:', e.message);
      }

      // Имитация поведения пользователя
      try {
        await page.mouse.move(100, 100, { steps: 10 });
        await page.mouse.click(100, 100);
        await page.mouse.move(500, 500, { steps: 10 });
        await page.mouse.click(500, 500);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        await new Promise((resolve) => setTimeout(resolve, 15000));
      } catch (e) {
        console.log('User simulation failed:', e.message);
      }

      // Обработка Cloudflare-чекбокса
      try {
        const checkbox = await page.$('input[type="checkbox"]');
        if (checkbox) {
          console.log('Cloudflare checkbox detected, clicking...');
          await checkbox.click();
          await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 });
        }
      } catch (e) {
        console.log('No checkbox or navigation failed:', e.message);
      }

      // Ждём завершения Cloudflare-проверки
      try {
        await page.waitForSelector('#challenge-success-text', { timeout: 15000 });
        console.log('Cloudflare verification detected, waiting for redirect...');
        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 });
      } catch (e) {
        console.log('No Cloudflare challenge or already passed:', e.message);
      }

      // Агрессивная прокрутка до конца страницы
      try {
        await page.evaluate(async () => {
          let lastHeight = 0;
          let currentHeight = document.body.scrollHeight;
          while (lastHeight !== currentHeight) {
            lastHeight = currentHeight;
            window.scrollBy(0, window.innerHeight);
            await new Promise((resolve) => setTimeout(resolve, 8000));
            currentHeight = document.body.scrollHeight;
          }
        });
        console.log('Full page scroll completed');
      } catch (e) {
        console.log('Scroll failed:', e.message);
      }

      // Дополнительная задержка
      await new Promise((resolve) => setTimeout(resolve, 50000));

      // Диагностика страницы
      const pageStatus = await page.evaluate(() => document.readyState);
      const bodySample = await page.evaluate(() => document.body.innerText.slice(0, 4000));
      console.log(`Page status: ${pageStatus}, Body sample: ${bodySample}`);

      // Извлечение автора
      try {
        author = await page.evaluate(() => {
          const selectors = [
            '.contributor .profile-name h5',
            '.author-name',
            '.byline a',
            '.author',
            '.byline',
            '[rel="author"]',
            '.post-author',
            '.author-bio',
            '.author-info .name',
            '.bitr-author',
            '.bitr-author-name',
          ].join(',');
          const element = document.querySelector(selectors);
          return element ? element.textContent.trim() : 'N/A';
        });
      } catch (e) {
        console.log('Failed to extract author:', e.message);
      }

      // Базовая очистка DOM
      await page.evaluate(() => {
        document.querySelectorAll(
          'script, style, iframe, .newsletter-overlay, .ad, .advertisement, .related-posts, .comments, .article-card, .news-text, .custom-card, .section.article-grid, .container.color-dark-gray'
        ).forEach((el) => el.remove());
      });

      const html = await page.content();
      await browser.close();
      browser = null;

      // Повторный парсинг с Mercury
      result = await Mercury.parse(url, {
        html,
        contentType: 'html',
        prune: false,
        fetch: (fetchUrl) =>
          fetchWithRetry(fetchUrl, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.5',
              'Accept-Encoding': 'gzip, deflate, br',
            },
          }),
        customExtractor: {
          content: [
            '.post-content',
            '.single-post',
            '.entry',
            '.entry-content',
            '.article-body',
            '.single-content',
            '.single-post-content',
            '.post-body',
            '.wysiwyg-wrapper',
            '.content',
            'article',
            '.article',
            '[role="main"]',
            '.main-content',
            '.main-article',
            '.post',
            '.story-content',
            '.bitr-post-content',
            '.bitr-content',
          ].join(','),
          title: [
            '.entry-title',
            'h1',
            '.post-title',
            '.article-title',
            '.title',
            '.bitr-post-title',
            '.bitr-title',
          ].join(','),
          author: [
            '.contributor .profile-name h5',
            '.author-name',
            '.byline a',
            '.author',
            '.byline',
            '[rel="author"]',
            '.post-author',
            '.author-bio',
            '.author-info .name',
            '.bitr-author',
            '.bitr-author-name',
          ].join(','),
        },
      });
      console.log('Mercury result after Puppeteer:', JSON.stringify(result, null, 2));
    }

    if (!result.content) {
      return res.status(200).json({
        message: 'No main content extracted, but other data available. Check logs for details.',
        fullResult: result,
        possibleIssues: 'Site may have non-standard structure, advanced bot protection, or redirect.',
      });
    }

    // Базовая очистка HTML
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

    // Конвертация HTML в plain text
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
        { selector: '.article-card', format: 'skip' },
        { selector: '.news-text', format: 'skip' },
        { selector: '.custom-card', format: 'skip' },
        { selector: '.section.article-grid', format: 'skip' },
        { selector: '.container.color-dark-gray', format: 'skip' },
      ],
    });

    // Минимальная фильтрация (остальное в Make.com)
    const finalContent = plainContent
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => {
        if (line.length === 0) return false;
        if (line.match(/^\d+\.\s*$/)) return false;
        if (line.match(/newsletter|subscribe|buy now|check price|available at|pick up.*for\s*\$\d+|compare prices|shop the shoe|read article|leave a reply|your email address|comments|authors|shoe size|fav\. distance|prs|previous post|next post|believe in the run is the spot|custom-card|podcast|section\.article-grid|notifications|anatomy of a shoe|container color-dark-gray/i)) return false;
        return true;
      })
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Логирование образца контента
    console.log(`Content sample: ${finalContent.slice(0, 500)}`);

    res.json({
      content: finalContent,
      title: result.title || 'N/A',
      author: author,
      fullResult: result,
    });
  } catch (error) {
    if (browser) await browser.close();
    console.error('Error:', error.message, error.stack);
    res.status(500).json({
      error: 'Parsing error',
      details: error.message,
      suggestion: 'Check site accessibility, network connection, increase timeout, or use VPN. Site may have advanced bot protection or redirect.',
    });
  }
});

// Корневой эндпоинт
app.get('/', (req, res) => {
  res.send('Article Parser Service is running. Use /parse?url=your-article-url');
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});