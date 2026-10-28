const config = require('./security/config-loader');
const playwright = require('playwright');
const axios = require('axios');
const { filterJobs } = require('./relevance-filter');

// Configuration — all secrets loaded via Doppler/config-loader
const BROWSERBASE_API_KEY = config.get('BROWSERBASE_API_KEY');
const BROWSERBASE_PROJECT_ID = config.get('BROWSERBASE_PROJECT_ID');

// Helper function: random delay between 1000ms and 2500ms (optimized from 2000-4000ms)
async function humanDelay() {
  const delay = Math.random() * 1500 + 1000;
  await new Promise(resolve => setTimeout(resolve, delay));
}

// Create a Browserbase session and connect via CDP
async function createBrowserbaseSession() {
  try {
    const response = await axios.post(
      'https://api.browserbase.com/v1/sessions',
      { projectId: BROWSERBASE_PROJECT_ID },
      {
        headers: {
          'X-BB-API-Key': BROWSERBASE_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    const sessionId = response.data.id;
    const connectUrl = response.data.connectUrl;
    console.log('[Indeed] Browserbase session created, sessionId:', sessionId);

    const browser = await playwright.chromium.connectOverCDP(connectUrl);
    return { browser, sessionId };
  } catch (error) {
    console.error('[Indeed] Failed to create Browserbase session:', error.message);
    throw error;
  }
}

/**
 * Build Indeed search URL
 * @param {string} roleTitle - Job title to search
 * @param {string} location - Location string
 * @param {string} datePosted - Date filter: 1 = last 24h, 3 = last 3 days, 7 = last 7 days, 14 = last 14 days
 * @returns {string} Indeed search URL
 */
function buildSearchUrl(roleTitle, location, datePosted = '1') {
  const baseUrl = 'https://ca.indeed.com/jobs'; // .ca for Canadian market
  const params = new URLSearchParams({
    q: roleTitle,
    l: location,
    fromage: datePosted, // days since posted
    sort: 'date'
  });
  return `${baseUrl}?${params.toString()}`;
}

/**
 * Scrape Indeed job listings
 * @param {Object} config - Scraping configuration
 * @param {string} config.roleTitle - Job title to search
 * @param {string} config.location - Location to search in
 * @param {string} config.datePosted - Days since posted (default '1' = last 24 hours)
 * @param {number} config.maxResults - Max jobs to return (default 15)
 * @returns {Promise<Array>} Array of job objects in standardized format
 */
async function scrapeIndeedJobs(config) {
  const {
    roleTitle,
    location,
    datePosted = '1',
    maxResults = 15
  } = config;

  let browser, page;
  const jobs = [];

  try {
    console.log(`[Indeed] Starting job scrape for: ${roleTitle} in ${location}`);

    // Create Browserbase session
    const session = await createBrowserbaseSession();
    browser = session.browser;
    page = await browser.newPage();

    // Set a realistic user agent
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-CA,en;q=0.9'
    });

    const searchUrl = buildSearchUrl(roleTitle, location, datePosted);
    console.log(`[Indeed] Navigating to: ${searchUrl}`);

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay();

    // Wait for job cards to load — Indeed frequently changes selectors.
    // Strategy: try known selectors first, then fall back to broad detection.
    const KNOWN_SELECTORS = [
      '.job_seen_beacon',           // Classic Indeed layout
      '.jobsearch-ResultsList .result', // Older layout
      '.tapItem',                   // Mobile/responsive layout
      '.resultContent',             // 2024+ layout
      '.jobCard_mainContent',       // Alternate card layout
      '[data-jk]',                  // Job key attribute (stable across layouts)
      '.job-cardstyle1',            // 2025 layout variant
      '.css-1ac2l2k',              // CSS module class (changes but worth trying)
    ];
    const jobCardSelector = KNOWN_SELECTORS.join(', ');
    let usedSelector = jobCardSelector;

    try {
      await page.waitForSelector(jobCardSelector, { timeout: 15000 });
    } catch (e) {
      // Fallback: look for ANY links that contain /rc/clk or /viewjob (Indeed job links)
      console.warn('[Indeed] Primary selectors failed — trying fallback link detection...');
      try {
        await page.waitForSelector('a[href*="/rc/clk"], a[href*="/viewjob"], a[id^="job_"]', { timeout: 10000 });
        usedSelector = 'a[href*="/rc/clk"], a[href*="/viewjob"], a[id^="job_"]';
        console.log('[Indeed] Fallback selector matched — extracting from job links');
      } catch (e2) {
        // Check if it's a CAPTCHA page
        const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 300) || '').catch(() => '');
        if (pageText.toLowerCase().includes('captcha') || pageText.toLowerCase().includes('verify') || pageText.toLowerCase().includes('robot')) {
          console.warn('[Indeed] CAPTCHA detected — cannot scrape this session');
        } else {
          console.warn('[Indeed] Job cards did not load with any known selectors. Page may have changed layout.');
          console.warn(`[Indeed] Page text preview: ${pageText.substring(0, 150)}`);
        }
        await browser.close();
        return [];
      }
    }
    await humanDelay();

    // Extract job listings
    let jobCount = 0;
    let pageNum = 0;

    while (jobCount < maxResults) {
      // Get all job cards on current page
      const cards = await page.$$(jobCardSelector);
      console.log(`[Indeed] Found ${cards.length} job cards on page ${pageNum + 1}`);

      for (const card of cards) {
        if (jobCount >= maxResults) break;

        try {
          // Extract job title — try multiple selectors (Indeed changes these frequently)
          const jobTitle = await card.$eval(
            'h2.jobTitle a span, h2.jobTitle span, .jobTitle, [data-testid="jobTitle"], .jcs-JobTitle span, a[data-jk] span',
            el => el.textContent.trim()
          ).catch(() => null);

          if (!jobTitle) continue;

          // Extract company name
          const companyName = await card.$eval(
            '[data-testid="company-name"], .companyName, .company, [data-company-name], .css-63koeb',
            el => el.textContent.trim()
          ).catch(() => 'Unknown');

          // Extract location
          const jobLocation = await card.$eval(
            '[data-testid="text-location"], .companyLocation, .location, [data-testid="job-location"]',
            el => el.textContent.trim()
          ).catch(() => location);

          // Extract job URL
          const jobUrl = await card.$eval(
            'h2.jobTitle a, a.jcs-JobTitle, a[data-jk], a[href*="/rc/clk"], a[href*="/viewjob"]',
            el => el.href
          ).catch(() => '');

          // Extract date posted
          const datePostedText = await card.$eval(
            '.date, .myJobsState, [data-testid="myJobsStateDate"], .result-footer .date',
            el => el.textContent.trim()
          ).catch(() => 'N/A');

          // Extract salary if shown
          const salary = await card.$eval(
            '.salary-snippet-container, .salaryText, [data-testid="attribute_snippet_testid"], .css-18z4q2i',
            el => el.textContent.trim()
          ).catch(() => '');

          // Extract snippet/description
          const snippet = await card.$eval(
            '.job-snippet, .underShelfFooter, [data-testid="job-snippet"], .css-9446fg',
            el => el.textContent.trim().substring(0, 300)
          ).catch(() => '');

          // Extract work arrangement from metadata
          let workArrangement = 'Unknown';
          const metaText = await card.$eval(
            '.metadata, [data-testid="attribute_snippet_testid"]',
            el => el.textContent.toLowerCase()
          ).catch(() => '');

          if (metaText.includes('remote')) workArrangement = 'Remote';
          else if (metaText.includes('hybrid')) workArrangement = 'Hybrid';
          else if (metaText.includes('in-person') || metaText.includes('on-site')) workArrangement = 'On-site';

          jobs.push({
            jobTitle,
            companyName,
            companyLinkedInUrl: '', // Not available from Indeed
            location: jobLocation,
            workArrangement,
            datePosted: datePostedText,
            salary,
            jobDescriptionSummary: snippet,
            jobPostingUrl: jobUrl,
            source: 'indeed'
          });

          jobCount++;
          await humanDelay();

        } catch (error) {
          console.log(`[Indeed] Skipping card: ${error.message}`);
          continue;
        }
      }

      // Check if we need more results and there's a next page
      if (jobCount < maxResults) {
        const nextButton = await page.$('a[data-testid="pagination-page-next"], a[aria-label="Next Page"]');
        if (nextButton) {
          console.log(`[Indeed] Navigating to page ${pageNum + 2}...`);
          await nextButton.click();
          await page.waitForLoadState('domcontentloaded');
          await humanDelay();
          pageNum++;
        } else {
          console.log('[Indeed] No more pages available');
          break;
        }
      }
    }

    console.log(`[Indeed] Successfully scraped ${jobs.length} job listings`);
    await browser.close();

    // Filter for relevance before returning
    const { kept, filtered } = filterJobs(jobs, roleTitle);
    if (filtered.length > 0) {
      console.log(`[Indeed] Relevance filter removed ${filtered.length} off-target results`);
    }
    return kept;

  } catch (error) {
    console.error('[Indeed] Error in scrapeIndeedJobs:', error.message);
    if (browser) await browser.close();
    return [];
  }
}

module.exports = {
  scrapeIndeedJobs
};
