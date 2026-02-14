#!/usr/bin/env node
require('dotenv').config();
const Indexer = require('./indexer');
const indexer = new Indexer();

const args = process.argv.slice(2);
const command = args[0];
const url = args[1];

if (command === 'submit') {
    if (!url) {
        console.error('Usage: node src/cli.js submit <url>');
        process.exit(1);
    }
    console.log(`Submitting ${url}...`);
    indexer.submitUrl(url).then(res => {
        console.log('Result:', JSON.stringify(res, null, 2));
    });
} else if (command === 'boost') {
    // Boost Medium URLs
    const urls = args.slice(1);
    if (urls.length === 0) {
        console.error('Usage: node src/cli.js boost <url1> <url2> ...');
        process.exit(1);
    }
    console.log(`Generating Bridge Page for ${urls.length} URLs...`);
    indexer.generateBridgePage(urls).then(res => {
        console.log('Bridge Page Created & Submitted!');
        console.log('Result:', JSON.stringify(res, null, 2));
    });
} else {
    console.log('Commands:');
    console.log('  submit <url>        Submit a single URL');
    console.log('  boost <url>...      Generate bridge page for Medium URLs');
}
