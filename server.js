const express = require('express');
const Mercury = require('@postlight/mercury-parser');
const app = express();
const port = process.env.PORT || 3000;

// Middleware for parsing URL-encoded bodies and JSON bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---

// Handles GET requests for the root path
app.get('/', (req, res) => {
    res.status(200).send('Parser service is running. Use /parse?url= to get started.');
});

// Handles GET requests to parse content from a URL query parameter
app.get('/parse', async (req, res) => {
    const articleUrl = req.query.url;

    if (!articleUrl) {
        return res.status(400).json({ error: 'Missing required "url" query parameter' });
    }

    try {
        const result = await Mercury.parse(articleUrl, { contentType: 'text' });
        
        if (result && result.content) {
            res.status(200).send(result.content);
        } else {
            res.status(404).json({ error: 'Could not extract text from the URL' });
        }
    } catch (error) {
        console.error('Parsing failed:', error);
        res.status(500).json({ error: 'Failed to parse the provided URL' });
    }
});

// ---

// Handles POST requests to parse content from a JSON body
app.post('/parse', async (req, res) => {
    const articleUrl = req.body.url;

    if (!articleUrl) {
        return res.status(400).json({ error: 'Missing required "url" in JSON body' });
    }

    try {
        const result = await Mercury.parse(articleUrl, { contentType: 'text' });
        
        if (result && result.content) {
            res.status(200).send(result.content);
        } else {
            res.status(404).json({ error: 'Could not extract text from the URL' });
        }
    } catch (error) {
        console.error('Parsing failed:', error);
        res.status(500).json({ error: 'Failed to parse the provided URL' });
    }
});

// ---

// Start the server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
