const express = require('express');
const Mercury = require('@postlight/mercury-parser');
const app = express();
const port = process.env.PORT || 3000;

// Middleware for parsing URL-encoded bodies (for form data)
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Add a simple handler for the root path
app.get('/', (req, res) => {
    res.status(200).send('Parser service is running. Use /parse?url= to get started.');
});

// API endpoint to handle article parsing
app.get('/parse', async (req, res) => {
    const articleUrl = req.query.url;

    if (!articleUrl) {
        return res.status(400).json({ error: 'Missing required "url" query parameter' });
    }

    try {
        const result = await Mercury.parse(articleUrl, { contentType: 'text' });
        
        if (result && result.content) {
            // Success: send the parsed text content
            res.status(200).send(result.content);
        } else {
            // Failure: content could not be extracted
            res.status(404).json({ error: 'Could not extract text from the URL' });
        }
    } catch (error) {
        // Handle network or parsing errors
        console.error('Parsing failed:', error);
        res.status(500).json({ error: 'Failed to parse the provided URL' });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
