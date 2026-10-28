const config = require('./security/config-loader');
const cron = require('node-cron');
const axios = require('axios');

// Concurrency limiter (lightweight — no external dependency)
function pLimit(concurrency) {
  const queue = [];
  let active = 0;

  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  }

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

// Import all modules
const {
  scrapeLinkedInJobs,
  scrapeLinkedInCandidates
} = require('./linkedin-scraper');

// Indeed scraper removed — 100% blocked by Cloudflare bot detection (April 2026)
// const { scrapeIndeedJobs } = require('./indeed-scraper');

const {
  enrichCompany,
  findContact,
  batchEnrichCompanies
} = require('./apollo-enrichment');

const {
  findCandidates,
  scoreCandidates
} = require('./pdl-candidates');

const {
  getCachedCandidates,
  setCachedCandidates,
  getCacheStats,
  pruneExpired: pruneCandidateCache
} = require('./candidate-cache');

const {
  getCachedEnrichment,
  getEnrichmentCacheStats,
} = require('./enrichment-cache');

const {
  synthesizeIntelligence,
  getMarketContext
} = require('./claude-synthesis');

const {
  extractSearchSkills
} = require('./skill-extractor');

const {
  generateReport,
  uploadToOneDrive
} = require('./pdf-generator');

const {
  batchWriteLeads
} = require('./airtable-writer');

const {
  writeLeadsToSupabase,
  isConfigured: isSupabaseWriterConfigured
} = require('./supabase-writer');

const {
  sendDigest,
  sendRunSummaryToOps
} = require('./digest-email');

const { createCostTracker } = require('./cost-tracker');
const { filterStaffingAgencies } = require('./relevance-filter');

/**
 * Main Kurrent Pipeline Orchestration
 * @param {Object} clientConfig - Client configuration object
 * @returns {Promise<Object>} Run summary with metrics
 */
/**
 * Tier definitions — controls what each account type gets access to.
 *
 * starter:          Basic pipeline with PDF reports. No candidate scoring.
 *                   6 roles, 1 location, 3 results/role.
 *
 * growth:           Full pipeline with candidate scoring and PDF reports.
 *                   12 roles, 3 locations, 3 results/role.
 *
 * scale:            Full pipeline, highest limits, weekly market summary.
 *                   25 roles, 5 locations, 3 results/role.
 *
 * founding_partner: Custom tier for a design-partner account — full pipeline, generous limits.
 *                   20 roles, 10 locations, 3 results/role.
 */
const TIER_CONFIG = {
  starter: {
    maxRoles: 6,
    maxLocations: 1,
    maxResultsPerRole: 3,
    includeCandidates: false,
    includePdfs: true,
    includeWeeklySummary: false,
    creditBudget: { apollo: 100, pdl: 0 },
  },
  growth: {
    maxRoles: 12,
    maxLocations: 3,
    maxResultsPerRole: 3,
    includeCandidates: true,
    includePdfs: true,
    includeWeeklySummary: false,
    creditBudget: { apollo: 300, pdl: 120 },
  },
  scale: {
    maxRoles: 25,
    maxLocations: 5,
    maxResultsPerRole: 3,
    includeCandidates: true,
    includePdfs: true,
    includeWeeklySummary: true,
    creditBudget: { apollo: 400, pdl: 250 },
  },
  founding_partner: {
    maxRoles: 20,
    maxLocations: 10,
    maxResultsPerRole: 3,
    includeCandidates: true,
    includePdfs: true,
    includeWeeklySummary: true,
    creditBudget: { apollo: 200, pdl: 50 },
  },
};

/**
 * Build a short headline string for a candidate (shown on lead cards).
 * E.g., "15+ yrs EPCM · P.Eng, PMP · GTA"
 * Falls back to title + location if details are sparse.
 */
