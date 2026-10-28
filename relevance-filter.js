/**
 * Kurrent Relevance Filter
 * Filters scraped job results to ensure they match target roles.
 * Maintains a configurable blocklist/allowlist that gets tuned over time
 * by the scheduled relevance-tuner task.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'relevance-config.json');

// Default config — the scheduled tuner updates this file over time
const DEFAULT_CONFIG = {
  // Known irrelevant job titles that should always be filtered out
  blockedTitles: [
    'phlebotomist', 'nurse', 'registered nurse', 'lpn', 'rn',
    'medical assistant', 'dental hygienist', 'pharmacy technician',
    'lab technician', 'radiologist', 'sonographer', 'emt', 'paramedic',
    'custodian', 'janitor', 'security guard', 'forklift operator',
    'warehouse associate', 'delivery driver', 'truck driver',
    'barista', 'cashier', 'server', 'cook', 'dishwasher'
  ],

  // Known good title variations for each target role
  allowedVariations: {
    'Legal Assistant': [
      'legal assistant', 'legal administrative assistant', 'legal secretary',
      'litigation assistant', 'corporate legal assistant', 'legal clerk',
      'law clerk', 'legal support specialist', 'legal coordinator'
    ],
    'Paralegal': [
      'paralegal', 'litigation paralegal', 'corporate paralegal',
      'real estate paralegal', 'immigration paralegal', 'paralegal specialist',
      'senior paralegal', 'junior paralegal', 'paralegal assistant'
    ],
    'Bookkeeper': [
      'bookkeeper', 'full charge bookkeeper', 'staff bookkeeper',
      'accounts payable clerk', 'accounts receivable clerk',
      'accounting clerk', 'bookkeeping clerk', 'payroll clerk',
      'billing clerk', 'billing specialist'
    ],
    'Accountant': [
      'accountant', 'staff accountant', 'junior accountant', 'senior accountant',
      'accounting manager', 'accounts payable', 'accounts receivable',
      'tax accountant', 'cost accountant', 'financial accountant',
      'accounting specialist', 'accounting supervisor', 'controller',
      'assistant controller', 'accounting analyst', 'cpa'
    ]
  },

  // Minimum similarity score (0-1) for fuzzy matching when title isn't in allow/block lists
  minimumSimilarityScore: 0.35,

  // Track filtering stats for the tuner to review
  stats: {
    lastUpdated: null,
    totalFiltered: 0,
    totalPassed: 0,
    recentlyBlocked: [],
    recentlyAllowed: []
  }
};

/**
 * Load relevance config from disk, or create default
 */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('[relevance-filter] Could not load config, using defaults:', err.message);
  }
  // Write default config to disk
  saveConfig(DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

/**
 * Save relevance config to disk
 */
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (err) {
    console.warn('[relevance-filter] Could not save config:', err.message);
  }
}

/**
 * Simple word-overlap similarity between two strings (Jaccard-ish)
 * Returns 0-1 score
 */
function titleSimilarity(scrapedTitle, targetRole) {
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  const wordsA = new Set(normalize(scrapedTitle));
  const wordsB = new Set(normalize(targetRole));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  // Weighted: how much of the target role appears in the scraped title
  const recall = intersection / wordsB.size;
  // How much of the scraped title is relevant
  const precision = intersection / wordsA.size;

  // F1-like score weighted toward recall (we care more that the target words appear)
  if (recall + precision === 0) return 0;
  return (1.5 * recall * precision) / (0.5 * recall + precision);
}

/**
 * Check if a scraped job title is relevant to the target role
 * @param {string} scrapedTitle - The job title from LinkedIn
 * @param {string} targetRole - The role we were searching for
 * @param {Object} config - Relevance config (optional, will load from disk)
 * @returns {{ relevant: boolean, reason: string, score: number }}
 */
