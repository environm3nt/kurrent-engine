const config = require('./security/config-loader');
const playwright = require('playwright');
const axios = require('axios');
const { filterJobs } = require('./relevance-filter');

// Configuration — all secrets loaded via Doppler/config-loader
const BROWSERBASE_API_KEY = config.get('BROWSERBASE_API_KEY');
const BROWSERBASE_PROJECT_ID = config.get('BROWSERBASE_PROJECT_ID');
const LINKEDIN_EMAIL = config.get('LINKEDIN_EMAIL');
const LINKEDIN_PASSWORD = config.get('LINKEDIN_PASSWORD');

// Persistent context ID for LinkedIn sessions.
// Auto-managed: creates via Browserbase API on first run, stores in Supabase `settings` table,
// reuses on all future runs. No manual env var needed.
let LINKEDIN_CONTEXT_ID = null;

// Navigation timeout — LinkedIn is slow, give it room
const NAV_TIMEOUT = 60000; // 60 seconds
const MAX_NAV_RETRIES = 2;

// Track auth failures for alerting — exported so run-now.js can check
let _authFailureCount = 0;
let _authFailureDetails = [];
function getAuthFailures() {
  return { count: _authFailureCount, details: _authFailureDetails };
}
function resetAuthFailures() {
  _authFailureCount = 0;
  _authFailureDetails = [];
}

// Helper function: random delay between 1000ms and 2000ms (optimized from 2000-3500ms)
async function humanDelay(min = 1000, max = 2000) {
  const delay = Math.random() * (max - min) + min;
  await new Promise(resolve => setTimeout(resolve, delay));
}

// Navigate with retry logic
async function navigateWithRetry(page, url, options = {}, retries = MAX_NAV_RETRIES) {
  const navOptions = {
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT,
    ...options,
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.goto(url, navOptions);
      return;
    } catch (error) {
      console.warn(`Navigation attempt ${attempt}/${retries} failed: ${error.message}`);
      if (attempt === retries) throw error;
      // Brief pause before retry
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

// Load LinkedIn context ID from Supabase settings table
async function loadContextFromSupabase() {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) return null;

    const response = await axios.get(
      `${supabaseUrl}/rest/v1/settings?key=eq.browserbase_linkedin_context_id&select=value`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    const row = response.data?.[0];
    return row?.value || null;
  } catch (error) {
    console.warn(`[LinkedIn] Could not load context from Supabase: ${error.message}`);
    return null;
  }
}

// Save LinkedIn context ID to Supabase settings table
async function saveContextToSupabase(contextId) {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) return;

    await axios.post(
      `${supabaseUrl}/rest/v1/settings`,
      { key: 'browserbase_linkedin_context_id', value: contextId },
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates'
        }
      }
    );
    console.log(`[LinkedIn] Context ID saved to Supabase settings table`);
  } catch (error) {
    console.warn(`[LinkedIn] Could not save context to Supabase: ${error.message}`);
  }
}

// Force-reset the LinkedIn context. Called when auth failures indicate stale cookies.
// Deletes the old context reference from Supabase so the next call to ensureLinkedInContext()
// creates a fresh one. The fresh session will attempt automated login with stored credentials.
async function resetLinkedInContext() {
  console.log('[LinkedIn] Resetting stale context — will create fresh on next session');
  LINKEDIN_CONTEXT_ID = null;

  // Delete old context from Supabase so pipeline doesn't reload it
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supabaseUrl && supabaseKey) {
      await axios.delete(
        `${supabaseUrl}/rest/v1/settings?key=eq.browserbase_linkedin_context_id`,
        { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
      );
      console.log('[LinkedIn] Old context deleted from Supabase');
    }
  } catch (err) {
    console.warn(`[LinkedIn] Could not delete old context: ${err.message}`);
  }
}