function buildCandidateHeadline(candidate) {
  if (!candidate) return '';
  const parts = [];
  // Years of experience (round to whole number for cleaner display)
  if (candidate.yearsExperience && candidate.yearsExperience > 0) {
    const yrs = Math.round(candidate.yearsExperience);
    if (yrs > 0) parts.push(`${yrs}+ yrs`);
  }
  // Current title or top skills — clean up garbled PDL data
  if (candidate.currentTitle && candidate.currentTitle !== 'Unknown') {
    // Remove special characters that indicate garbled data (|, &, #, etc.)
    let title = candidate.currentTitle
      .replace(/[|&#+@]/g, ' ')  // Strip noise characters
      .replace(/\s+/g, ' ')      // Collapse whitespace
      .trim();
    // Abbreviate to first 3 meaningful words
    const titleWords = title.split(' ').filter(w => w.length > 1);
    const titleShort = titleWords.slice(0, 3).join(' ');
    if (titleShort) parts.push(titleShort);
  } else if (candidate.topSkills && candidate.topSkills.length > 0) {
    parts.push(candidate.topSkills.slice(0, 2).join(', '));
  }
  // Location (city or region)
  if (candidate.location && candidate.location !== 'Unknown') {
    const locParts = candidate.location.split(',').map(s => s.trim());
    parts.push(locParts[0]); // Just the city
  }
  return parts.join(' · ') || '';
}

/**
 * Build the shared run context: tier, today's roles/locations, metrics, cost tracker.
 * Every stage function below receives this object and reads/writes metrics.steps.
 */
async function createRunContext(clientConfig, options = {}) {
  // Debug: log which critical env vars are present (masked)
  const envCheck = {
    BROWSERBASE_API_KEY: process.env.BROWSERBASE_API_KEY ? 'set' : 'MISSING',
    BROWSERBASE_PROJECT_ID: process.env.BROWSERBASE_PROJECT_ID ? 'set' : 'MISSING',
    CLAUDE_API_KEY: process.env.CLAUDE_API_KEY ? 'set' : 'MISSING',
    APOLLO_API_KEY: process.env.APOLLO_API_KEY ? 'set' : 'MISSING',
    AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY ? 'set' : 'MISSING',
    RESEND_API_KEY: process.env.RESEND_API_KEY ? 'set' : 'MISSING',
    SUPABASE_URL: process.env.SUPABASE_URL ? 'set' : 'MISSING',
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'set' : 'MISSING',
    PDL_API_KEY: process.env.PDL_API_KEY ? 'set' : 'MISSING',
    PDFMONKEY_API_KEY: process.env.PDFMONKEY_API_KEY ? 'set' : 'MISSING',
  };
  console.log('[ENV-CHECK]', JSON.stringify(envCheck));

  config.validate({ quiet: true });
  const testMode = options.testMode || false;
  const runStartTime = new Date();
  const runId = `${Date.now()}`;
  const errors = [];

  // Resolve tier config (default to starter if unknown)
  const clientTier = (clientConfig.tier || 'starter').toLowerCase();
  const tierConfig = TIER_CONFIG[clientTier] || TIER_CONFIG.starter;

  console.log(`[TIER] Account type: ${clientTier} — candidates: ${tierConfig.includeCandidates ? 'yes' : 'no'}, pdfs: ${tierConfig.includePdfs ? 'yes' : 'no'}, maxRoles: ${tierConfig.maxRoles}, maxLocations: ${tierConfig.maxLocations}, maxResults/role: ${tierConfig.maxResultsPerRole}`);

  // ── Per-recruiter role scheduling ──
  // Load recruiter_configs from Supabase and merge today's scheduled roles.
  // If recruiter configs exist, only scrape roles that are scheduled for today
  // across ALL recruiters (union of each recruiter's today-roles).
  // Falls back to client-level targetRoles if no recruiter configs found.
  let recruiterConfigs = [];
  const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const todayKey = dayKeys[new Date().getDay()];

  const SUPABASE_URL_RC = process.env.SUPABASE_URL;
  const SUPABASE_KEY_RC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (SUPABASE_URL_RC && SUPABASE_KEY_RC && clientConfig.clientId) {
    try {
      const { createClient } = require('@supabase/supabase-js');
      const supabase = createClient(SUPABASE_URL_RC, SUPABASE_KEY_RC);
      const { data: configs } = await supabase
        .from('recruiter_configs')
        .select('user_id, target_roles, target_locations, schedule, display_name')
        .eq('client_id', clientConfig.clientId);

      if (configs && configs.length > 0) {
        recruiterConfigs = configs;
        console.log(`[SCHEDULE] Found ${configs.length} recruiter config(s) — building today's role schedule (${todayKey})`);
      }
    } catch (rcErr) {
      console.warn(`[SCHEDULE] Could not load recruiter_configs: ${rcErr.message} — using client-level roles`);
    }
  }

  // Build today's active roles: union of all recruiters' scheduled-for-today roles
  let activeRoles;
  let activeLocations;
  let recruiterRoleMap = {}; // role title → [user_ids] for auto-assignment

  if (recruiterConfigs.length > 0) {
    const todayRoleSet = new Map(); // role title → role object (deduped)
    const todayLocationSet = new Set();

    for (const rc of recruiterConfigs) {
      const roles = rc.target_roles || [];
      const schedule = rc.schedule || {};
      const locations = rc.target_locations || [];

      for (const role of roles) {
        const roleTitle = typeof role === 'string' ? role : role.title;
        const days = schedule[roleTitle] || [];
        // If no schedule set, role is active every day
        const isToday = days.length === 0 || days.includes(todayKey);
        if (isToday && roleTitle) {
          if (!todayRoleSet.has(roleTitle.toLowerCase())) {
            todayRoleSet.set(roleTitle.toLowerCase(), {
              title: roleTitle,
              function: (typeof role === 'object' ? role.function : '') || '',
              seniority: (typeof role === 'object' ? role.seniority : '') || 'IC',
            });
          }
          // Track which recruiters own this role
          if (!recruiterRoleMap[roleTitle.toLowerCase()]) recruiterRoleMap[roleTitle.toLowerCase()] = [];
          recruiterRoleMap[roleTitle.toLowerCase()].push(rc.user_id);
        }
      }

      for (const loc of locations) {
        if (loc) todayLocationSet.add(loc);
      }
    }

    const mergedRoles = Array.from(todayRoleSet.values());
    const mergedLocations = Array.from(todayLocationSet);

    // Apply tier limits
    activeRoles = mergedRoles.slice(0, tierConfig.maxRoles);
    activeLocations = mergedLocations.length > 0
      ? mergedLocations.slice(0, tierConfig.maxLocations)
      : (clientConfig.targetLocations || []).slice(0, tierConfig.maxLocations);

    console.log(`[SCHEDULE] Today's roles (${activeRoles.length}): ${activeRoles.map(r => r.title).join(', ')}`);
    console.log(`[SCHEDULE] Today's locations (${activeLocations.length}): ${activeLocations.join(', ')}`);
  } else {
    activeRoles = clientConfig.targetRoles.slice(0, tierConfig.maxRoles);
    activeLocations = (clientConfig.targetLocations || []).slice(0, tierConfig.maxLocations);
  }

  let maxResultsPerRole = Math.min(clientConfig.maxResultsPerRole || 3, tierConfig.maxResultsPerRole);

  // Test mode: override to conserve credits
  if (testMode) {
    activeRoles = activeRoles.slice(0, 1); // Only first role
    activeLocations = activeLocations.slice(0, 1);
    maxResultsPerRole = 1;
    console.log(`\n⚠️  TEST MODE: Limited to 1 role, 1 location, 1 result per role to conserve credits\n`);
  }

  // Initialize metrics
  const metrics = {
    runId,
    clientId: clientConfig.clientId,
    agencyName: clientConfig.agencyName,
    startTime: runStartTime.toISOString(),
    endTime: null,
    totalDuration: null,
    jobsDiscovered: 0,
    companiesDeduped: 0,
    marketsAnalyzed: 0,
    companiesEnriched: 0,
    candidatesScored: 0,
    intelligenceSynthesized: 0,
    pdfGenerated: 0,
    leadsWritten: 0,
    digestSent: false,
    errors: [],
    steps: {}
  };

  // Cost tracker — logs every API call and flushes to Supabase at end of run
  const costTracker = createCostTracker(clientConfig.clientId);

  return {
    clientConfig, options, testMode, runStartTime, runId, errors, clientTier, tierConfig,
    recruiterConfigs, recruiterRoleMap, todayKey, activeRoles, activeLocations, maxResultsPerRole,
    metrics, costTracker, SUPABASE_URL_RC, SUPABASE_KEY_RC,
    enrichedCompanies: [],   // stage 4 → 4b
    leadRecords: [],         // stage 8 → 8b
  };
}

async function stageJobDiscovery(ctx) {
  const { errors, activeRoles, activeLocations, maxResultsPerRole, metrics, costTracker } = ctx;
  // ========================================================================
  // STEP 1: JOB DISCOVERY
  // ========================================================================
  console.log('[STEP 1] Job Discovery: Scraping LinkedIn jobs and candidates...\n');
  const stepStartTime = Date.now();

  // Declare outside try so data survives partial failures
  const allJobs = [];
  const allJobsData = [];

  try {
    // Track consecutive LinkedIn candidate failures — skip after 2 login redirects
    let candidateSessionFailures = 0;
    const MAX_CANDIDATE_FAILURES = 2;
    let candidateScrapingDisabled = false;

    // Parallelize by role (up to 3 concurrent roles)
    const roleLimit = pLimit(3);

    const roleResults = await Promise.allSettled(
      activeRoles.map(role => roleLimit(async () => {
        const roleJobs = [];
        const roleJobsData = [];

        for (const location of activeLocations) {
          // --- LinkedIn Jobs ---
          try {
            console.log(`  Scraping LinkedIn for: ${role.title} in ${location}`);

            const jobsResult = await scrapeLinkedInJobs({
              roleTitle: role.title,
              location: location,
              maxResults: maxResultsPerRole
            });

            costTracker.track('browserbase', 1, null, `LinkedIn job scrape: ${role.title} in ${location}`);

            if (jobsResult && jobsResult.length > 0) {
              console.log(`    Found ${jobsResult.length} LinkedIn jobs for ${role.title} in ${location}`);
              roleJobs.push(...jobsResult);

              for (const job of jobsResult) {
                roleJobsData.push({
                  ...job,
                  roleTitle: job.jobTitle || role.title,
                  searchRole: role.title,
                  roleFunction: role.function,
                  roleSeniority: role.seniority,
                  location: location,
                  source: job.source || 'linkedin'
                });
              }
            } else {
              console.log(`    No LinkedIn results for ${role.title} in ${location}`);
            }
          } catch (linkedinErr) {
            const errMsg = `Error scraping LinkedIn for ${role.title} in ${location}: ${linkedinErr.message}`;
            console.error(`  ✗ ${errMsg}`);
            errors.push(errMsg);
          }

          // Indeed removed — blocked by Cloudflare (April 2026). LinkedIn is sole job source.

          // --- LinkedIn Candidates (early-exit after consecutive failures) ---
          if (!candidateScrapingDisabled) {
            try {
              console.log(`  Scraping candidates for: ${role.title} in ${location}`);
              const candidatesResult = await scrapeLinkedInCandidates({
                roleTitle: role.title,
                location: location,
                maxResults: maxResultsPerRole
              });

              costTracker.track('browserbase', 1, null, `LinkedIn candidate scrape: ${role.title} in ${location}`);
              if (candidatesResult && candidatesResult.length > 0) {
                console.log(`    Found ${candidatesResult.length} LinkedIn candidates`);
                candidateSessionFailures = 0; // Reset on success
              } else {
                // Empty result likely means login redirect
                candidateSessionFailures++;
                console.warn(`    ⚠ LinkedIn candidates empty (failure ${candidateSessionFailures}/${MAX_CANDIDATE_FAILURES})`);
                if (candidateSessionFailures >= MAX_CANDIDATE_FAILURES) {
                  candidateScrapingDisabled = true;
                  console.warn(`    ⚠ SKIPPING remaining LinkedIn candidate scrapes — session appears expired. Candidates will come from PDL (Step 5).`);
                }
              }
            } catch (candidateErr) {
              candidateSessionFailures++;
              const errMsg = `Error scraping candidates for ${role.title} in ${location}: ${candidateErr.message}`;
              console.error(`  ✗ ${errMsg}`);
              errors.push(errMsg);
              if (candidateSessionFailures >= MAX_CANDIDATE_FAILURES) {
                candidateScrapingDisabled = true;
                console.warn(`    ⚠ SKIPPING remaining LinkedIn candidate scrapes — too many failures. Candidates will come from PDL (Step 5).`);
              }
            }
          } else {
            console.log(`  ⏭ Skipping candidate scrape for ${role.title} in ${location} (disabled after ${MAX_CANDIDATE_FAILURES} consecutive failures — candidates will come from PDL)`);
          }
        }

        return { roleJobs, roleJobsData };
      }))
    );

    // Merge results from all roles
    for (const result of roleResults) {
      if (result.status === 'fulfilled') {
        allJobs.push(...result.value.roleJobs);
        allJobsData.push(...result.value.roleJobsData);
      } else {
        const errMsg = `Role scraping failed: ${result.reason?.message || result.reason}`;
        console.error(`  ✗ ${errMsg}`);
        errors.push(errMsg);
      }
    }

    console.log(`\n  [DEBUG] Step 1 totals: allJobs=${allJobs.length}, allJobsData=${allJobsData.length}`);

  } catch (err) {
    const errMsg = `STEP 1 Job Discovery failed: ${err.message}`;
    console.error(`✗ ${errMsg}`);
    errors.push(errMsg);
  }

  // Always set metrics — even if Step 1 partially failed, preserve whatever was collected
  metrics.jobsDiscovered = allJobs.length;
  metrics.steps.jobDiscovery = {
    status: allJobs.length > 0 ? 'completed' : 'failed',
    duration: Date.now() - stepStartTime,
    jobsFound: allJobs.length,
    jobsList: allJobsData
  };

  console.log(`\n  ✓ Step 1 complete: ${allJobs.length} jobs discovered (${allJobsData.length} with metadata)\n`);

}

async function stageDeduplication(ctx) {
  const { clientConfig, errors, metrics } = ctx;
  // ========================================================================
  // STEP 2: DEDUPLICATE
  // ========================================================================
  console.log('[STEP 2] Deduplication: Removing duplicate companies by name + role...\n');
  const stepStartTime2 = Date.now();

  try {
    const jobsList = metrics.steps.jobDiscovery.jobsList || [];
    console.log(`  Step 2 input: ${jobsList.length} jobs from Step 1`);

    const dedupeMap = new Map();
    let dupeCount = 0;

    for (const job of jobsList) {
      const key = `${job.companyName || 'Unknown'}|${job.roleTitle || 'Unknown'}`;
      if (!dedupeMap.has(key)) {
        dedupeMap.set(key, job);
      } else {
        dupeCount++;
      }
    }
    console.log(`  Step 2 result: ${dedupeMap.size} unique, ${dupeCount} duplicates removed`);

    const dedupedJobs = Array.from(dedupeMap.values());
    metrics.companiesDeduped = dedupedJobs.length;
    metrics.steps.deduplication = {
      status: 'completed',
      duration: Date.now() - stepStartTime2,
      beforeDedupe: jobsList.length,
      afterDedupe: dedupedJobs.length,
      jobsList: dedupedJobs
    };

    console.log(`  ✓ Step 2 complete: ${jobsList.length} → ${dedupedJobs.length} unique company/role combinations`);

    // Step 2b: Supabase-level dedup — skip company+role combos we already have as leads
    // within the last 7 days. Saves enrichment + synthesis costs on repeat postings.
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supabaseUrl && supabaseKey) {
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const existingRes = await axios.get(`${supabaseUrl}/rest/v1/leads`, {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          params: {
            client_id: `eq.${clientConfig.clientId}`,
            created_at: `gte.${sevenDaysAgo}`,
            select: 'company_name,role_title',
          },
        });

        const existingLeads = new Set(
          (existingRes.data || []).map(l => `${(l.company_name || '').toLowerCase()}|${(l.role_title || '').toLowerCase()}`)
        );

        if (existingLeads.size > 0) {
          const beforeCount = dedupedJobs.length;
          const filteredJobs = dedupedJobs.filter(job => {
            const key = `${(job.companyName || '').toLowerCase()}|${(job.roleTitle || '').toLowerCase()}`;
            if (existingLeads.has(key)) {
              console.log(`    [DEDUP] Skipping existing lead: ${job.companyName} — ${job.roleTitle}`);
              return false;
            }
            return true;
          });

          // Update the jobsList in metrics so downstream steps use the filtered list
          metrics.steps.deduplication.jobsList = filteredJobs;
          metrics.steps.deduplication.afterSupabaseDedup = filteredJobs.length;
          metrics.steps.deduplication.existingLeadsSkipped = beforeCount - filteredJobs.length;

          console.log(`  ✓ Step 2b: Skipped ${beforeCount - filteredJobs.length} jobs already in leads (last 7 days) → ${filteredJobs.length} new jobs\n`);
        } else {
          console.log(`  ✓ Step 2b: No recent leads found — all ${dedupedJobs.length} jobs are new\n`);
        }
      } catch (err) {
        console.warn(`  [DEDUP] Supabase dedup check failed (non-fatal): ${err.message}`);
        console.log('');
      }
    } else {
      console.log('');
    }

  } catch (err) {
    const errMsg = `STEP 2 Deduplication failed: ${err.message}`;
    console.error(`✗ ${errMsg}`);
    errors.push(errMsg);
    metrics.steps.deduplication = { status: 'failed', error: errMsg, duration: Date.now() - stepStartTime2 };
  }

}

