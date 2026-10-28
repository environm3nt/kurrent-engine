/**
 * Candidate Cache Module (Supabase-backed)
 *
 * Caches PDL candidate search results in a Supabase table with configurable TTL.
 * Reduces PDL credit consumption by serving cached results for repeat role+location queries.
 *
 * Replaces the old file-based cache (.candidate-cache.json) which was lost on every
 * Railway deployment. Supabase-backed cache persists across deploys and enables
 * cross-client candidate reuse (same role+location = same candidates).
 *
 * Cache key: roleTitle|location|seniority (normalized lowercase)
 * Default TTL: 21 days (candidates don't switch jobs overnight; saves PDL credits)
 */

const axios = require('axios');

const DEFAULT_TTL_DAYS = 30;

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

/**
 * Normalize a location string so "Toronto Ontario Canada", "Toronto, Ontario, Canada",
 * and "Toronto, ON" all produce the same cache key. PDL only uses the city name anyway,
 * so different formatting of the same city was burning duplicate credits.
 */
function normalizeLocation(location) {
  if (!location) return '';
  // Split on commas/spaces, take first word (city), lowercase
  return location.split(/[\s,]+/)[0].toLowerCase().trim();
}

/**
 * Build a normalized cache key from search parameters
 */
function buildKey(roleTitle, location, seniority) {
  return `${roleTitle.toLowerCase().trim()}|${normalizeLocation(location)}|${seniority.toLowerCase().trim()}`;
}

/**
 * Get cached candidates for a role+location+seniority combo
 * @param {string} roleTitle
 * @param {string} location
 * @param {string} seniority
 * @returns {Promise<Array|null>} Cached candidates array, or null if not cached / expired
 */
async function getCachedCandidates(roleTitle, location, seniority) {
  const sb = getSupabaseClient();
  if (!sb) {
    console.log(`[CandidateCache] No Supabase — cache disabled`);
    return null;
  }

  const cacheKey = buildKey(roleTitle, location, seniority);

  try {
    const response = await axios.get(`${sb.url}/rest/v1/candidate_cache`, {
      headers: {
        'apikey': sb.key,
        'Authorization': `Bearer ${sb.key}`,
        'Content-Type': 'application/json',
      },
      params: {
        cache_key: `eq.${cacheKey}`,
        select: 'candidates,created_at,ttl_days',
        limit: 1,
      },
    });

    const entry = response.data?.[0];
    if (!entry) {
      console.log(`[CandidateCache] MISS for "${roleTitle}" in ${location} — will query PDL`);
      return null;
    }

    // Check TTL
    const ttlDays = entry.ttl_days || DEFAULT_TTL_DAYS;
    const ageMs = Date.now() - new Date(entry.created_at).getTime();
    const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000) * 10) / 10;

    if (ageDays > ttlDays) {
      console.log(`[CandidateCache] EXPIRED for "${roleTitle}" in ${location} (${ageDays} days old, TTL: ${ttlDays}) — will refresh from PDL`);
      return null;
    }

    const candidates = entry.candidates || [];
    console.log(`[CandidateCache] HIT for "${roleTitle}" in ${location} (${ageDays} days old, ${candidates.length} candidates)`);
    return candidates;

  } catch (err) {
    console.warn(`[CandidateCache] Error reading cache: ${err.message}`);
    return null;
  }
}

/**
 * Store candidates in cache (upsert by cache_key)
 * @param {string} roleTitle
 * @param {string} location
 * @param {string} seniority
 * @param {Array} candidates - Array of candidate objects from PDL
 * @param {number} [ttlDays] - TTL in days (default 21)
 */
async function setCachedCandidates(roleTitle, location, seniority, candidates, ttlDays = DEFAULT_TTL_DAYS) {
  const sb = getSupabaseClient();
  if (!sb) return;

  const cacheKey = buildKey(roleTitle, location, seniority);

  try {
    await axios.post(
      `${sb.url}/rest/v1/candidate_cache`,
      {
        cache_key: cacheKey,
        role_title: roleTitle,
        location: location,
        seniority: seniority,
        candidates: candidates,
        candidate_count: candidates.length,
        ttl_days: ttlDays,
        created_at: new Date().toISOString(),
      },
      {
        headers: {
          'apikey': sb.key,
          'Authorization': `Bearer ${sb.key}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates',
        },
      }
    );

    console.log(`[CandidateCache] STORED ${candidates.length} candidates for "${roleTitle}" in ${location} (TTL: ${ttlDays} days)`);
  } catch (err) {
    // Cache write failure should never block the pipeline
    console.warn(`[CandidateCache] Error writing cache: ${err.message}`);
  }
}

/**
 * Get cache stats (for monitoring / ops dashboard)
 */
async function getCacheStats() {
  const sb = getSupabaseClient();
  if (!sb) return { totalEntries: 0, validEntries: 0 };

  try {
    const response = await axios.get(`${sb.url}/rest/v1/candidate_cache`, {
      headers: {
        'apikey': sb.key,
        'Authorization': `Bearer ${sb.key}`,
        'Content-Type': 'application/json',
        'Prefer': 'count=exact',
      },
      params: {
        select: 'cache_key',
        limit: 0,
      },
    });

    const total = parseInt(response.headers['content-range']?.split('/')[1] || '0', 10);
    return { totalEntries: total };
  } catch (err) {
    console.warn(`[CandidateCache] Error getting stats: ${err.message}`);
    return { totalEntries: 0 };
  }
}

/**
 * Clear expired entries (maintenance — call periodically or after pipeline run)
 */
async function pruneExpired() {
  const sb = getSupabaseClient();
  if (!sb) return;

  try {
    // Delete entries older than their TTL (use max TTL as safe default)
    const cutoff = new Date(Date.now() - DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await axios.delete(`${sb.url}/rest/v1/candidate_cache`, {
      headers: {
        'apikey': sb.key,
        'Authorization': `Bearer ${sb.key}`,
      },
      params: {
        created_at: `lt.${cutoff}`,
      },
    });
    console.log(`[CandidateCache] Pruned expired entries (older than ${DEFAULT_TTL_DAYS} days)`);
  } catch (err) {
    console.warn(`[CandidateCache] Error pruning: ${err.message}`);
  }
}

module.exports = {
  getCachedCandidates,
  setCachedCandidates,
  getCacheStats,
  pruneExpired,
  DEFAULT_TTL_DAYS,
};
