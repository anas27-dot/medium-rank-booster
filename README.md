# Medium Rank Booster & Page Indexer

This tool helps you rank your Medium articles by creating a high-authority "Bridge Page" on your own domain (or localhost) and submitting IT to Google/Bing.

Since you don't own `medium.com`, you cannot submit individual article URLs directly to Google Indexing API. This tool solves that by creating an indexable hub page that links to your articles.

## Setup

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Configuration**:
    Create a `.env` file (optional):
    ```
    SITE_URL=http://your-domain.com
    GOOGLE_KEY_FILE=service_account.json
    BING_API_KEY=your-bing-api-key
    ```

3.  **Google Indexing API (Optional but Recommended)**:
    *   Go to Google Cloud Console.
    *   Create a Service Account.
    *   Download the JSON key file as `service_account.json`.
    *   Enable "Web Search Indexing API".
    *   Add the service account email as an Owner in Google Search Console for `your-domain.com`.

## Usage

1.  **Start the Server**:
    ```bash
    node src/server.js
    ```
    Open `http://localhost:3000`.

2.  **Boost Medium Articles**:
    *   Go to the "Medium Booster" tab.
    *   Paste your Medium article URLs.
    *   Click "Generate Bridge Page".
    *   The tool will create a local `medium-bridge.html` page and submit it to search engines.

## Strategy

1.  **Bridge Page**: We create a specialized HTML page with Schema.org `ItemList` markup.
2.  **Submission**: We submit *this* bridge page to Google/Bing.
3.  **Crawling**: Google crawls the bridge page, sees the links to your Medium articles, and indexes them faster.
