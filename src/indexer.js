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
        
        // Priority 1: Env Var (Best for Render/Cloud)
        if (process.env.GOOGLE_KEY_JSON) {
            console.log('✅ Google Key found in Environment Variable');
            try {
                const credentials = JSON.parse(process.env.GOOGLE_KEY_JSON);
                this.auth = new google.auth.GoogleAuth({
                    credentials,
                    scopes: ['https://www.googleapis.com/auth/indexing'],
                });
            } catch (e) {
                console.error('❌ Failed to parse GOOGLE_KEY_JSON:', e.message);
            }
        } 
        // Priority 2: File (Best for Local)
        else if (fs.existsSync(this.config.googleKeyFile)) {
            console.log('✅ Google Key File Found:', this.config.googleKeyFile);
            this.auth = new google.auth.GoogleAuth({
                keyFile: this.config.googleKeyFile,
                scopes: ['https://www.googleapis.com/auth/indexing'],
            });
        } else {
            console.log('❌ Google Key File NOT Found:', this.config.googleKeyFile);
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

        // 1. Google Indexing API
        if (this.auth) {
            try {
                const client = await this.auth.getClient();
                const res = await client.request({
                    url: 'https://indexing.googleapis.com/v3/urlNotifications:publish',
                    method: 'POST',
                    data: { url, type: 'URL_UPDATED' }
                });
                result.services.google = { status: res.status, data: res.data };
            } catch (e) {
                result.services.google = { status: 'error', error: e.message };
            }
        } else {
            result.services.google = { status: 'skipped', reason: 'No key file' };
        }

        // 2. IndexNow (Bing, Yandex, Naver, Seznam)
        // Note: Requires key file on the domain root. If url is medium.com, this fails validation by search engines.
        // BUT we submit anyway in case it's a bridge page.
        try {
            const key = process.env.INDEXNOW_KEY || 'indexnow-key';
            const keyLocation = `${this.config.siteUrl}/${key}.txt`;
            const host = new URL(url).hostname;
            
            // Bing
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

        // 3. Ping Services (RPC) - Works for ANY URL (Medium included)
        try {
            const pingServices = [
                'http://rpc.pingomatic.com',
                'http://blogsearch.google.com/ping/RPC2'
            ];
            // Simple GET ping for demo (actual RPC requires XML)
             result.services.ping = { status: 'simulated', count: pingServices.length };
        } catch (e) {
             result.services.ping = { status: 'error', error: e.message };
        }

        this.history.unshift(result);
        this.saveHistory();
        this.emit('submit:complete', result);
        return result;
    }

    // --- MEDIUM BOOSTER & YOUTUBE STRATEGY ---
    // Generates a local HTML page linking to the Medium articles and YouTube videos
    // Submits THIS local page to Google/Bing (since user owns this domain)
    async generateBridgePage(urls) {
        const bridgePath = path.join(__dirname, '../public/medium-bridge.html');
        const sitemapPath = path.join(__dirname, '../public/sitemap.xml');
        
        const mediumUrls = urls.filter(u => u.includes('medium.com'));
        const youtubeUrls = urls.filter(u => u.includes('youtube.com') || u.includes('youtu.be'));
        
        let html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="google-site-verification" content="BdcvLEb3SyOkHS6rbBdgd3-ysy0LsbLqWt7-WcDzFjg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Featured Content - ${new Date().toLocaleDateString()}</title>
    <meta name="description" content="A curated list of top Medium articles and YouTube videos.">
    <style>
        body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; line-height: 1.6; background: #f9f9f9; }
        .article-card { background: white; border: 1px solid #ddd; padding: 1.5rem; margin-bottom: 1rem; border-radius: 8px; transition: transform 0.2s; }
        .article-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        a { text-decoration: none; color: #1a8917; font-weight: bold; font-size: 1.2rem; display: block; margin-bottom: 0.5rem; }
        .yt-link { color: #ff0000; }
        .meta { color: #666; font-size: 0.9rem; }
        .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.8rem; font-weight: bold; margin-right: 8px; }
        .tag-medium { background: #e6f7e9; color: #1a8917; }
        .tag-yt { background: #ffe6e6; color: #ff0000; }
    </style>
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      "itemListElement": [
        ${urls.map((url, i) => `
        {
          "@type": "ListItem",
          "position": ${i + 1},
          "url": "${url}"
        }`).join(',')}
      ]
    }
    </script>
</head>
<body>
    <h1>Recommended Content</h1>
    <p>Updated: ${new Date().toISOString()}</p>
    <div class="articles">
`;

        // Process Medium URLs
        mediumUrls.forEach(url => {
            const slug = url.split('/').pop().replace(/-/g, ' ');
            html += `
        <article class="article-card">
            <span class="tag tag-medium">Article</span>
            <a href="${url}" target="_blank" rel="dofollow">${slug || 'Read Article'}</a>
            <div class="meta">Read on Medium</div>
        </article>`;
        });

        // Process YouTube URLs
        youtubeUrls.forEach(url => {
            let videoId = '';
            try {
                if (url.includes('youtu.be')) videoId = url.split('/').pop();
                else videoId = new URL(url).searchParams.get('v');
            } catch (e) {}
            
            if (videoId) {
                const thumb = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
                html += `
        <article class="article-card">
            <span class="tag tag-yt">Video</span>
            <a href="${url}" target="_blank" rel="dofollow" class="yt-link">Watch Video</a>
            <img src="${thumb}" alt="Video Thumbnail" style="width: 100%; max-width: 320px; border-radius: 4px; margin-top: 10px;">
            <div class="meta">Watch on YouTube</div>
        </article>`;
            }
        });

        html += `
    </div>
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
