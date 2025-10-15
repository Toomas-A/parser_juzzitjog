// rules/www.runnersworld.com.js
module.exports = {
  domain: 'www.runnersworld.com',
  selectors: {
    content: [
      'main article',
      'article[data-article-body]',
      'div[itemprop="articleBody"]',
      '.content article'
    ],
    title: [
      'h1.headline',
      'h1[data-hed]',
      'h1'
    ],
    author: [
      '[rel="author"]',
      '.byline a',
      '.byline'
    ],
    publishDate: [
      'time[datetime]',
      'meta[property="article:published_time"]'
    ],
    leadImageUrl: [
      'meta[property="og:image"]',
      'figure img'
    ]
  },
  clean: [
    'script', 'style', 'noscript', 'iframe',
    '.newsletter', '.share', '.social', '.related', '.promo',
    '.ad', '[data-ad]', '.advertisement', '.video-embed'
  ],
  whitelist: [
    'h2','h3','h4','p','ul','ol','li','figure','figcaption','table',
    '[class*="Pros"]','[class*="Cons"]','[class*="Key Specs"]',
    '[data-test-id*="listicle"]','[class*="listicle"]'
  ]
};