async function stageMarketContext(ctx) {
  const { errors, metrics, costTracker } = ctx;
  // ========================================================================
  // STEP 3: MARKET CONTEXT
  // ========================================================================
  console.log('[STEP 3] Market Context: Analyzing market for each unique role...\n');
  const stepStartTime3 = Date.now();

  try {
    const marketContextMap = new Map();
    const dedupedJobs = metrics.steps.deduplication.jobsList || [];

    // Get unique roles
    const uniqueRoles = new Map();
    dedupedJobs.forEach(job => {
      const roleKey = job.roleTitle;
      if (!uniqueRoles.has(roleKey)) {
        uniqueRoles.set(roleKey, job);
      }
    });

    // Parallelize market context calls (up to 5 concurrent Claude API calls)
    const marketLimit = pLimit(5);

    const marketResults = await Promise.allSettled(
      Array.from(uniqueRoles.entries()).map(([roleTitle, job]) =>
        marketLimit(async () => {
          console.log(`  Getting market context for: ${roleTitle} in ${job.location}`);
          const context = await getMarketContext(roleTitle, job.location);
          costTracker.track('claude', 1, null, `Market context: ${roleTitle}`);
          console.log(`    ✓ Market context retrieved for ${roleTitle}`);
          return { roleTitle, context };
        })
      )
    );

    for (const result of marketResults) {
      if (result.status === 'fulfilled') {
        marketContextMap.set(result.value.roleTitle, result.value.context);
        metrics.marketsAnalyzed++;
      } else {
        const errMsg = `Error getting market context: ${result.reason?.message || result.reason}`;
        console.error(`  ✗ ${errMsg}`);
        errors.push(errMsg);
      }
    }

    metrics.steps.marketContext = {
      status: 'completed',
      duration: Date.now() - stepStartTime3,
      marketsAnalyzed: metrics.marketsAnalyzed,
      contextMap: Object.fromEntries(marketContextMap)
    };

    console.log(`\n  ✓ Step 3 complete: Market context for ${metrics.marketsAnalyzed} roles analyzed\n`);

  } catch (err) {
    const errMsg = `STEP 3 Market Context failed: ${err.message}`;
    console.error(`✗ ${errMsg}`);
    errors.push(errMsg);
    metrics.steps.marketContext = { status: 'failed', error: errMsg, duration: Date.now() - stepStartTime3 };
  }

}

