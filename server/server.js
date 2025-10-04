// server/server.js
/**
 * KTU Result Proxy
 * - polite retries with exponential backoff
 * - concurrency limit + queue
 * - in-memory cache (NodeCache) with configurable TTL
 * - optional Playwright fallback (heavy) if direct HTTP fails repeatedly
 *
 * Environment:
 *  PORT=3000
 *  MAX_CONCURRENT=4
 *  REQUEST_TIMEOUT=8000
 *  MAX_RETRIES=5
 *  CACHE_TTL=300
 *  PLAYWRIGHT_FALLBACK=false
 *
 * Install:
 *   npm i express axios p-limit node-cache dotenv
 *   # optional for Playwright:
 *   npm i playwright
 *
 * Run:
 *   node server.js
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const pLimit = require('p-limit');
const NodeCache = require('node-cache');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '4', 10);
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '8000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '5', 10);
const BACKOFF_BASE = parseInt(process.env.BACKOFF_BASE || '300', 10); // ms
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '300', 10); // seconds
const PLAYWRIGHT_FALLBACK = (process.env.PLAYWRIGHT_FALLBACK === 'true');

const cache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: 60 });
const limit = pLimit(MAX_CONCURRENT);

// TODO: set this template to the real KTU results URL (GET or POST as required)
const KTU_FETCH_URL_TEMPLATE = roll => `https://ktu.edu.in/results?roll=${encodeURIComponent(roll)}`;

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function fetchWithRetries(url, opts = {}, maxRetries = MAX_RETRIES) {
  let attempt = 0;
  while (true) {
    try {
      const res = await axios.get(url, {
        timeout: REQUEST_TIMEOUT,
        headers: {
          'User-Agent': 'KTU-Proxy/1.0 (+contact@yourdomain.com)'
        },
        ...opts
      });
      return res;
    } catch (err) {
      attempt++;
      const status = err.response && err.response.status;
      const isGateway = !err.response || [502, 503, 504].includes(status);
      if (!isGateway || attempt > maxRetries) {
        // final fail
        throw err;
      }
      // exponential backoff w/ jitter
      const backoff = Math.round(BACKOFF_BASE * Math.pow(2, attempt - 1));
      const jitter = Math.round(Math.random() * 200);
      const wait = backoff + jitter;
      console.warn(`Gateway-ish error (attempt ${attempt}). Waiting ${wait}ms before retrying...`);
      await sleep(wait);
    }
  }
}

// Optional Playwright fallback (only enable if needed)
async function playwrightFetch(url) {
  // lazy-load playwright to avoid install unless used
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ timeout: REQUEST_TIMEOUT });
    await page.goto(url, { waitUntil: 'networkidle' });
    const html = await page.content();
    return { data: html, headers: { 'x-playwright-fallback': '1' } };
  } finally {
    await browser.close();
  }
}

// Main fetch function: uses concurrency limiter
async function fetchResultForRoll(roll) {
  // check cache
  const cacheKey = `ktu:roll:${roll}`;
  const cached = cache.get(cacheKey);
  if (cached) return { ok: true, fromCache: true, data: cached };

  const url = KTU_FETCH_URL_TEMPLATE(roll);

  return limit(async () => {
    try {
      const resp = await fetchWithRetries(url);
      // Save raw HTML or parsed JSON depending on KTU endpoint
      cache.set(cacheKey, resp.data);
      return { ok: true, fromCache: false, data: resp.data, headers: resp.headers || {} };
    } catch (err) {
      console.warn(`Direct fetch failed for ${roll}: ${err.message || err}`);
      // fallback to Playwright optionally
      if (PLAYWRIGHT_FALLBACK) {
        try {
          const pwResp = await playwrightFetch(url);
          cache.set(cacheKey, pwResp.data);
          return { ok: true, fromCache: false, data: pwResp.data, headers: pwResp.headers || {} };
        } catch (pwErr) {
          console.error('Playwright fallback also failed:', pwErr.message || pwErr);
          return { ok: false, error: pwErr.message || String(pwErr) };
        }
      } else {
        return { ok: false, error: err.message || String(err) };
      }
    }
  });
}

// Simple API: GET /api/result?roll=XXXX
app.get('/api/result', async (req, res) => {
  const roll = (req.query.roll || '').trim();
  if (!roll) return res.status(400).json({ ok: false, error: 'roll query param required' });

  try {
    const result = await fetchResultForRoll(roll);
    if (!result.ok) return res.status(502).json({ ok: false, error: result.error || 'failed to fetch' });

    // return HTML or JSON depending on what you want; here we return the raw HTML
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (result.fromCache) res.setHeader('X-Cache', 'HIT');
    else res.setHeader('X-Cache', 'MISS');

    // Important: you may want to parse/extract the actual marks from the HTML here
    // using cheerio or regex and return structured JSON to the client.
    return res.status(200).send(result.data);
  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ ok: false, error: 'internal server error' });
  }
});

// health
app.get('/healthz', (req, res) => res.json({ ok: true }));

// start
app.listen(PORT, () => {
  console.log(`KTU proxy server listening on port ${PORT}`);
  console.log(`PLAYWRIGHT_FALLBACK=${PLAYWRIGHT_FALLBACK}`);
});
