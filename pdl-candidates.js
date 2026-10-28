const config = require('./security/config-loader');
const axios = require('axios');

const PDL_BASE_URL = 'https://api.peopledatalabs.com/v5';
const PDL_API_KEY = config.get('PDL_API_KEY');

if (!PDL_API_KEY) {
  console.error('ERROR: PDL_API_KEY not found in environment variables');
}

/**
 * Extract core functional keywords from a job posting title.
 * Strips seniority prefixes, level indicators, and noise words to produce
 * the 1-3 keywords that actually describe the function.
 *
 * Examples:
 *   "director, product manager"  → ["product", "manager"]
 *   "Senior DevOps Engineer"     → ["devops", "engineer"]
 *   "HR Business Partner"        → ["hr", "business", "partner"]
 *   "Technical Project Manager"  → ["project", "manager"]
 *   "senior product manager"     → ["product", "manager"]
 *   "Executive Assistant"        → ["executive", "assistant"]
 *   "Financial Analyst"          → ["financial", "analyst"]
 *   "Marketing Coordinator"      → ["marketing", "coordinator"]
 *   "Pharmacy Technician"        → ["pharmacy", "technician"]
 *   "Network Engineer"           → ["network", "engineer"]
 */
function extractRoleKeywords(roleTitle) {
  // Normalize: lowercase, remove commas and extra whitespace
  let title = roleTitle.toLowerCase().replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim();

  // Words that indicate seniority/level but not the actual function
  const seniorityWords = new Set([
    'senior', 'junior', 'lead', 'principal', 'staff', 'chief',
    'head', 'vp', 'director', 'associate', 'intern', 'entry',
    'intermediate', 'mid', 'level', 'i', 'ii', 'iii', 'iv', 'v',
    'of', 'the', 'a', 'an', 'and', 'or', 'in', 'for',
  ]);

  // Words like "technical", "executive", "clinical", "digital" are NOT seniority —
  // they're functional qualifiers that fundamentally change the role.
  // "Technical Project Manager" ≠ "Project Manager"
  // "Executive Assistant" ≠ "Assistant"
  // "Clinical Pharmacist" ≠ "Pharmacist"
  // These MUST be kept as search keywords.

  const words = title.split(' ').filter(w => w.length > 0);

  // Remove pure seniority/noise words only
  let functional = words.filter(w => !seniorityWords.has(w));

  // If we stripped everything (shouldn't happen), fall back to original minus basic noise
  if (functional.length === 0) {
    functional = words.filter(w => w.length > 2);
  }

  // Cap at 3 keywords to keep the query from being too restrictive
  // but use at least 1 to avoid matching everyone
  return functional.slice(0, 3);
}

/**
 * Find candidates matching role title, location, and seniority level
 * @param {string} roleTitle - Job title to search for
 * @param {string} location - Location to search in
 * @param {string} seniorityLevel - One of: entry, mid, senior, manager, director, vp, executive
 * @param {number} maxResults - Maximum results to return (default 5)
 * @param {string[]} [skillKeywords] - Optional skill keywords extracted from job description
 * @returns {Promise<Array>} Array of candidate objects
 */