async function stageCompanyEnrichment(ctx) {
  const { clientConfig, errors, metrics, costTracker } = ctx;
  // ========================================================================
  // STEP 4: COMPANY ENRICHMENT
  // ========================================================================
  console.log('[STEP 4] Company Enrichment: Enriching companies and finding contacts...\n');
  const stepStartTime4 = Date.now();
  const enrichedCompanies = ctx.enrichedCompanies;

  try {
    const dedupedJobs = metrics.steps.deduplication.jobsList || [];

    console.log(`  [DEBUG] Step 4 input: ${dedupedJobs.length} deduped jobs`);

    // Get unique companies
    const uniqueCompanies = new Map();
    dedupedJobs.forEach(job => {
      const companyKey = job.companyName;
      if (!uniqueCompanies.has(companyKey)) {
        uniqueCompanies.set(companyKey, job);
      }
    });

    console.log(`  [DEBUG] Unique companies to enrich: ${uniqueCompanies.size}`);

    // Check enrichment cache stats
    const enrichCacheStats = await getEnrichmentCacheStats(clientConfig.clientId);
    console.log(`  [EnrichCache] ${enrichCacheStats.cachedCompanies} companies cached, ${enrichCacheStats.withContacts} with contacts`);

    let cacheHits = 0;
    let cacheMisses = 0;

    // Parallelize enrichment (up to 5 concurrent — respects Apollo/PDL rate limits)
    const enrichLimit = pLimit(5);

    const enrichResults = await Promise.allSettled(
      Array.from(uniqueCompanies.entries()).map(([companyName, job]) =>
        enrichLimit(async () => {
          console.log(`  Enriching company: ${companyName}`);

          // Check Supabase cache first — avoid paying for data we already have
          // Pass domain for cross-client matching (same company = same contact)
          const cached = await getCachedEnrichment(companyName, clientConfig.clientId, job.domain || null);

          let enrichData = cached.company;
          let contact = cached.contact;
          let wasCacheHit = false;

          if (cached.hitType === 'full-hit') {
            // Both company and contact cached — skip all API calls
            console.log(`    ✓ CACHE HIT (company + contact) — skipping Apollo/PDL`);
            wasCacheHit = true;
          } else {
            if (!enrichData) {
              // Company not cached or stale — call Apollo
              enrichData = await enrichCompany(companyName, job.domain);
              costTracker.track('apollo', 1, null, `Org search: ${companyName}`);
              if (cached.hitType === 'contact-only') {
                console.log(`    ✓ Company enriched (contact from cache)`);
              } else {
                console.log(`    ✓ Company enriched`);
              }
            } else {
              console.log(`    ✓ Company from cache (${Math.round(require('./enrichment-cache').COMPANY_TTL_DAYS)}d TTL)`);
            }

            if (!contact && enrichData) {
              // Contact not cached or stale — run PDL-first waterfall
              try {
                contact = await findContact(companyName, enrichData.domain, {
                  headcount: enrichData.headcount || 0
                });
                // Track actual source — don't overcount by logging both PDL + Apollo
                if (contact && contact.source) {
                  if (contact.source === 'contact-cache') {
                    // Cache hit — no API credits spent
                  } else if (contact.source.startsWith('pdl')) {
                    costTracker.track('pdl', 1, null, `Contact search: ${companyName}`);
                  } else if (contact.source.startsWith('apollo')) {
                    costTracker.track('apollo', 1, null, `Contact search: ${companyName}`);
                  }
                } else {
                  // No contact found — still used 1 PDL credit (search returned empty) + Apollo attempts
                  costTracker.track('pdl', 1, null, `Contact search (miss): ${companyName}`);
                  costTracker.track('apollo', 1, null, `Contact search (miss): ${companyName}`);
                }
              } catch (contactErr) {
                console.warn(`    ! Contact lookup failed: ${contactErr.message}`);
              }
            } else if (contact) {
              console.log(`    ✓ Contact from cache: ${contact.fullName} (${contact.contactQuality})`);
            }
          }

          return { companyName, enrichData, contact, job, wasCacheHit };
        })
      )
    );

    for (const result of enrichResults) {
      if (result.status === 'fulfilled') {
        const { enrichData, contact, job, wasCacheHit } = result.value;
        if (wasCacheHit) cacheHits++;
        else cacheMisses++;

        if (enrichData) {
          enrichedCompanies.push({
            company: enrichData,
            contact: contact,
            jobData: job
          });
          metrics.companiesEnriched++;
        }
      } else {
        const errMsg = `Error enriching company: ${result.reason?.message || result.reason}`;
        console.error(`  ✗ ${errMsg}`);
        errors.push(errMsg);
      }
    }

    console.log(`  [EnrichCache] Results: ${cacheHits} cache hits, ${cacheMisses} API calls`);

    metrics.steps.companyEnrichment = {
      status: 'completed',
      duration: Date.now() - stepStartTime4,
      companiesEnriched: metrics.companiesEnriched,
      enrichedList: enrichedCompanies
    };

    console.log(`\n  ✓ Step 4 complete: ${metrics.companiesEnriched} companies enriched\n`);

  } catch (err) {
    const errMsg = `STEP 4 Company Enrichment failed: ${err.message}`;
    console.error(`✗ ${errMsg}`);
    errors.push(errMsg);
    metrics.steps.companyEnrichment = { status: 'failed', error: errMsg, duration: Date.now() - stepStartTime4 };
  }

}

async function stageStaffingAgencyFilter(ctx) {
  const { clientConfig, metrics } = ctx;
  // ========================================================================
  // STEP 4b: STAFFING AGENCY FILTER
  // ========================================================================
  console.log('[STEP 4b] Staffing Agency Filter');
  const enrichedCompanies = ctx.enrichedCompanies;
  const preFilterCount = enrichedCompanies.length;
  try {
    const clientExclusions = clientConfig.excludedCompanies || [];
    const { kept, filtered } = filterStaffingAgencies(enrichedCompanies, clientExclusions);
    // Replace contents in-place (enrichedCompanies is const)
    enrichedCompanies.length = 0;
    enrichedCompanies.push(...kept);
    metrics.staffingAgenciesFiltered = filtered.length;
    metrics.steps.staffingFilter = {
      status: 'completed',
      before: preFilterCount,
      after: kept.length,
      filtered: filtered.length,
      filteredCompanies: filtered.map(f => ({
        name: f.company?.companyName || f.jobData?.companyName,
        reason: f.staffingFilterReason,
      })),
    };
    if (filtered.length > 0) {
      console.log(`  ✓ Step 4b complete: ${filtered.length} staffing agencies removed, ${kept.length} leads remain\n`);
    } else {
      console.log(`  ✓ Step 4b complete: no staffing agencies detected\n`);
    }
  } catch (err) {
    console.warn(`  ! Staffing filter error (non-fatal): ${err.message}`);
    metrics.steps.staffingFilter = { status: 'skipped', error: err.message };
  }

}

async function stageCandidateScoring(ctx) {
  const { errors, clientTier, maxResultsPerRole, metrics, costTracker } = ctx;
  // ========================================================================
  // STEP 5: CANDIDATE SCORING
  // ========================================================================
  // Candidate search is now on-demand from the dashboard (saves PDL credits).
  // Pipeline still writes candidate fields if they exist from on-demand searches,
  // but no longer runs speculative bulk searches in Step 5.
  const skipCandidates = true;

  if (skipCandidates) {
    console.log(`[STEP 5] Candidate Scoring: SKIPPED (${clientTier} tier — candidates not included)\n`);
  } else {
    console.log(`[STEP 5] Candidate Scoring: Finding and scoring candidates (${clientTier} tier)...\n`);
  }
  const stepStartTime5 = Date.now();

  try {
    const dedupedJobs = metrics.steps.deduplication.jobsList || [];
    const allScoredCandidates = [];

    if (!skipCandidates) {
      // Log cache stats
      const cacheStats = getCacheStats();
      console.log(`  Cache: ${cacheStats.validEntries} valid entries, ${cacheStats.expiredEntries} expired\n`);

      // Get unique roles again for candidate scoring
      // Normalize location to city name only — PDL only uses the first word anyway,
      // so "Toronto Ontario Canada" and "Toronto, Ontario, Canada" are the same search.
      const uniqueRoles = new Map();
      dedupedJobs.forEach(job => {
        const city = (job.location || '').split(/[\s,]+/)[0].toLowerCase();
        const roleKey = `${job.roleTitle.toLowerCase()}|${city}`;
        if (!uniqueRoles.has(roleKey)) {
          uniqueRoles.set(roleKey, job);
        }
      });

      // Pre-extract skills per unique role TITLE (not per role+location).
      // Skill extraction only depends on title + description, not location.
      // Caching here avoids duplicate Claude calls for "PM in Toronto" + "PM in Hamilton".
      const skillCache = new Map();
      for (const [, job] of uniqueRoles) {
        const titleKey = job.roleTitle.toLowerCase().trim();
        if (!skillCache.has(titleKey)) {
          let skillKeywords = [];
          try {
            const extraction = await extractSearchSkills(job.roleTitle, job.jobDescription || '');
            skillKeywords = extraction.skillKeywords;
            if (extraction.source === 'claude') {
              costTracker.track('claude', 1, null, `Skill extraction: ${job.roleTitle}`);
            }
          } catch (err) {
            console.warn(`  ⚠ Skill extraction failed for ${job.roleTitle}: ${err.message}`);
          }
          skillCache.set(titleKey, skillKeywords);
        }
      }

      // Parallelize candidate scoring (up to 5 concurrent PDL queries)
      const candidateLimit = pLimit(5);

      const candidateResults = await Promise.allSettled(
        Array.from(uniqueRoles.entries()).map(([roleKey, job]) =>
          candidateLimit(async () => {
            const seniority = job.roleSeniority || 'mid';
            console.log(`  Finding and scoring candidates for: ${job.roleTitle} in ${job.location}`);

            // Check cache first
            let pdlCandidates = await getCachedCandidates(job.roleTitle, job.location, seniority);

            if (!pdlCandidates) {
              // Use pre-extracted skills (cached by title — no duplicate Claude calls)
              const titleKey = job.roleTitle.toLowerCase().trim();
              const skillKeywords = skillCache.get(titleKey) || [];

              // Cache miss or expired — query PDL with title keywords + extracted skills
              pdlCandidates = await findCandidates(
                job.roleTitle,
                job.location,
                seniority,
                maxResultsPerRole,
                skillKeywords
              );
              // PDL charges per person returned, not per search call
              const pdlCreditsUsed = (pdlCandidates && pdlCandidates.length) || 1;
              costTracker.track('pdl', pdlCreditsUsed, null, `Candidate search (${pdlCreditsUsed} people): ${job.roleTitle} in ${job.location}`);

              // Cache the results only if we got actual candidates
              // (don't cache empty results from network errors or credit exhaustion)
              if (pdlCandidates && pdlCandidates.length > 0) {
                setCachedCandidates(job.roleTitle, job.location, seniority, pdlCandidates);
              }
            }

            // For this demo, linkedinCandidates would come from Step 1
            const linkedinCandidates = [];

            // Score all candidates
            const scoredCandidates = await scoreCandidates(pdlCandidates || [], linkedinCandidates);

            if (scoredCandidates && scoredCandidates.length > 0) {
              // Tag each candidate with the role they were found for (used in Airtable mapping)
              scoredCandidates.forEach(c => { c._searchedRole = job.roleTitle; });
              console.log(`    Found and scored ${scoredCandidates.length} candidates`);
            }

            return { scoredCandidates: scoredCandidates || [], roleTitle: job.roleTitle };
          })
        )
      );

      for (const result of candidateResults) {
        if (result.status === 'fulfilled' && result.value.scoredCandidates.length > 0) {
          allScoredCandidates.push(...result.value.scoredCandidates);
          metrics.candidatesScored += result.value.scoredCandidates.length;
        } else if (result.status === 'rejected') {
          const errMsg = `Error finding/scoring candidates: ${result.reason?.message || result.reason}`;
          console.error(`  ✗ ${errMsg}`);
          errors.push(errMsg);
        }
      }
    } // end if (!skipCandidates)

    metrics.steps.candidateScoring = {
      status: skipCandidates ? 'skipped' : 'completed',
      duration: Date.now() - stepStartTime5,
      candidatesScored: metrics.candidatesScored,
      candidates: allScoredCandidates
    };

    if (skipCandidates) {
      console.log(`  ✓ Step 5 skipped (${clientTier} tier)\n`);
    } else {
      console.log(`\n  ✓ Step 5 complete: ${metrics.candidatesScored} candidates scored\n`);
    }

  } catch (err) {
    const errMsg = `STEP 5 Candidate Scoring failed: ${err.message}`;
    console.error(`✗ ${errMsg}`);
    errors.push(errMsg);
    metrics.steps.candidateScoring = { status: 'failed', error: errMsg, duration: Date.now() - stepStartTime5 };
  }

}

