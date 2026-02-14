require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs-extra');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const Indexer = require('./indexer');

const Parser = require('rss-parser');
const { CronJob } = require('cron');

const app = express();
const PORT = process.env.PORT || 3000;
const indexer = new Indexer();
const parser = new Parser();

// Load environment variables (including .env.local)
require('dotenv').config({ path: ['.env.local', '.env'] });

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// --- RSS AUTO-PILOT ---
const FEEDS_FILE = path.join(__dirname, '../data/feeds.json');
let monitoredFeeds = [];

// Load feeds on startup
if (fs.existsSync(FEEDS_FILE)) {
    try {
        monitoredFeeds = fs.readJsonSync(FEEDS_FILE);
    } catch (e) {
        monitoredFeeds = [];
    }
}

// Save feeds
function saveFeeds() {
    fs.ensureDirSync(path.dirname(FEEDS_FILE));
    fs.writeJsonSync(FEEDS_FILE, monitoredFeeds);
}

// Function to check feed
async function checkFeed(feedUrl) {
    try {
        // Handle Medium feed redirect (append ?source=rss if missing)
        // Or simply try to fetch it.
        console.log(`Fetching RSS: ${feedUrl}`);
        const feed = await parser.parseURL(feedUrl);
        console.log(`Checking Feed: ${feed.title}`);
        
        const today = new Date();
        const recentItems = feed.items.filter(item => {
            const itemDate = new Date(item.pubDate);
            // Check if published in last 24 hours
            return (today - itemDate) < (24 * 60 * 60 * 1000);
        });

        if (recentItems.length > 0) {
            console.log(`Found ${recentItems.length} new articles! Boosting...`);
            // Pass full item details to generateBridgePage
            const articles = recentItems.map(item => ({
                url: item.link,
                title: item.title,
                snippet: item.contentSnippet || item.content || ''
            }));
            await indexer.generateBridgePage(articles);
        } else {
            console.log('No new articles found in last 24h.');
        }
    } catch (e) {
        console.error('RSS Error:', e.message);
        // If 404, maybe the user provided a profile URL instead of feed URL
        if (feedUrl.includes('medium.com') && !feedUrl.includes('/feed/')) {
             console.log('Trying to fix Medium Feed URL...');
             // Attempt to construct correct feed URL: https://medium.com/feed/@username
             // This is just a hint for the user
        }
    }
}

// Run every 1 hour
const job = new CronJob('0 * * * *', async () => {
    for (const url of monitoredFeeds) {
        await checkFeed(url);
    }
});
job.start();

app.use(cors());
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

// --- AUTH MIDDLEWARE ---
function authenticateToken(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Access denied' });
    
    try {
        const verified = jwt.verify(token, JWT_SECRET);
        req.user = verified;
        next();
    } catch (err) {
        res.status(400).json({ error: 'Invalid token' });
    }
}

// --- AUTH ROUTES ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
        res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.json({ success: true, message: 'Login successful' });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ success: true, message: 'Logged out successfully' });
});

// --- PROTECTED ROUTES ---
// API routes now require authentication
app.use('/api', authenticateToken);

// --- GOOGLEBOT DETECTOR ---
let botVisits = [];

app.use((req, res, next) => {
    const ua = req.get('User-Agent') || '';
    if (ua.toLowerCase().includes('googlebot')) {
        const visit = {
            time: new Date().toISOString(),
            ip: req.ip,
            ua: ua,
            path: req.path
        };
        console.log('🚨 GOOGLEBOT VISITED!', visit);
        botVisits.unshift(visit);
        // Keep last 50 visits
        if (botVisits.length > 50) botVisits.pop();
    }
    next();
});

// API: Get Bot Visits
app.get('/api/visits', (req, res) => {
    res.json({ visits: botVisits });
});

// API: Add Feed
app.post('/api/feed', (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    if (!monitoredFeeds.includes(url)) {
        monitoredFeeds.push(url);
        saveFeeds();
        checkFeed(url); // Check immediately
    }
    res.json({ success: true, feeds: monitoredFeeds });
});

// API: Get Feeds
app.get('/api/feeds', (req, res) => {
    res.json({ feeds: monitoredFeeds });
});

// API: Submit a single URL (Standard)
app.post('/api/submit', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    
    try {
        const result = await indexer.submitUrl(url);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: Submit Medium Links (Bridge Page Strategy)
app.post('/api/medium-boost', async (req, res) => {
    const { urls } = req.body; // Array of Medium URLs or Objects
    if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: 'URLs array required' });
    
    try {
        // Convert plain URLs to objects if needed
        const articles = urls.map(u => typeof u === 'string' ? { url: u, title: '', snippet: '' } : u);

        // Generate the bridge page and submit IT instead
        const result = await indexer.generateBridgePage(articles);
        res.json({
            success: true,
            bridgeUrl: result.url, // The generated bridge page URL
            message: `Created bridge page with ${articles.length} Medium links and submitted to search engines.`
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: Get History
app.get('/api/history', (req, res) => {
    res.json(indexer.history);
});

// --- MAIN ROUTES ---
// Serve login page for root
app.get('/', (req, res) => {
    const token = req.cookies.token;
    if (token) {
        try {
            jwt.verify(token, JWT_SECRET);
            res.sendFile(path.join(__dirname, '../public/index.html'));
        } catch (err) {
            res.clearCookie('token');
            res.sendFile(path.join(__dirname, '../public/login.html'));
        }
    } else {
        res.sendFile(path.join(__dirname, '../public/login.html'));
    }
});

// Serve dashboard if authenticated
app.get('/dashboard', (req, res) => {
    const token = req.cookies.token;
    if (token) {
        try {
            jwt.verify(token, JWT_SECRET);
            res.sendFile(path.join(__dirname, '../public/index.html'));
        } catch (err) {
            res.redirect('/');
        }
    } else {
        res.redirect('/');
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`🕷️ Bot Visits: http://localhost:${PORT}/api/visits`);
    console.log(`🤖 Auto-Pilot: Monitoring ${monitoredFeeds.length} feeds`);
});