// Create or retrieve a persistent Browserbase context for LinkedIn.
// Fully self-managing: checks Supabase first, creates via API if needed, saves back.
async function ensureLinkedInContext() {
  if (LINKEDIN_CONTEXT_ID) {
    console.log(`[LinkedIn] Using persistent context: ${LINKEDIN_CONTEXT_ID}`);
    return LINKEDIN_CONTEXT_ID;
  }

  // Check Supabase for a previously saved context ID
  const savedId = await loadContextFromSupabase();
  if (savedId) {
    LINKEDIN_CONTEXT_ID = savedId;
    console.log(`[LinkedIn] Loaded context from Supabase: ${LINKEDIN_CONTEXT_ID}`);
    return LINKEDIN_CONTEXT_ID;
  }

  // No context exists anywhere — create one via Browserbase API and save to Supabase
  try {
    console.log('[LinkedIn] No existing context found — creating new persistent context...');
    const response = await axios.post(
      'https://api.browserbase.com/v1/contexts',
      { projectId: BROWSERBASE_PROJECT_ID },
      {
        headers: {
          'X-BB-API-Key': BROWSERBASE_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    LINKEDIN_CONTEXT_ID = response.data.id;
    console.log(`[LinkedIn] Created new context: ${LINKEDIN_CONTEXT_ID}`);

    // Save to Supabase so future runs find it automatically
    await saveContextToSupabase(LINKEDIN_CONTEXT_ID);

    return LINKEDIN_CONTEXT_ID;
  } catch (error) {
    console.warn(`[LinkedIn] Failed to create context: ${error.message} — falling back to ephemeral sessions`);
    return null;
  }
}

// Create a Browserbase session with persistent context (cookies survive across runs)
async function createBrowserbaseSession() {
  try {
    const contextId = await ensureLinkedInContext();

    const sessionPayload = { projectId: BROWSERBASE_PROJECT_ID };
    // Attach persistent context if available — cookies from previous sessions carry forward
    if (contextId) {
      sessionPayload.browserSettings = { context: { id: contextId, persist: true } };
    }

    const response = await axios.post(
      'https://api.browserbase.com/v1/sessions',
      sessionPayload,
      {
        headers: {
          'X-BB-API-Key': BROWSERBASE_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    const sessionId = response.data.id;
    const connectUrl = response.data.connectUrl;
    console.log('Browserbase session created, sessionId:', sessionId);

    // Connect Playwright to the Browserbase browser via CDP
    const browser = await playwright.chromium.connectOverCDP(connectUrl);
    return { browser, sessionId };
  } catch (error) {
    console.error('Failed to create Browserbase session:', error.message);
    throw error;
  }
}

// Check if logged in and perform login if needed
async function ensureLoggedIn(page) {
  try {
    await navigateWithRetry(page, 'https://www.linkedin.com');
    await humanDelay();

    // Check for login wall by looking for login form
    const loginForm = await page.$('[data-test-id="login-email"]');

    if (loginForm) {
      console.log('LinkedIn login wall detected, logging in...');
      await navigateWithRetry(page, 'https://www.linkedin.com/login');
      await humanDelay();

      // Fill in email — type as a string with short random delays between keystrokes
      const emailInput = await page.$('[data-test-id="login-email"]');
      if (emailInput) {
        await emailInput.type(LINKEDIN_EMAIL, { delay: 80 + Math.random() * 60 });
      }

      await humanDelay(800, 1500);

      // Fill in password — type as a string with short random delays between keystrokes
      const passwordInput = await page.$('[data-test-id="login-password"]');
      if (passwordInput) {
        await passwordInput.type(LINKEDIN_PASSWORD, { delay: 80 + Math.random() * 60 });
      }

      await humanDelay(800, 1500);

      // Click sign in button
      const signInButton = await page.$('button[type="submit"]');
      if (signInButton) {
        await signInButton.click();
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await humanDelay();
        console.log('LinkedIn login successful');
      }
    } else {
      console.log('Already logged in to LinkedIn');
    }
  } catch (error) {
    console.error('Error in ensureLoggedIn:', error.message);
    throw error;
  }
}

// Scrape LinkedIn job listings
async function scrapeLinkedInJobs(config) {
  const {
    roleTitle,
    location,
    datePosted = 'r86400',
    workArrangement = [],
    maxResults = 25
  } = config;

  let browser, page;
  const jobs = [];

  try {
    console.log(`Starting LinkedIn job scrape for: ${roleTitle} in ${location}`);

    // Create Browserbase session
    const session = await createBrowserbaseSession();
    browser = session.browser;
    page = await browser.newPage();

    // Ensure logged in
    await ensureLoggedIn(page);
    await humanDelay();

    // Build search URL
    let searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(roleTitle)}&location=${encodeURIComponent(location)}&f_TPR=${datePosted}`;

    // Add work arrangement filters
    if (workArrangement.length > 0) {
      workArrangement.forEach(type => {
        searchUrl += `&f_WT=${encodeURIComponent(type)}`;
      });
    }

    // Navigate to jobs search
    console.log('Navigating to LinkedIn Jobs search...');
    await navigateWithRetry(page, searchUrl);
    await humanDelay();

    // Wait for job listings to load — try multiple selectors
    try {
      await Promise.race([
        page.waitForSelector('.base-card', { timeout: 20000 }),
        page.waitForSelector('.jobs-search-results__list-item', { timeout: 20000 }),
        page.waitForSelector('.job-card-container', { timeout: 20000 }),
      ]);
    } catch (waitErr) {
      const pageUrl = page.url();
      console.warn(`No job results found after 20s. URL: ${pageUrl}`);
      // Check for auth redirect — track for alerting
      if (pageUrl.includes('/login') || pageUrl.includes('/authwall')) {
        console.warn('LinkedIn redirected to login — session may have expired');
        _authFailureCount++;
        _authFailureDetails.push(`Jobs: "${roleTitle}" in "${location}" — redirected to login`);
      }
      await browser.close();
      return [];
    }
    await humanDelay();

    // Scroll and extract job listings
    let previousHeight = 0;
    let jobCount = 0;

    while (jobCount < maxResults) {
      // Get current job listings
      const listings = await page.$$('.base-card');

      for (let i = jobCount; i < Math.min(listings.length, maxResults); i++) {
        try {
          const listing = listings[i];

          // Extract job details
          const jobTitle = await listing.$eval('.base-search-card__title', el => el.textContent.trim());
          const companyName = await listing.$eval('.base-search-card__subtitle', el => el.textContent.trim());
          const companyLinkedInUrl = await listing.$eval('a.base-card__full-link', el => el.href);
          const location = await listing.$eval('.job-search-card__location', el => el.textContent.trim()).catch(() => 'N/A');
          const datePostedText = await listing.$eval('.job-search-card__listdate', el => el.textContent.trim()).catch(() => 'N/A');

          const jobDescriptionSummary = await listing.$eval('.job-search-card__snippet', el => {
            const text = el.textContent.trim();
            return text.substring(0, 300);
          }).catch(() => '');

          const jobPostingUrl = await listing.$eval('a.base-card__full-link', el => el.href);

          jobs.push({
            jobTitle,
            companyName,
            companyLinkedInUrl,
            location,
            workArrangement: workArrangement.length > 0 ? workArrangement[0] : 'N/A',
            datePosted: datePostedText,
            jobDescriptionSummary,
            jobPostingUrl
          });

          jobCount++;
          await humanDelay();

          if (jobCount >= maxResults) break;
        } catch (error) {
          console.log(`Skipping job listing ${i}: ${error.message}`);
          continue;
        }
      }

      // Scroll to load more if needed
      if (jobCount < maxResults) {
        const newHeight = await page.evaluate(() => document.body.scrollHeight);
        if (newHeight === previousHeight) {
          console.log('Reached end of listings');
          break;
        }
        previousHeight = newHeight;
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await humanDelay();
      }
    }

    console.log(`Successfully scraped ${jobs.length} job listings`);
    await browser.close();

    // Filter for relevance before returning
    const { kept, filtered } = filterJobs(jobs, roleTitle);
    if (filtered.length > 0) {
      console.log(`Relevance filter removed ${filtered.length} off-target results`);
    }
    return kept;

  } catch (error) {
    console.error('Error in scrapeLinkedInJobs:', error.message);
    if (browser) await browser.close();
    return [];
  }
}

// Candidate result selectors — LinkedIn uses different DOM for People search
// Strategy 1: Logged-in People search (entity-result cards)
// Strategy 2: Public/logged-out People search (base-card cards)
const CANDIDATE_SELECTORS = {
  loggedIn: {
    resultContainer: '.reusable-search__result-container',
    resultItem: '.entity-result',
    name: '.entity-result__title-text a span[aria-hidden="true"]',
    nameFallback: '.entity-result__title-text',
    headline: '.entity-result__primary-subtitle',
    location: '.entity-result__secondary-subtitle',
    profileLink: '.entity-result__title-text a',
  },
  publicFallback: {
    resultContainer: '.search-results-container',
    resultItem: '.base-card',
    name: '.base-search-card__title',
    headline: '.base-search-card__subtitle',
    location: '.base-search-card__location',
    profileLink: 'a.base-card__full-link',
  },
};

// Detect which selector strategy works on the current page
async function detectCandidateSelectors(page) {
  // Try logged-in selectors first (most common path since we call ensureLoggedIn)
  const loggedIn = await page.$(CANDIDATE_SELECTORS.loggedIn.resultItem);
  if (loggedIn) {
    console.log('Detected logged-in People search layout (entity-result)');
    return CANDIDATE_SELECTORS.loggedIn;
  }

  // Fallback to public search selectors
  const publicCard = await page.$(CANDIDATE_SELECTORS.publicFallback.resultItem);
  if (publicCard) {
    console.log('Detected public People search layout (base-card)');
    return CANDIDATE_SELECTORS.publicFallback;
  }

  return null;
}

// Safely extract text from an element, returns fallback on any error
async function safeText(parent, selector, fallback = 'N/A') {
  try {
    const el = await parent.$(selector);
    if (!el) return fallback;
    const text = await el.evaluate(node => node.textContent.trim());
    return text || fallback;
  } catch {
    return fallback;
  }
}

// Safely extract href from an element
async function safeHref(parent, selector, fallback = '') {
  try {
    const el = await parent.$(selector);
    if (!el) return fallback;
    const href = await el.evaluate(node => node.href || node.getAttribute('href') || '');
    return href || fallback;
  } catch {
    return fallback;
  }
}

// Parse headline into title + company (e.g. "VP of Sales at Acme Corp")
function parseHeadline(headline) {
  if (!headline || headline === 'N/A') return { title: 'N/A', company: 'N/A' };
  // Common patterns: "Title at Company", "Title | Company", "Title - Company"
  const separators = [' at ', ' @ ', ' | ', ' – ', ' - '];
  for (const sep of separators) {
    const idx = headline.lastIndexOf(sep);
    if (idx > 0) {
      return {
        title: headline.substring(0, idx).trim(),
        company: headline.substring(idx + sep.length).trim(),
      };
    }
  }
  return { title: headline, company: 'N/A' };
}

// Scrape LinkedIn candidate profiles
async function scrapeLinkedInCandidates(config) {
  const {
    roleTitle,
    location,
    seniorityLevel,
    openToWorkOnly = false,
    maxResults = 10
  } = config;

  let browser, page;
  const candidates = [];

  try {
    console.log(`Starting LinkedIn candidate scrape for: ${roleTitle} in ${location}`);

    // Create Browserbase session
    const session = await createBrowserbaseSession();
    browser = session.browser;
    page = await browser.newPage();

    // Ensure logged in
    await ensureLoggedIn(page);
    await humanDelay();

    // Build search URL for people
    let searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(roleTitle)}&location=${encodeURIComponent(location)}`;

    // Add seniority filter
    if (seniorityLevel) {
      const seniorityMap = {
        'entry': 1,
        'mid': 2,
        'mid-senior': 3,
        'senior': 4
      };
      const seniorityCode = seniorityMap[seniorityLevel.toLowerCase()] || 2;
      searchUrl += `&f_E=${seniorityCode}`;
    }

    // Add open to work filter
    if (openToWorkOnly) {
      searchUrl += '&f_OTO=1';
    }

    // Navigate to people search
    console.log('Navigating to LinkedIn People search...');
    await navigateWithRetry(page, searchUrl);
    await humanDelay(2000, 3000); // Extra wait for People search — heavier page

    // Wait for candidate results — try multiple selectors with generous timeout
    let selectors = null;
    const RESULT_TIMEOUT = 20000; // 20 seconds

    try {
      // Race: whichever selector appears first wins
      await Promise.race([
        page.waitForSelector(CANDIDATE_SELECTORS.loggedIn.resultItem, { timeout: RESULT_TIMEOUT }),
        page.waitForSelector(CANDIDATE_SELECTORS.publicFallback.resultItem, { timeout: RESULT_TIMEOUT }),
      ]);
      selectors = await detectCandidateSelectors(page);
    } catch (waitErr) {
      // Neither selector found — check if LinkedIn is showing "no results" or a redirect
      const pageUrl = page.url();
      const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '').catch(() => '');
      console.warn(`No candidate results found after ${RESULT_TIMEOUT}ms.`);
      console.warn(`Current URL: ${pageUrl}`);
      console.warn(`Page preview: ${bodyText.substring(0, 200)}`);

      // If redirected to login, the session cookie expired — track for alerting
      if (pageUrl.includes('/login') || pageUrl.includes('/authwall')) {
        console.warn('LinkedIn redirected to login — session may have expired');
        _authFailureCount++;
        _authFailureDetails.push(`Candidates: "${roleTitle}" in "${location}" — redirected to login`);
      }

      // Graceful empty return — candidates will come from PDL instead
      if (browser) await browser.close();
      return [];
    }

    if (!selectors) {
      console.warn('Could not detect People search layout — returning empty');
      if (browser) await browser.close();
      return [];
    }

    await humanDelay();

    // Extract candidate profiles
    let candidateCount = 0;
    let previousHeight = 0;
    let scrollStalls = 0;
    const MAX_SCROLL_STALLS = 2;

    while (candidateCount < maxResults) {
      const profiles = await page.$$(selectors.resultItem);

      if (profiles.length === 0) {
        console.log('No profile elements found on page');
        break;
      }

      for (let i = candidateCount; i < Math.min(profiles.length, maxResults); i++) {
        try {
          const profile = profiles[i];

          // Extract name — try primary selector, then fallback
          let fullName = await safeText(profile, selectors.name);
          if (fullName === 'N/A' && selectors.nameFallback) {
            fullName = await safeText(profile, selectors.nameFallback);
          }

          // Skip "LinkedIn Member" placeholders (private profiles)
          if (fullName === 'LinkedIn Member' || fullName === 'N/A') {
            console.log(`Skipping private/hidden profile at index ${i}`);
            continue;
          }

          const headline = await safeText(profile, selectors.headline);
          const { title: currentTitle, company: currentCompany } = parseHeadline(headline);
          const profileLocation = await safeText(profile, selectors.location);
          const profileUrl = await safeHref(profile, selectors.profileLink);

          candidates.push({
            fullName,
            currentTitle,
            currentCompany,
            location: profileLocation,
            estimatedYearsExperience: 'N/A',
            topSkills: [],
            openToWork: openToWorkOnly,
            lastProfileActivity: 'N/A',
            profileUrl,
            linkedinUrl: profileUrl, // alias used by pipeline
          });

          candidateCount++;
          await humanDelay();

          if (candidateCount >= maxResults) break;
        } catch (error) {
          console.log(`Skipping candidate profile ${i}: ${error.message}`);
          continue;
        }
      }

      // Scroll to load more if needed
      if (candidateCount < maxResults) {
        const newHeight = await page.evaluate(() => document.body.scrollHeight);
        if (newHeight === previousHeight) {
          scrollStalls++;
          if (scrollStalls >= MAX_SCROLL_STALLS) {
            console.log('Reached end of candidate results (scroll stalled)');
            break;
          }
        } else {
          scrollStalls = 0;
        }
        previousHeight = newHeight;
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await humanDelay();
      }
    }

    console.log(`Successfully scraped ${candidates.length} candidate profiles`);
    await browser.close();
    return candidates;

  } catch (error) {
    console.error('Error in scrapeLinkedInCandidates:', error.message);
    if (browser) await browser.close();
    return [];
  }
}

/**
 * Create a re-authentication session in the pipeline's persistent context.
 * Returns a Browserbase session URL that can be opened in any browser.
 * The user logs into LinkedIn there, closes the tab, and cookies persist
 * for future pipeline runs automatically.
 *
 * Called by run-now.js when auth failures are detected — the URL is
 * included directly in the alert email so ops can just click it.
 */
async function createReauthSession() {
  try {
    // Ensure we have a context (loads from Supabase or creates new)
    const contextId = await ensureLinkedInContext();

    const sessionPayload = { projectId: BROWSERBASE_PROJECT_ID };
    if (contextId) {
      sessionPayload.browserSettings = { context: { id: contextId, persist: true } };
    }

    const response = await axios.post(
      'https://api.browserbase.com/v1/sessions',
      sessionPayload,
      {
        headers: {
          'X-BB-API-Key': BROWSERBASE_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    const sessionId = response.data.id;
    const debugUrl = `https://www.browserbase.com/sessions/${sessionId}`;
    console.log(`[LinkedIn] Re-auth session created: ${debugUrl}`);
    return debugUrl;
  } catch (error) {
    console.error(`[LinkedIn] Failed to create re-auth session: ${error.message}`);
    return null;
  }
}

// Export functions
module.exports = {
  scrapeLinkedInJobs,
  scrapeLinkedInCandidates,
  getAuthFailures,
  resetAuthFailures,
  createReauthSession,
  resetLinkedInContext
};