async function stageIntelligenceSynthesis(ctx) {
  const { errors, metrics, costTracker } = ctx;
  // ========================================================================
  // STEP 6: INTELLIGENCE SYNTHESIS
  // ========================================================================
  console.log('[STEP 6] Intelligence Synthesis: Synthesizing market intelligence...\n');
  const stepStartTime6 = Date.now();

  try {
    const enrichedList = metrics.steps.companyEnrichment.enrichedList || [];
    const contextMap = metrics.steps.marketContext.contextMap || {};
    const allCandidates = metrics.steps.candidateScoring.candidates || [];
    const synthesisResults = [];

    // Parallelize synthesis (up to 5 concurrent Claude API calls)
    const synthesisLimit = pLimit(5);

    const synthResults = await Promise.allSettled(
      enrichedList.map(enrichedItem =>
        synthesisLimit(async () => {
          const job = enrichedItem.jobData;
          const roleContext = contextMap[job.roleTitle] || '';

          // Get candidates for this role (matched by role tag)
          const roleCandidates = allCandidates.filter(c =>
            c._searchedRole === job.roleTitle
          );

          console.log(`  Synthesizing intelligence for: ${job.roleTitle} at ${job.companyName}`);

          const synthesis = await synthesizeIntelligence({
            companyName: job.companyName,
            roleTitle: job.roleTitle,
            location: job.location,
            seniorityTier: job.roleSeniority || 'Mid',
            workArrangement: job.workArrangement || 'Hybrid',
            jobDescription: job.jobDescription || '',
            companyData: enrichedItem.company || {},
            contactData: enrichedItem.contact || {},
            candidates: roleCandidates,
            marketContext: roleContext
          });

          costTracker.track('claude', 1, null, `Synthesis: ${job.roleTitle} at ${job.companyName}`);
          if (synthesis) {
            console.log(`    ✓ Intelligence synthesized for ${job.roleTitle} at ${job.companyName}`);
            // Merge Claude's synthesis candidate data (matchScore, headline, tags, etc.)
            // with PDL's candidate data (fullName, linkedinUrl, topSkills, etc.)
            // Claude data wins for scoring fields; PDL data wins for identity fields.
            const mergeCandidate = (pdlCandidate, synthCandidate) => {
              if (!pdlCandidate) return synthCandidate || {};
              if (!synthCandidate) return pdlCandidate;
              return { ...pdlCandidate, ...synthCandidate, fullName: pdlCandidate.fullName, linkedinUrl: pdlCandidate.linkedinUrl };
            };
            return {
              ...synthesis,
              companyName: job.companyName,
              roleTitle: job.roleTitle,
              location: job.location,
              reportDate: new Date().toISOString().split('T')[0],
              hiringContactName: enrichedItem.contact?.name || '',
              hiringContactTitle: enrichedItem.contact?.title || '',
              hiringContactEmail: enrichedItem.contact?.email || '',
              candidate1: mergeCandidate(roleCandidates[0], synthesis.candidate1),
              candidate2: mergeCandidate(roleCandidates[1], synthesis.candidate2),
              candidate3: mergeCandidate(roleCandidates[2], synthesis.candidate3),
            };
          }
          return null;
        })
      )
    );

    for (const result of synthResults) {
      if (result.status === 'fulfilled' && result.value) {
        synthesisResults.push(result.value);
        metrics.intelligenceSynthesized++;
      } else if (result.status === 'rejected') {
        const errMsg = `Error synthesizing intelligence: ${result.reason?.message || result.reason}`;
        console.error(`  ✗ ${errMsg}`);
        errors.push(errMsg);
      }
    }

    metrics.steps.intelligenceSynthesis = {
      status: 'completed',
      duration: Date.now() - stepStartTime6,
      synthesized: metrics.intelligenceSynthesized,
      results: synthesisResults
    };

    console.log(`\n  ✓ Step 6 complete: ${metrics.intelligenceSynthesized} intelligence reports synthesized\n`);

  } catch (err) {
    const errMsg = `STEP 6 Intelligence Synthesis failed: ${err.message}`;
    console.error(`✗ ${errMsg}`);
    errors.push(errMsg);
    metrics.steps.intelligenceSynthesis = { status: 'failed', error: errMsg, duration: Date.now() - stepStartTime6 };
  }

}