function isRelevant(scrapedTitle, targetRole, config = null) {
  if (!config) config = loadConfig();

  const scrapedLower = scrapedTitle.toLowerCase().trim();
  const targetLower = targetRole.toLowerCase().trim();

  // Check blocklist first
  for (const blocked of config.blockedTitles) {
    if (scrapedLower.includes(blocked) || blocked.includes(scrapedLower)) {
      return { relevant: false, reason: `blocked: matches "${blocked}"`, score: 0 };
    }
  }

  // Check allowlist
  const variations = config.allowedVariations[targetRole] || [];
  for (const allowed of variations) {
    if (scrapedLower.includes(allowed) || allowed.includes(scrapedLower)) {
      return { relevant: true, reason: `allowed: matches "${allowed}"`, score: 1.0 };
    }
  }

  // Exact or substring match on target role
  if (scrapedLower.includes(targetLower) || targetLower.includes(scrapedLower)) {
    return { relevant: true, reason: 'direct match with target role', score: 1.0 };
  }

  // Fuzzy similarity check
  const score = titleSimilarity(scrapedTitle, targetRole);
  if (score >= config.minimumSimilarityScore) {
    return { relevant: true, reason: `fuzzy match (score: ${score.toFixed(2)})`, score };
  }

  return { relevant: false, reason: `low relevance (score: ${score.toFixed(2)})`, score };
}

/**
 * Filter an array of scraped jobs, keeping only relevant ones
 * @param {Array} jobs - Array of job objects with jobTitle field
 * @param {string} targetRole - The role we were searching for
 * @returns {{ kept: Array, filtered: Array }}
 */
function filterJobs(jobs, targetRole) {
  const config = loadConfig();
  const kept = [];
  const filtered = [];

  for (const job of jobs) {
    const title = job.jobTitle || job.title || '';
    const result = isRelevant(title, targetRole, config);

    if (result.relevant) {
      kept.push({ ...job, relevanceScore: result.score, relevanceReason: result.reason });
      console.log(`  [relevance-filter] ✓ Kept: "${title}" at "${job.companyName || 'Unknown'}" (${result.reason})`);
    } else {
      filtered.push({ ...job, relevanceScore: result.score, relevanceReason: result.reason });
      console.log(`  [relevance-filter] Filtered out: "${title}" (${result.reason})`);
    }
  }

  // Update stats
  config.stats.totalPassed += kept.length;
  config.stats.totalFiltered += filtered.length;
  config.stats.lastUpdated = new Date().toISOString();

  // Track recently blocked titles (keep last 50)
  const newBlocked = filtered.map(j => j.jobTitle || j.title || 'unknown');
  config.stats.recentlyBlocked = [...newBlocked, ...(config.stats.recentlyBlocked || [])].slice(0, 50);
  config.stats.recentlyAllowed = [...kept.map(j => j.jobTitle || j.title), ...(config.stats.recentlyAllowed || [])].slice(0, 50);

  saveConfig(config);

  console.log(`  [relevance-filter] ${kept.length} relevant, ${filtered.length} filtered out of ${jobs.length} total for "${targetRole}"`);
  return { kept, filtered };
}

// ============================================================
// COMPANY-LEVEL FILTERING (Staffing Agency Detection)
// ============================================================

/**
 * Industries returned by Apollo that indicate staffing/recruitment agencies.
 * These are competitors to Kurrent's clients, not prospects.
 */
const BLOCKED_INDUSTRIES = [
  'staffing and recruiting',
  'staffing & recruiting',
  'personnel supply services',
  'recruiting & executive search',
  'temporary help services',
  'employment services',
  'human resources services',
  'employment placement agencies',
  'temporary staffing',
  'professional employer organizations',
];

/**
 * Company name keywords that strongly indicate a staffing agency,
 * even if Apollo doesn't classify the industry correctly.
 */
const STAFFING_COMPANY_KEYWORDS = [
  'staffing', 'recruiting', 'recruitment', 'temp agency',
  'employment agency', 'talent solutions', 'workforce solutions',
  'manpower', 'adecco', 'randstad', 'robert half', 'kelly services',
  'hays', 'expresspro', 'aerotek', 'insight global', 'teksystems',
  'beacon hill', 'kforce', 'spherion',
];

/**
 * Posting language patterns that indicate a staffing agency posting
 * on behalf of their client (not a direct employer posting).
 */
