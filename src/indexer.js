const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { google } = require('googleapis');
const xmlbuilder = require('xmlbuilder');
const EventEmitter = require('events');

class Indexer extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = {
            siteUrl: process.env.SITE_URL || 'http://localhost:3000',
            googleKeyFile: process.env.GOOGLE_KEY_FILE || 'service_account.json',
            bingApiKey: process.env.BING_API_KEY,
            ...config
        };
        
        this.historyFile = path.join(__dirname, '../data/history.json');
        this.history = [];
        this.loadHistory();
        
        // Google Auth
        this.auth = null;
        
        // Priority 1: Key Rotation (Env Vars: GOOGLE_KEY_JSON, GOOGLE_KEY_JSON_2, etc.)
        this.googleKeys = [];
        
        // Check primary key
        if (process.env.GOOGLE_KEY_JSON) this.googleKeys.push(process.env.GOOGLE_KEY_JSON);
        
        // Check extra keys (up to 5)
        for (let i = 2; i <= 5; i++) {
            if (process.env[`GOOGLE_KEY_JSON_${i}`]) {
                this.googleKeys.push(process.env[`GOOGLE_KEY_JSON_${i}`]);
            }
        }

        if (this.googleKeys.length > 0) {
            console.log(`✅ Loaded ${this.googleKeys.length} Google Service Accounts for Rotation`);
        } else if (fs.existsSync(this.config.googleKeyFile)) {
            // Fallback to local file
            console.log('✅ Google Key File Found:', this.config.googleKeyFile);
            try {
                const fileContent = fs.readFileSync(this.config.googleKeyFile, 'utf8');
                this.googleKeys.push(fileContent);
            } catch(e) { console.error('Error reading key file'); }
        } else {
            console.log('❌ Google Key File NOT Found');
        }
    }

    // Helper to get a random auth client
    async getGoogleClient() {
        if (this.googleKeys.length === 0) return null;
        
        // Pick a random key
        const randomKeyStr = this.googleKeys[Math.floor(Math.random() * this.googleKeys.length)];
        
        try {
            const credentials = JSON.parse(randomKeyStr);
            const auth = new google.auth.GoogleAuth({
                credentials,
                scopes: ['https://www.googleapis.com/auth/indexing'],
            });
            return await auth.getClient();
        } catch (e) {
            console.error('Auth Error with rotated key:', e.message);
            return null;
        }
    }

    loadHistory() {
        if (fs.existsSync(this.historyFile)) {
            try {
                this.history = fs.readJsonSync(this.historyFile);
            } catch (e) {
                this.history = [];
            }
        }
    }

    saveHistory() {
        fs.ensureDirSync(path.dirname(this.historyFile));
        fs.writeJsonSync(this.historyFile, this.history.slice(0, 5000)); // Keep last 5000
    }

    async submitUrl(url) {
        const result = {
            url,
            timestamp: new Date().toISOString(),
            services: {}
        };

        // 1. Google Indexing API (Rotated)
        const googleClient = await this.getGoogleClient();
        if (googleClient) {
            try {
                const res = await googleClient.request({
                    url: 'https://indexing.googleapis.com/v3/urlNotifications:publish',
                    method: 'POST',
                    data: { url, type: 'URL_UPDATED' }
                });
                result.services.google = { status: res.status, data: res.data };
            } catch (e) {
                result.services.google = { status: 'error', error: e.message };
            }
        } else {
            result.services.google = { status: 'skipped', reason: 'No valid key found' };
        }

        // 2. IndexNow (Bing, Yandex, Naver, Seznam)
        try {
            const key = process.env.INDEXNOW_KEY || 'indexnow-key';
            const keyLocation = `${this.config.siteUrl}/${key}.txt`;
            const host = new URL(url).hostname;
            
            // Bing & IndexNow Network
            await axios.post('https://api.indexnow.org/indexnow', {
                host,
                key,
                keyLocation,
                urlList: [url]
            });
            result.services.indexnow = { status: 200 };
        } catch (e) {
            result.services.indexnow = { status: 'error', error: e.message };
        }

        // 3. MASSIVE RPC PING LIST (Aggressive Mode)
        // This notifies dozens of update services that your site has changed
        const pingServices = [
            'http://rpc.pingomatic.com',
            'http://blogsearch.google.com/ping/RPC2',
            'http://rpc.twingly.com',
            'http://api.feedster.com/ping',
            'http://api.moreover.com/RPC2',
            'http://api.my.yahoo.com/RPC2',
            'http://api.my.yahoo.com/rss/ping',
            'http://www.blogdigger.com/RPC2',
            'http://www.blogshares.com/rpc.php',
            'http://www.blogsnow.com/ping',
            'http://www.blogstreet.com/xrbin/xmlrpc.cgi',
            'http://bulkfeeds.net/rpc',
            'http://www.newsisfree.com/xmlrpctest.php',
            'http://ping.blo.gs/',
            'http://ping.feedburner.com',
            'http://ping.syndic8.com/xmlrpc.php',
            'http://ping.weblogalot.com/rpc.php',
            'http://rpc.blogrolling.com/pinger/',
            'http://rpc.technorati.com/rpc/ping',
            'http://rpc.weblogs.com/RPC2',
            'http://www.feedsubmitter.com',
            'http://blo.gs/ping.php',
            'http://www.pingerati.net',
            'http://www.pingmyblog.com',
            'http://geourl.org/ping',
            'http://ipings.com',
            'http://www.weblogalot.com/ping'
        ];

        let pingCount = 0;
        // Fire and forget pings to avoid blocking
        pingServices.forEach(service => {
            axios.get(service).catch(() => {}); // Ignore errors, just spam
            pingCount++;
        });
        
        result.services.ping = { status: 'aggressive_broadcast', count: pingCount };

        this.history.unshift(result);
        this.saveHistory();
        this.emit('submit:complete', result);
        return result;
    }

    // --- MEDIUM BOOSTER & YOUTUBE STRATEGY ---
    // Generates a local HTML page linking to the Medium articles and YouTube videos
    // Submits THIS local page to Google/Bing (since user owns this domain)
    async generateBridgePage(items) {
        const bridgePath = path.join(__dirname, '../public/medium-bridge.html');
        const sitemapPath = path.join(__dirname, '../public/sitemap.xml');
        
        // Normalize items: Convert string URLs to objects if needed
        const normalizedItems = items.map(item => {
            if (typeof item === 'string') return { url: item, title: '', snippet: '' };
            return item;
        });

        const mediumItems = normalizedItems.filter(i => i.url.includes('medium.com'));
        const youtubeItems = normalizedItems.filter(i => i.url.includes('youtube.com') || i.url.includes('youtu.be'));
        
        let html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="google-site-verification" content="BdcvLEb3SyOkHS6rbBdgd3-ysy0LsbLqWt7-WcDzFjg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Industry Insights & Tech News - ${new Date().toLocaleDateString()}</title>
    <meta name="description" content="Latest updates on AI Agents, Oil & Gas Technology, and Engineering breakthroughs. curated list of top articles.">
    <style>
        :root { --primary: #0f172a; --accent: #2563eb; --bg: #f8fafc; --card: #ffffff; }
        body { font-family: 'Inter', system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; line-height: 1.7; background: var(--bg); color: #334155; }
        h1 { color: var(--primary); font-size: 2.5rem; letter-spacing: -0.025em; margin-bottom: 0.5rem; }
        p.subtitle { color: #64748b; font-size: 1.1rem; margin-bottom: 3rem; }
        .article-card { background: var(--card); border: 1px solid #e2e8f0; padding: 2rem; margin-bottom: 1.5rem; border-radius: 12px; transition: all 0.2s; }
        .article-card:hover { transform: translateY(-3px); box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1); border-color: var(--accent); }
        h2 { margin: 0 0 0.75rem 0; font-size: 1.4rem; }
        a.title-link { text-decoration: none; color: var(--primary); font-weight: 700; }
        a.title-link:hover { color: var(--accent); }
        .snippet { color: #475569; font-size: 1rem; margin-bottom: 1rem; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .meta { font-size: 0.875rem; color: #94a3b8; font-weight: 500; display: flex; align-items: center; gap: 0.5rem; }
        .tag { display: inline-block; padding: 4px 10px; border-radius: 99px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
        .tag-medium { background: #dcfce7; color: #166534; }
        .tag-yt { background: #fee2e2; color: #991b1b; }
        .read-more { color: var(--accent); text-decoration: none; font-weight: 600; font-size: 0.9rem; }
        .read-more:hover { text-decoration: underline; }
        footer { margin-top: 4rem; text-align: center; color: #cbd5e1; font-size: 0.875rem; border-top: 1px solid #e2e8f0; padding-top: 2rem; }
    </style>
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "NewsMediaOrganization",
      "name": "Tech Industry Insights",
      "url": "${this.config.siteUrl}",
      "logo": "https://cdn-images-1.medium.com/max/1200/1*jfdwtvU6V6g99q3G7gq7dQ.png"
    }
    </script>
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      "itemListElement": [
        ${normalizedItems.map((item, i) => `
        {
          "@type": "ListItem",
          "position": ${i + 1},
          "url": "${item.url}",
          "name": "${item.title || 'Featured Article'}"
        }`).join(',')}
      ]
    }
    </script>
</head>
<body>
    <header>
        <h1>Industry Insights</h1>
        <p class="subtitle">Curated daily updates on Technology, AI, and Engineering.</p>
    </header>

    <div class="articles">
`;

        // Process Medium URLs
        mediumItems.forEach(item => {
            const slug = item.title || item.url.split('/').pop().replace(/-/g, ' ');
            const snippet = item.snippet || 'Read this in-depth article on Medium to learn more about the latest developments in the industry.';
            
            html += `
        <article class="article-card">
            <div style="margin-bottom: 0.75rem;"><span class="tag tag-medium">News</span></div>
            <h2><a href="${item.url}" target="_blank" rel="dofollow" class="title-link">${slug}</a></h2>
            <div class="snippet">${snippet}</div>
            <div class="meta">
                <span>By Medium</span> • <span>${new Date().toLocaleDateString()}</span>
                <span style="flex-grow: 1;"></span>
                <a href="${item.url}" target="_blank" class="read-more">Read Full Story →</a>
            </div>
        </article>`;
        });

        // Process YouTube URLs
        youtubeItems.forEach(item => {
            let videoId = '';
            try {
                if (item.url.includes('youtu.be')) videoId = item.url.split('/').pop();
                else videoId = new URL(item.url).searchParams.get('v');
            } catch (e) {}
            
            if (videoId) {
                const thumb = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
                html += `
        <article class="article-card">
            <div style="margin-bottom: 0.75rem;"><span class="tag tag-yt">Video</span></div>
            <h2><a href="${item.url}" target="_blank" rel="dofollow" class="title-link">${item.title || 'Watch Video'}</a></h2>
            <img src="${thumb}" alt="Video Thumbnail" style="width: 100%; max-width: 320px; border-radius: 8px; margin: 1rem 0;">
            <div class="meta">
                <span>YouTube</span>
                <span style="flex-grow: 1;"></span>
                <a href="${item.url}" target="_blank" class="read-more">Watch Now →</a>
            </div>
        </article>`;
            }
        });

        html += `
    </div>
    
    <footer>
        <p>© ${new Date().getFullYear()} Industry Insights Aggregator. All rights reserved.</p>
        <p>This page curates high-quality content from trusted sources for educational purposes.</p>
    </footer>
</body>
</html>`;

        await fs.outputFile(bridgePath, html);
        
        // Generate Sitemap
        const bridgeUrl = `${this.config.siteUrl}/medium-bridge.html`;
        const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
   <url>
      <loc>${bridgeUrl}</loc>
      <lastmod>${new Date().toISOString()}</lastmod>
      <changefreq>daily</changefreq>
      <priority>1.0</priority>
   </url>
</urlset>`;
        await fs.outputFile(sitemapPath, sitemap);

        // Auto-submit the bridge page!
        return await this.submitUrl(bridgeUrl);
    }
}

module.exports = Indexer;