async function stagePdfGeneration(ctx) {
  const { clientConfig, errors, metrics, costTracker } = ctx;
  // ========================================================================
  // STEP 7: PDF GENERATION
  // ========================================================================
  // PDF generation gated by tier (Growth+ only) unless client config explicitly overrides
  // PDFs are generated on-demand from the dashboard now — skip batch generation
  const generatePdfs = false;
  const stepStartTime7 = Date.now();

  if (!generatePdfs) {
    console.log('[STEP 7] PDF Generation: SKIPPED (on-demand mode — PDFs generated when user downloads)\n');
    metrics.steps.pdfGeneration = {
      status: 'skipped',
      duration: 0,
      generated: 0,
      results: [],
      note: 'On-demand PDF mode: reports generated at download time via dashboard'
    };
  } else {
    console.log('[STEP 7] PDF Generation: Generating market snapshot reports...\n');

    try {
      const synthesisResults = metrics.steps.intelligenceSynthesis.results || [];
      const pdfResults = [];

      // Parallelize PDF generation (up to 5 concurrent PDFMonkey calls)
      const pdfLimit = pLimit(5);

      const pdfGenResults = await Promise.allSettled(
        synthesisResults.map(synthesis =>
          pdfLimit(async () => {
            console.log(`  Generating PDF for: ${synthesis.roleTitle} at ${synthesis.companyName}`);
            const pdfUrl = await generateReport(clientConfig, synthesis);
            costTracker.track('pdfmonkey', 1, null, `PDF: ${synthesis.roleTitle} at ${synthesis.companyName}`);
            if (pdfUrl) {
              console.log(`    ✓ PDF generated: ${pdfUrl}`);
              return { companyName: synthesis.companyName, roleTitle: synthesis.roleTitle, pdfUrl };
            }
            return null;
          })
        )
      );

      for (const result of pdfGenResults) {
        if (result.status === 'fulfilled' && result.value) {
          pdfResults.push(result.value);
          metrics.pdfGenerated++;
        } else if (result.status === 'rejected') {
          const errMsg = `Error generating PDF: ${result.reason?.message || result.reason}`;
          console.error(`  ✗ ${errMsg}`);
          errors.push(errMsg);
        }
      }

      metrics.steps.pdfGeneration = {
        status: 'completed',
        duration: Date.now() - stepStartTime7,
        generated: metrics.pdfGenerated,
        results: pdfResults
      };

      console.log(`\n  ✓ Step 7 complete: ${metrics.pdfGenerated} PDFs generated\n`);

    } catch (err) {
      const errMsg = `STEP 7 PDF Generation failed: ${err.message}`;
      console.error(`✗ ${errMsg}`);
      errors.push(errMsg);
      metrics.steps.pdfGeneration = { status: 'failed', error: errMsg, duration: Date.now() - stepStartTime7 };
    }
  } // end if (generatePdfs)

}

async function stageLeadRecords(ctx) {
  const { errors, recruiterRoleMap, metrics } = ctx;
  // ========================================================================
  // STEP 8: AIRTABLE WRITE
  // ========================================================================
  console.log('[STEP 8] Lead Records: Building lead records (Airtable skipped, Supabase in 8b)...\n');
  const stepStartTime8 = Date.now();
  const leadRecords = ctx.leadRecords; // consumed by stage 8b (Supabase write)

  try {
    const dedupedJobs = metrics.steps.deduplication.jobsList || [];

    // Get enrichment, candidate, and synthesis data for richer Airtable records
    const enrichedList = metrics.steps.companyEnrichment?.enrichedList || [];
    const allCandidates = metrics.steps.candidateScoring?.candidates || [];
    const synthesisResults = metrics.steps.intelligenceSynthesis?.results || [];
    const pdfResults = metrics.steps.pdfGeneration?.results || [];

    for (const job of dedupedJobs) {
      // Find matching enrichment data
      const enriched = enrichedList.find(e => e.jobData?.companyName === job.companyName);
      const company = enriched?.company || {};
      const contact = enriched?.contact || {};

      // Find matching synthesis data (has salary range, market intel, etc.)
      const synthesis = synthesisResults.find(s =>
        s.companyName === job.companyName && s.roleTitle === job.roleTitle
      ) || {};

      // Find matching PDF report
      const pdfReport = pdfResults.find(p =>
        p.companyName === job.companyName && p.roleTitle === job.roleTitle
      );

      // Find candidates for this role (matched by the role tag set during scoring)
      const roleCandidates = allCandidates.filter(c =>
        c._searchedRole === job.roleTitle
      );

      // Valid options for single-select fields in Airtable
      const validSeniority = ['IC', 'Manager', 'VP/C-Suite'];
      const validWorkArrangement = ['Remote', 'Hybrid', 'On-site'];
      const validStatus = ['New - Uncontacted', 'Contacted', 'Meeting Booked', 'Proposal Sent', 'Won', 'Lost', 'New Lead', 'Qualified'];

      const seniority = validSeniority.includes(job.roleSeniority) ? job.roleSeniority : null;
      const workArr = validWorkArrangement.includes(job.workArrangement) ? job.workArrangement : null;

      // Map to exact Airtable field names (from schema)
      // Uses synthesis data as fallback for fields that scrapers/Apollo may miss
      const record = {
        'Name': `${job.companyName || 'Unknown'} — ${job.roleTitle || 'Unknown'}`,
        'Company Name': job.companyName || '',
        'Role Title': job.roleTitle || '',
        'Location': job.location || '',
        'Source': job.source || '',
        'Job Posting URL': job.jobPostingUrl || '',
        // Job description from LinkedIn scrape — used for skill extraction in candidate matching
        'Job Description': job.jobDescriptionSummary || job.jobDescription || '',
        // Salary: prefer scraped data, fall back to AI-synthesized estimate
        'Salary Range': job.salary || synthesis.salaryRange || '',
        'Date Identified': new Date().toISOString().split('T')[0],
        // Industry: prefer Apollo data, fall back to job function from config
        'Industry': company.industry || job.roleFunction || '',
        'Company Headcount': company.headcount ? String(company.headcount) : '',
        'Years in Business': company.foundedYear ? String(new Date().getFullYear() - company.foundedYear) : '',
        // Market intelligence (from Claude synthesis)
        'Time to Fill Estimate': synthesis.timeToFill || '',
        'Role Change Drivers': synthesis.roleChangeDrivers || '',
        'Sales Talking Points': Array.isArray(synthesis.salesTalkingPoints) ? '• ' + synthesis.salesTalkingPoints.join('\n• ') : (synthesis.salesTalkingPoints || ''),
        'Candidate Pitch Points': Array.isArray(synthesis.candidatePitchPoints) ? '• ' + synthesis.candidatePitchPoints.join('\n• ') : (synthesis.candidatePitchPoints || ''),
        // Market intelligence narrative fields (for PDF reports)
        // These are Supabase-only fields — Airtable write is skipped so safe to include now.
        'Market Insight': synthesis.marketNarrative || '',
        'Competing Postings': synthesis.competingPostings || synthesis.activeCandidates || '',
        'Talent Availability': synthesis.talentAvailability || synthesis.supplyDemandSignal || '',
        'Scarcity Insight': synthesis.scarcityInsight || synthesis.hiringRiskFlag || '',
        'Competition Insight': synthesis.competitionInsight || '',
        'Speed Insight': synthesis.speedInsight || '',
        // Contact data (from PDL-first tiered waterfall)
        'Hiring Contact Name': contact.fullName || '',
        'Hiring Contact Title': contact.title || '',
        'Hiring Contact Email': contact.email || '',
        'Hiring Contact LinkedIn': contact.linkedinUrl || '',
        // Company domain (from Apollo enrichment) — fallback when contacts are empty
        'Company Domain': company.domain || '',
        // Contact data quality — map code values to Airtable single-select labels
        'Contact Quality': {
          verified: 'Verified',
          partial: 'Unverified',
          none: 'No Contact',
        }[contact.contactQuality || 'none'] || 'No Contact',
        // Candidate data (from PDL) — name, URL, headline, availability signal
        'Candidate 1 Name': roleCandidates[0]?.fullName || '',
        'Candidate 1 URL': roleCandidates[0]?.linkedinUrl || '',
        'Candidate 1 Headline': buildCandidateHeadline(roleCandidates[0]),
        'Candidate 1 Signal': roleCandidates[0]?.matchLabel || '',
        'Candidate 1 Match Score': synthesis.candidate1?.matchScore || null,
        'Candidate 2 Name': roleCandidates[1]?.fullName || '',
        'Candidate 2 URL': roleCandidates[1]?.linkedinUrl || '',
        'Candidate 2 Headline': buildCandidateHeadline(roleCandidates[1]),
        'Candidate 2 Signal': roleCandidates[1]?.matchLabel || '',
        'Candidate 2 Match Score': synthesis.candidate2?.matchScore || null,
        'Candidate 3 Name': roleCandidates[2]?.fullName || '',
        'Candidate 3 URL': roleCandidates[2]?.linkedinUrl || '',
        'Candidate 3 Headline': buildCandidateHeadline(roleCandidates[2]),
        'Candidate 3 Signal': roleCandidates[2]?.matchLabel || '',
        'Candidate 3 Match Score': synthesis.candidate3?.matchScore || null,
        // PDF report link
        'PDF Report Link': pdfReport?.pdfUrl || '',
      };

      // Compute projected placement fee (20% of median salary)
      const salaryStr = record['Salary Range'] || '';
      const salaryNums = salaryStr.match(/[\d,]+/g);
      if (salaryNums && salaryNums.length > 0) {
        const salaryValues = salaryNums.map(n => parseInt(n.replace(/,/g, '')));
        const median = salaryValues.reduce((a, b) => a + b, 0) / salaryValues.length;
        if (median > 10000) { // sanity check — ignore tiny numbers that aren't salaries
          record['Projected Fee'] = Math.round(median * 0.2);
        }
      }

      // Add numeric fields separately (Airtable expects numbers, not strings)
      if (synthesis.activeCandidates) record['Active Candidates'] = Number(synthesis.activeCandidates);
      if (synthesis.passiveCandidates) record['Passive Candidates'] = Number(synthesis.passiveCandidates);

      // Remove empty string values to avoid Airtable validation issues
      const cleanRecord = {};
      for (const [key, value] of Object.entries(record)) {
        if (value !== '' && value !== null && value !== undefined) {
          cleanRecord[key] = value;
        }
      }

      // Add validated single-select fields (only if they match valid options)
      cleanRecord['Status'] = 'New Lead';
      if (seniority) cleanRecord['Seniority Tier'] = seniority;
      if (workArr) cleanRecord['Work Arrangement'] = workArr;

      // Pre-assign to recruiter if role matches (so Supabase write includes assignment)
      if (Object.keys(recruiterRoleMap).length > 0) {
        const roleKey = (job.roleTitle || '').toLowerCase();
        for (const [configRole, userIds] of Object.entries(recruiterRoleMap)) {
          if (roleKey.includes(configRole) || configRole.includes(roleKey)) {
            cleanRecord['Assigned To User ID'] = userIds[0];
            break;
          }
        }
      }

      leadRecords.push(cleanRecord);
    }

    // Airtable write SKIPPED — Supabase is the sole data store (Step 8b).
    // Airtable was causing write failures due to field name mismatches and is being deprecated.
    // leadRecords are still built above because Step 8b (Supabase write) uses them.
    console.log(`  ⊘ Airtable write skipped (deprecated) — ${leadRecords.length} records ready for Supabase\n`);
    metrics.steps.airtableWrite = {
      status: 'skipped',
      duration: Date.now() - stepStartTime8,
      recordsWritten: 0,
      note: 'Airtable deprecated — Supabase is sole data store'
    };

  } catch (err) {
    const errMsg = `STEP 8 Airtable Write failed: ${err.message}`;
    console.error(`✗ ${errMsg}`);
    errors.push(errMsg);
    metrics.steps.airtableWrite = { status: 'failed', error: errMsg, duration: Date.now() - stepStartTime8 };
  }

}