const STAFFING_POSTING_KEYWORDS = [
  'on behalf of our client',
  'on behalf of a client',
  'our client is seeking',
  'our client is looking',
  'contract to hire',
  'contract-to-hire',
  'temp to perm',
  'temp-to-perm',
  'temporary to permanent',
];

/**
 * Check if a company is a staffing agency based on enrichment data.
 * Run AFTER Apollo enrichment (Step 4) — uses industry + company name + description.
 *
 * @param {Object} enrichedCompany - { company, contact, jobData }
 * @param {string[]} clientExclusions - Client-specific company names to exclude
 * @returns {{ isStaffingAgency: boolean, reason: string }}
 */
function isStaffingAgency(enrichedCompany, clientExclusions = []) {
  const company = enrichedCompany.company || {};
  const job = enrichedCompany.jobData || {};

  const companyName = (company.companyName || job.companyName || '').toLowerCase();
  const industry = (company.industry || '').toLowerCase();
  const description = (company.shortDescription || '').toLowerCase();
  const jobSummary = (job.jobDescriptionSummary || job.snippet || '').toLowerCase();

  // Check 1: Apollo industry tag (exact or industry contains blocked term — NOT reverse)
  for (const blocked of BLOCKED_INDUSTRIES) {
    if (industry === blocked || industry.includes(blocked)) {
      return { isStaffingAgency: true, reason: `industry: "${company.industry}"` };
    }
  }

  // Check 2: Company name keywords
  for (const keyword of STAFFING_COMPANY_KEYWORDS) {
    if (companyName.includes(keyword)) {
      return { isStaffingAgency: true, reason: `company name contains "${keyword}"` };
    }
  }

  // Check 3: Client-specific exclusion list
  for (const excluded of clientExclusions) {
    if (companyName === excluded.toLowerCase()) {
      return { isStaffingAgency: true, reason: `client exclusion list: "${excluded}"` };
    }
  }

  // Check 4: Company description mentions staffing
  if (description) {
    const staffingDescIndicators = ['staffing agency', 'recruitment agency', 'employment agency', 'staffing firm', 'staffing company', 'recruiting firm', 'temporary staffing', 'contract staffing'];
    for (const indicator of staffingDescIndicators) {
      if (description.includes(indicator)) {
        return { isStaffingAgency: true, reason: `description mentions "${indicator}"` };
      }
    }
  }

  // Check 5: Job posting language ("on behalf of our client")
  if (jobSummary) {
    for (const pattern of STAFFING_POSTING_KEYWORDS) {
      if (jobSummary.includes(pattern)) {
        return { isStaffingAgency: true, reason: `posting language: "${pattern}"` };
      }
    }
  }

  return { isStaffingAgency: false, reason: 'passed all checks' };
}

/**
 * Filter out staffing agencies from enriched companies list.
 * Called after Step 4, before Step 5/6.
 *
 * @param {Array} enrichedCompanies - Array of { company, contact, jobData }
 * @param {string[]} clientExclusions - Client-specific exclusions
 * @returns {{ kept: Array, filtered: Array }}
 */
function filterStaffingAgencies(enrichedCompanies, clientExclusions = []) {
  const kept = [];
  const filtered = [];

  for (const entry of enrichedCompanies) {
    const result = isStaffingAgency(entry, clientExclusions);
    if (result.isStaffingAgency) {
      filtered.push({ ...entry, staffingFilterReason: result.reason });
      console.log(`  [staffing-filter] ✗ Filtered: "${entry.company?.companyName || entry.jobData?.companyName}" — ${result.reason}`);
    } else {
      kept.push(entry);
    }
  }

  console.log(`  [staffing-filter] ${kept.length} kept, ${filtered.length} staffing agencies filtered from ${enrichedCompanies.length} total`);
  return { kept, filtered };
}

module.exports = {
  isRelevant,
  filterJobs,
  loadConfig,
  saveConfig,
  titleSimilarity,
  isStaffingAgency,
  filterStaffingAgencies,
  BLOCKED_INDUSTRIES,
  STAFFING_COMPANY_KEYWORDS,
};