async function findCandidates(roleTitle, location, seniorityLevel, maxResults = 5, skillKeywords = []) {
  try {
    // Consolidated log at end of search — removed per-step logging to stay under Railway's 500 logs/sec limit

    if (!PDL_API_KEY) {
      throw new Error('PDL_API_KEY environment variable is not set');
    }

    // Map Kurrent tiers to PDL seniority values
    // Kurrent uses: IC, Manager, VP/C-Suite
    // PDL accepts: entry, mid, senior, manager, director, vp, executive
    const kurrentToPdlMap = {
      'ic':         ['entry', 'mid', 'senior'],
      'entry':      ['entry'],
      'mid':        ['mid'],
      'senior':     ['senior'],
      'manager':    ['manager', 'director'],
      'director':   ['director'],
      'vp':         ['vp'],
      'executive':  ['executive'],
      'vp/c-suite': ['vp', 'executive']
    };

    const pdlSeniorities = kurrentToPdlMap[seniorityLevel.toLowerCase()];
    if (!pdlSeniorities) {
      console.warn(`[PDL] Unknown seniority level: "${seniorityLevel}", defaulting to mid`);
    }
    const seniorityValues = pdlSeniorities || ['mid'];

    // Build PDL search query using SQL format
    const seniorityClause = seniorityValues.map(s => `'${s}'`).join(', ');
    const locationParts = location.split(/[\s,]+/);
    const cityName = locationParts[0]; // e.g. "Toronto" from "Toronto Ontario Canada"

    // Extract core role keywords for flexible matching.
    // Job posting titles like "director, product manager" or "Senior DevOps Engineer"
    // don't match how people describe their own titles on LinkedIn.
    // Strategy: strip seniority/level prefixes, extract the functional keywords,
    // and build a LIKE query that matches any title containing those keywords.
    const roleKeywords = extractRoleKeywords(roleTitle);
    // Build title clause: each keyword must appear in the job_title
    const titleClauses = roleKeywords.map(kw => `job_title LIKE '%${kw}%'`).join(' AND ');

    // Build skills clause if we have skill keywords from job description extraction.
    // PDL's `skills` field is an array — use ANY match (OR) so we broaden the pool.
    let skillsClause = '';
    const usedSkills = [];
    if (skillKeywords && skillKeywords.length > 0) {
      const topSkills = skillKeywords.slice(0, 5);
      const skillValues = topSkills.map(s => `'${s.replace(/'/g, "''")}'`).join(', ');
      skillsClause = ` AND skills IN (${skillValues})`;
      usedSkills.push(...topSkills);
    }

    // Use location_metro for broader, more reliable geographic matching
    // PDL's location_metro covers metro areas (e.g., "greater toronto area")
    const metroMap = {
      toronto: 'greater toronto area',
      vancouver: 'greater vancouver',
      calgary: 'calgary, alberta',
      montreal: 'greater montreal area',
      ottawa: 'ottawa-gatineau',
    };
    const metroName = metroMap[cityName.toLowerCase()] || null;
    const locationClause = metroName
      ? `location_metro='${metroName}'`
      : `location_locality='${cityName.toLowerCase()}'`;

    const sqlQuery = `SELECT * FROM person WHERE ${titleClauses} AND ${locationClause} AND job_title_levels IN (${seniorityClause})${skillsClause}`;

    console.log(`[PDL] Search: "${roleTitle}" in ${cityName} | keywords: ${roleKeywords.join('+')}${usedSkills.length ? ' | skills: ' + usedSkills.join(', ') : ''}`);

    const payload = {
      sql: sqlQuery,
      size: Math.min(maxResults, 100),
      pretty: true
    };

    const response = await axios.post(
      `${PDL_BASE_URL}/person/search`,
      payload,
      {
        headers: {
          'X-Api-Key': PDL_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`[PDL] Found ${response.data.data.length} candidates for "${roleTitle}" in ${cityName}`);

    // Transform PDL response to our candidate format
    // PDL returns current job as top-level fields (job_title, job_company_name, job_start_date)
    // and full history in experience[] (NOT work_history which is always empty)
    const candidates = response.data.data.map(person => {
      const experience = person.experience || [];
      const currentExp = experience.find(e => e.is_primary) || experience[0] || null;
      const previousExp = experience.length > 1 ? experience.find(e => !e.is_primary) || experience[1] : null;

      // Use top-level job fields as primary source, experience[] as fallback
      const currentTitle = person.job_title || currentExp?.title?.name || 'Unknown';
      const currentCompany = person.job_company_name || currentExp?.company?.name || 'Unknown';
      const jobStartDate = person.job_start_date || currentExp?.start_date || null;

      // Calculate years of experience from current + previous roles
      let yearsExperience = 0;
      if (jobStartDate) {
        const startDate = new Date(jobStartDate);
        const now = new Date();
        yearsExperience = (now - startDate) / (1000 * 60 * 60 * 24 * 365.25);
      }
      if (previousExp && previousExp.start_date && previousExp.end_date) {
        const startDate = new Date(previousExp.start_date);
        const endDate = new Date(previousExp.end_date);
        yearsExperience += (endDate - startDate) / (1000 * 60 * 60 * 24 * 365.25);
      }

      // Calculate job change recency (months)
      let jobChangeRecency = null;
      if (jobStartDate) {
        const startDate = new Date(jobStartDate);
        const now = new Date();
        jobChangeRecency = Math.floor((now - startDate) / (1000 * 60 * 60 * 24 * 30.44));
      }

      // Determine availability signal
      let availabilitySignal = 'Unknown';
      if (jobChangeRecency !== null) {
        if (jobChangeRecency < 6) {
          availabilitySignal = 'Recently changed roles';
        } else if (jobChangeRecency > 36) {
          availabilitySignal = 'Stable — long tenure';
        }
      }

      // Get top skills (up to 5)
      const topSkills = (person.skills || []).slice(0, 5);

      // Location: PDL SQL can return booleans for location fields used in WHERE clause
      // Prefer experience[].company.location, then location_metro, then top-level fields
      let locationStr = 'Unknown';
      const expLocation = currentExp?.company?.location;
      if (expLocation && expLocation.name && typeof expLocation.name === 'string') {
        locationStr = expLocation.name;
      } else if (person.location_metro && typeof person.location_metro === 'string') {
        locationStr = person.location_metro;
      } else {
        const parts = [person.location_locality, person.location_region, person.location_country]
          .filter(v => typeof v === 'string' && v.length > 0);
        if (parts.length > 0) locationStr = parts.join(', ');
      }

      const candidate = {
        fullName: person.full_name || `${person.first_name || ''} ${person.last_name || ''}`.trim() || 'Unknown',
        currentTitle: currentTitle,
        currentCompany: currentCompany,
        location: locationStr,
        yearsExperience: Math.round(yearsExperience * 10) / 10,
        topSkills: topSkills,
        jobChangeRecency: jobChangeRecency,
        linkedinUrl: person.linkedin_url || null,
        availabilitySignal: availabilitySignal,
        _pdlId: person.id // Store for reference
      };

      return candidate;
    });

    // Strict post-query location filter — only keep candidates confirmed in target area.
    const targetCity = cityName.toLowerCase();
    const targetMetro = metroName || targetCity;
    const locationFiltered = candidates.filter(c => {
      if (!c.location || c.location === 'Unknown') return false;
      const loc = c.location.toLowerCase();
      return loc.includes(targetCity) || loc.includes(targetMetro);
    });

    if (locationFiltered.length < candidates.length) {
      console.log(`[PDL] Location filter: ${candidates.length} → ${locationFiltered.length} (kept ${targetCity} matches only)`);
    }

    return locationFiltered;

  } catch (error) {
    if (error.response?.status === 402) {
      console.warn('[PDL] ⚠ Credits exhausted (402 payment_required) — returning empty candidate list. Upgrade PDL plan or wait for credit reset.');
      return [];
    }
    console.error('[PDL] Error finding candidates:', error.message);
    if (error.response?.data) {
      console.error('[PDL] API Response:', JSON.stringify(error.response.data, null, 2));
    }
    return [];
  }
}

/**
 * Score and merge candidates from PDL and LinkedIn
 * @param {Array} pdlCandidates - Array of candidates from findCandidates
 * @param {Array} linkedinCandidates - Array of candidates from LinkedIn scraping
 * @returns {Array} Enriched array with match labels, sorted by match quality
 */
async function scoreCandidates(pdlCandidates = [], linkedinCandidates = []) {
  try {
    // Defensive: ensure we always have arrays (catch Promises, nulls, objects)
    if (!Array.isArray(pdlCandidates)) {
      console.warn(`[Score] pdlCandidates is not an array (got ${typeof pdlCandidates}), defaulting to []`);
      pdlCandidates = [];
    }
    if (!Array.isArray(linkedinCandidates)) {
      console.warn(`[Score] linkedinCandidates is not an array (got ${typeof linkedinCandidates}), defaulting to []`);
      linkedinCandidates = [];
    }
    console.log(`[Score] Scoring ${pdlCandidates.length} PDL and ${linkedinCandidates.length} LinkedIn candidates`);

    const merged = [];
    const linkedinUsed = new Set();

    // Process PDL candidates first
    pdlCandidates.forEach(pdlCandidate => {
      // Try to find matching LinkedIn candidate
      const liMatch = linkedinCandidates.find(li => {
        const nameSimilar = li.fullName && pdlCandidate.fullName &&
          li.fullName.toLowerCase().includes(pdlCandidate.fullName.split(' ')[0].toLowerCase()) &&
          li.fullName.toLowerCase().includes(pdlCandidate.fullName.split(' ').pop().toLowerCase());

        const companySimilar = (!li.currentCompany || !pdlCandidate.currentCompany) ||
          li.currentCompany.toLowerCase().includes(pdlCandidate.currentCompany.toLowerCase().split(' ')[0]) ||
          pdlCandidate.currentCompany.toLowerCase().includes(li.currentCompany.toLowerCase().split(' ')[0]);

        return nameSimilar && companySimilar;
      });

      let enriched = { ...pdlCandidate };

      if (liMatch) {
        linkedinUsed.add(linkedinCandidates.indexOf(liMatch));
        // Merge LinkedIn data
        enriched = {
          ...enriched,
          linkedinOpenToWork: liMatch.openToWork || false,
          linkedinProfileActivity: liMatch.recentProfileActivity || false,
          linkedinUrl: liMatch.linkedinUrl || pdlCandidate.linkedinUrl,
          linkedinHeadline: liMatch.headline || null
        };
      }

      // Assign match label
      enriched.matchLabel = calculateMatchLabel(enriched);
      merged.push(enriched);
    });

    // Add LinkedIn candidates that weren't matched
    linkedinCandidates.forEach((liCandidate, index) => {
      if (!linkedinUsed.has(index)) {
        const enriched = {
          ...liCandidate,
          matchLabel: calculateMatchLabel(liCandidate)
        };
        merged.push(enriched);
      }
    });

    // Sort by match label priority: WARM > POSSIBLE > STRETCH
    const labelPriority = { 'WARM': 0, 'POSSIBLE': 1, 'STRETCH': 2 };
    merged.sort((a, b) => labelPriority[a.matchLabel] - labelPriority[b.matchLabel]);

    console.log(`[Score] Merged and sorted ${merged.length} candidates`);
    console.log(`[Score] WARM: ${merged.filter(c => c.matchLabel === 'WARM').length}, POSSIBLE: ${merged.filter(c => c.matchLabel === 'POSSIBLE').length}, STRETCH: ${merged.filter(c => c.matchLabel === 'STRETCH').length}`);

    return merged;

  } catch (error) {
    console.error('[Score] Error scoring candidates:', error.message);
    return [];
  }
}

/**
 * Calculate match label for a candidate
 * @param {Object} candidate - Candidate object with activity/openness signals
 * @returns {string} Match label: WARM, POSSIBLE, or STRETCH
 */
function calculateMatchLabel(candidate) {
  const openToWork = candidate.linkedinOpenToWork === true;
  const recentActivity = candidate.linkedinProfileActivity === true;
  const jobChangeRecency = candidate.jobChangeRecency;

  // WARM: Recently changed roles, open to work, or recent profile activity
  if (openToWork || (jobChangeRecency !== null && jobChangeRecency < 6) || recentActivity) {
    return 'WARM';
  }

  // POSSIBLE: Job changed in last 6-18 months or reasonably active
  if (jobChangeRecency !== null && jobChangeRecency >= 6 && jobChangeRecency <= 18) {
    return 'POSSIBLE';
  }

  // STRETCH: Stable long tenure (18+ months) or no activity signals
  return 'STRETCH';
}

module.exports = {
  findCandidates,
  scoreCandidates,
  extractRoleKeywords, // exported for testing
};