async function stageSupabaseWrite(ctx) {
  const { clientConfig, errors, metrics } = ctx;
  const leadRecords = ctx.leadRecords;
  // ========================================================================
  // STEP 8b: SUPABASE WRITE (mirrors leads to portal database)
  // ========================================================================
  const stepStartTime8b = Date.now();

  try {
    if (isSupabaseWriterConfigured()) {
      console.log('[STEP 8b] Supabase Write: Mirroring leads to portal database...\n');

      const airtableResults = metrics.steps.airtableWrite?.results || [];
      const supabaseResult = await writeLeadsToSupabase(
        clientConfig.clientId,
        leadRecords,
        airtableResults
      );

      metrics.supabaseLeadsWritten = supabaseResult.written;
      metrics.steps.supabaseWrite = {
        status: 'completed',
        duration: Date.now() - stepStartTime8b,
        recordsWritten: supabaseResult.written,
        errors: supabaseResult.errors
      };

      console.log(`  ✓ Step 8b complete: ${supabaseResult.written} leads mirrored to Supabase\n`);
    } else {
      console.log('[STEP 8b] Supabase Write: SKIPPED (SUPABASE_SERVICE_ROLE_KEY not set)\n');
      metrics.steps.supabaseWrite = { status: 'skipped', duration: 0, note: 'No service role key' };
    }
  } catch (err) {
    const errMsg = `STEP 8b Supabase Write failed: ${err.message}`;
    console.error(`✗ ${errMsg}`);
    errors.push(errMsg);
    metrics.steps.supabaseWrite = { status: 'failed', error: errMsg, duration: Date.now() - stepStartTime8b };
  }

}

async function stageAutoAssign(ctx) {
  const { clientConfig, errors, recruiterConfigs, todayKey, metrics, SUPABASE_URL_RC, SUPABASE_KEY_RC } = ctx;
  // ========================================================================
  // STEP 8c: AUTO-ASSIGN LEADS TO RECRUITERS
  //
  // Routes each unassigned lead to a recruiter based on the client's
  // assignment_mode:
  //   - 'legacy'   → first-match-wins (original behavior, kept for safety)
  //   - 'weighted' → assignment-engine.js scoring: role + location +
  //                  schedule + load balancing, with audit log to
  //                  lead_assignments and optional fallback user for
  //                  unmatched leads.
  // ========================================================================
  if (recruiterConfigs.length > 0 && SUPABASE_URL_RC && SUPABASE_KEY_RC) {
    const assignmentMode = clientConfig.assignmentMode || 'legacy';
    console.log(`[STEP 8c] Auto-Assign: mode=${assignmentMode}, assigning unassigned leads to recruiters...\n`);
    const stepStartTime8c = Date.now();
    try {
      const { createClient } = require('@supabase/supabase-js');
      const { assignLeads, assignLeadsLegacy } = require('./assignment-engine');
      const supabase = createClient(SUPABASE_URL_RC, SUPABASE_KEY_RC);

      // Fetch today's unassigned leads for this client (include location for weighted engine)
      const { data: unassigned } = await supabase
        .from('leads')
        .select('id, role_title, location')
        .eq('client_id', clientConfig.clientId)
        .is('assigned_to_user_id', null)
        .eq('status', 'New');

      let assigned = 0;
      let fallbackCount = 0;
      let unmatchedCount = 0;
      const auditRows = [];

      if (unassigned && unassigned.length > 0) {
        // Read existing load counts for today so mid-day re-runs stay balanced.
        // We only count leads assigned TODAY — yesterday's load doesn't influence
        // today's distribution.
        const todayISO = new Date().toISOString().slice(0, 10);
        const existingLoads = new Map();
        const { data: todaysAssigned } = await supabase
          .from('leads')
          .select('assigned_to_user_id')
          .eq('client_id', clientConfig.clientId)
          .not('assigned_to_user_id', 'is', null)
          .eq('date_identified', todayISO);
        if (todaysAssigned) {
          for (const row of todaysAssigned) {
            const uid = row.assigned_to_user_id;
            existingLoads.set(uid, (existingLoads.get(uid) || 0) + 1);
          }
        }

        // Run the chosen engine
        const results = assignmentMode === 'weighted'
          ? assignLeads(unassigned, recruiterConfigs, {
              today: todayKey,
              weights: clientConfig.assignmentWeights || undefined,
              fallbackUserId: clientConfig.assignmentFallbackUserId || undefined,
              existingLoads,
            })
          : assignLeadsLegacy(unassigned, recruiterConfigs);

        // Apply assignments + build audit rows
        for (const r of results) {
          if (r.userId) {
            await supabase
              .from('leads')
              .update({ assigned_to_user_id: r.userId })
              .eq('id', r.leadId);
            if (r.matched) assigned++;
            else fallbackCount++;
          } else {
            unmatchedCount++;
          }

          auditRows.push({
            lead_id: r.leadId,
            client_id: clientConfig.clientId,
            user_id: r.userId,
            score: r.score,
            matched: r.matched,
            mode: r.userId
              ? (r.matched ? assignmentMode : 'fallback')
              : 'unmatched',
            reason: r.reason,
          });
        }

        // Batch-write audit rows. Failure here must not block pipeline — the
        // assignments themselves already succeeded, the audit log is advisory.
        if (auditRows.length > 0) {
          try {
            const { error: auditErr } = await supabase
              .from('lead_assignments')
              .insert(auditRows);
            if (auditErr) {
              console.warn(`  ⚠ lead_assignments audit write failed: ${auditErr.message}`);
            }
          } catch (auditCatch) {
            console.warn(`  ⚠ lead_assignments audit write threw: ${auditCatch.message}`);
          }
        }
      }

      metrics.steps.autoAssign = {
        status: 'completed',
        mode: assignmentMode,
        duration: Date.now() - stepStartTime8c,
        leadsAssigned: assigned,
        leadsFallback: fallbackCount,
        leadsUnmatched: unmatchedCount,
        unassignedChecked: unassigned?.length || 0,
      };
      console.log(
        `  ✓ Auto-assigned ${assigned}/${unassigned?.length || 0} leads ` +
        `(fallback: ${fallbackCount}, unmatched: ${unmatchedCount}, mode: ${assignmentMode})\n`
      );
    } catch (err) {
      const errMsg = `STEP 8c Auto-Assign failed: ${err.message}`;
      console.error(`✗ ${errMsg}`);
      errors.push(errMsg);
      metrics.steps.autoAssign = { status: 'failed', error: errMsg, duration: Date.now() - stepStartTime8c };
    }
  }

}

