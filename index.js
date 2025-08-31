const express = require('express');
const Mercury = require('@postlight/mercury-parser');

const app = express();
const port = process.env.PORT || 3000; // Railway использует process.env.PORT

// Middleware для CORS (чтобы сервис был доступен из браузера)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Эндпоинт для парсинга статьи
app.get('/parse', async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const result = await Mercury.parse(url);
    if (!result.content) {
      return res.status(500).json({ error: 'Failed to parse content' });
    }
    res.json({ content: result.content }); // Возвращаем HTML-контент статьи
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Parsing error' });
  }
});

// Корневой эндпоинт для проверки
app.get('/', (req, res) => {
  res.send('Article Parser Service is running. Use /parse?url=your-article-url');
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