async function stageDigestDeferral(ctx) {
  const { metrics } = ctx;
  // ========================================================================
  // STEP 9: SEND DIGEST EMAIL (per-recruiter if configs exist)
  // ========================================================================
  // ---- STEP 9: DIGEST EMAIL — SKIPPED (handled by send-digest.js on separate cron) ----
  // Digest delivery is decoupled from pipeline execution.
  // Pipeline runs at 2am EDT, digest emails are sent at 7am EDT by send-digest.js.
  // This ensures leads are ready hours before the email lands.
  // To send digest immediately after pipeline (old behavior), run: node send-digest.js
  console.log('[STEP 9] Digest Email: SKIPPED — handled by send-digest.js (7am EDT cron)\n');
  metrics.digestSent = false;
  metrics.steps.digestEmail = { status: 'deferred', note: 'Handled by send-digest.js on separate schedule' };

}

async function stageRunSummary(ctx) {
  const { runStartTime, errors, metrics, costTracker } = ctx;
  // ========================================================================
  // STEP 10: RUN SUMMARY
  // ========================================================================
  console.log('[STEP 10] Run Summary: Building run summary and notifying ops...\n');
  const stepStartTime10 = Date.now();

  try {
    metrics.endTime = new Date().toISOString();
    metrics.totalDuration = Date.now() - runStartTime.getTime();
    metrics.errors = errors;

    console.log(`  Run summary metrics:`);
    console.log(`    Jobs Discovered: ${metrics.jobsDiscovered}`);
    console.log(`    Companies Deduped: ${metrics.companiesDeduped}`);
    console.log(`    Markets Analyzed: ${metrics.marketsAnalyzed}`);
    console.log(`    Companies Enriched: ${metrics.companiesEnriched}`);
    console.log(`    Candidates Scored: ${metrics.candidatesScored}`);
    console.log(`    Intelligence Synthesized: ${metrics.intelligenceSynthesized}`);
    console.log(`    PDFs Generated: ${metrics.pdfGenerated}`);
    console.log(`    Leads Written: ${metrics.leadsWritten}`);
    console.log(`    Digest Sent: ${metrics.digestSent ? 'Yes' : 'No'}`);
    console.log(`    Total Duration: ${(metrics.totalDuration / 1000).toFixed(2)}s`);
    console.log(`    Errors Encountered: ${errors.length}\n`);

    // Send run summary to ops
    try {
      await sendRunSummaryToOps(metrics);
      costTracker.track('resend', 1, 0, 'Ops summary email');
      console.log(`  ✓ Run summary sent to ops\n`);
    } catch (opErr) {
      console.warn(`  ! Failed to send ops summary: ${opErr.message}\n`);
    }

    // Flush all tracked costs to Supabase (api_usage + pipeline_runs)
    try {
      await costTracker.flush(metrics);
      console.log(`  ✓ Costs flushed to Supabase\n`);
    } catch (costErr) {
      console.warn(`  ! Failed to flush costs: ${costErr.message}\n`);
    }

    metrics.steps.runSummary = {
      status: 'completed',
      duration: Date.now() - stepStartTime10
    };

  } catch (err) {
    const errMsg = `STEP 10 Run Summary failed: ${err.message}`;
    console.error(`✗ ${errMsg}`);
    errors.push(errMsg);
    metrics.steps.runSummary = { status: 'failed', error: errMsg, duration: Date.now() - stepStartTime10 };
  }
}

/**
 * The ten stages (with sub-stages) in run order. Each takes the run context.
 */
const STAGES = [
  stageJobDiscovery,            // 1
  stageDeduplication,           // 2 (+2b: skip leads seen in the last 7 days)
  stageMarketContext,           // 3
  stageCompanyEnrichment,       // 4 (+ contact waterfall)
  stageStaffingAgencyFilter,    // 4b
  stageCandidateScoring,        // 5
  stageIntelligenceSynthesis,   // 6
  stagePdfGeneration,           // 7
  stageLeadRecords,             // 8
  stageSupabaseWrite,           // 8b
  stageAutoAssign,              // 8c
  stageDigestDeferral,          // 9 (send-digest.js, separate cron)
  stageRunSummary,              // 10
];

/**
 * Main Kurrent Pipeline Orchestration — runs the stages in order.
 * @param {Object} clientConfig - Client configuration object
 * @param {Object} [options] - { testMode }
 * @returns {Promise<Object>} Run summary with metrics
 */
async function runPipeline(clientConfig, options = {}) {
  const ctx = await createRunContext(clientConfig, options);
  const { metrics, errors, costTracker, runStartTime } = ctx;

  try {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`START: Kurrent Pipeline starting for ${clientConfig.agencyName} — ${runStartTime.toISOString()}`);
    console.log(`${'='.repeat(80)}\n`);

    for (const stage of STAGES) {
      await stage(ctx);
    }


    // Prune expired candidate cache entries (housekeeping)
    try {
      await pruneCandidateCache();
    } catch (pruneErr) {
      console.warn(`[CandidateCache] Prune failed (non-fatal): ${pruneErr.message}`);
    }

    // Log final summary
    console.log(`${'='.repeat(80)}`);
    console.log(`COMPLETE: Kurrent Pipeline finished for ${clientConfig.agencyName}`);
    console.log(`${'='.repeat(80)}`);
    // Log compact summary only — full JSON.stringify with pretty-print exceeded Railway's 500 logs/sec limit
    console.log(`Metrics: jobs=${metrics.jobsDiscovered}, unique=${metrics.uniqueJobs}, new=${metrics.newLeads}, candidates=${metrics.candidatesScored}, errors=${errors.length}, duration=${(metrics.totalDuration / 1000).toFixed(0)}s`);

    return metrics;

  } catch (err) {
    console.error(`\n${'!'.repeat(80)}`);
    console.error(`PIPELINE FAILED: ${err.message}`);
    console.error(`${'!'.repeat(80)}\n`);

    metrics.endTime = new Date().toISOString();
    metrics.totalDuration = Date.now() - runStartTime.getTime();
    metrics.errors = [...errors, err.message];

    // Still flush costs on failure so we don't lose spend data
    try {
      await costTracker.flush(metrics);
    } catch (flushErr) {
      console.error(`[COST-TRACKER] Failed to flush on pipeline error: ${flushErr.message}`);
    }

    throw {
      metrics,
      error: err.message
    };
  }
}

/**
 * Schedule pipeline to run daily at specified time
 * @param {Object} clientConfig - Client configuration
 */
function schedulePipeline(clientConfig) {
  const timezone = clientConfig.timezone || 'America/Toronto';
  const digestTime = clientConfig.digestSendTime || '07:00';
  const [hour, minute] = digestTime.split(':');

  // Convert to cron expression (minute hour * * *)
  const cronExpression = `${minute} ${hour} * * *`;

  console.log(`\n[SCHEDULER] Kurrent Pipeline scheduled for daily execution`);
  console.log(`  Time: ${digestTime} ${timezone}`);
  console.log(`  Cron: ${cronExpression}`);
  console.log(`  To run immediately, execute: node run-now.js\n`);

  // Schedule the pipeline
  const task = cron.schedule(cronExpression, async () => {
    console.log(`\n[SCHEDULER] Executing scheduled pipeline run at ${new Date().toISOString()}`);
    try {
      await runPipeline(clientConfig);
    } catch (err) {
      console.error(`[SCHEDULER] Pipeline execution failed:`, err);
    }
  }, {
    timezone: timezone
  });

  console.log(`[SCHEDULER] Cron task created. Process will stay running to execute scheduled tasks.`);

  return task;
}

// Export functions
module.exports = {
  STAGES,
  createRunContext,
  runPipeline,
  schedulePipeline,
  TIER_CONFIG,
};

// If this file is run directly as the main module, schedule the pipeline
if (require.main === module) {
  try {
    const clientConfig = require('./client-config.json');
    schedulePipeline(clientConfig);

    // Keep process alive for scheduled tasks
    process.on('SIGINT', () => {
      console.log('\n[SCHEDULER] Shutting down gracefully...');
      process.exit(0);
    });

  } catch (err) {
    console.error('Failed to load client config:', err.message);
    process.exit(1);
  }
}
