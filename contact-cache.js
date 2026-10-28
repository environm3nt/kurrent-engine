/**
 * Contact Cache Module (Supabase-backed)
 *
 * Caches PDL contact search results to avoid burning credits on repeat companies.
 * Same pattern as candidate-cache.js but keyed by company domain.
 *
 * The pipeline sees the same companies day after day (recurring job posters).
 * Without caching, each pipeline run pays PDL again for the same HR contact.
 * A contact at a company doesn't change day-to-day — 21-day TTL is safe.
 *
 * Cache key: company domain (normalized lowercase)
 * Default TTL: 21 days
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
 * Get cached contact for a company domain
 * @param {string} domain - Company domain (e.g., "acme.com")
 * @returns {Promise<Object|null>} Cached contact object, or null if not cached / expired
 */
async function getCachedContact(domain) {
  if (!domain) return null;
  const sb = getSupabaseClient();
  if (!sb) {
    console.log(`[ContactCache] No Supabase — cache disabled`);
    return null;
  }

  const cacheKey = domain.toLowerCase().trim();

  try {
    const response = await axios.get(`${sb.url}/rest/v1/contact_cache`, {
      headers: {
        'apikey': sb.key,
        'Authorization': `Bearer ${sb.key}`,
        'Content-Type': 'application/json',
      },
      params: {
        cache_key: `eq.${cacheKey}`,
        select: 'contact,created_at,ttl_days',
        limit: 1,
      },
    });

    const entry = response.data?.[0];
    if (!entry) {
      console.log(`[ContactCache] MISS for ${domain} — will query PDL`);
      return null;
    }

    // Check TTL
    const ttlDays = entry.ttl_days || DEFAULT_TTL_DAYS;
    const ageMs = Date.now() - new Date(entry.created_at).getTime();
    const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000) * 10) / 10;

    if (ageDays > ttlDays) {
      console.log(`[ContactCache] EXPIRED for ${domain} (${ageDays} days old, TTL: ${ttlDays}) — will refresh from PDL`);
      return null;
    }

    const contact = entry.contact || null;
    console.log(`[ContactCache] HIT for ${domain} (${ageDays} days old) — ${contact?.fullName || 'no contact'}`);
    return contact;

  } catch (err) {
    console.warn(`[ContactCache] Error reading cache: ${err.message}`);
    return null;
  }
}

/**
 * Store contact in cache (upsert by domain)
 * @param {string} domain - Company domain
 * @param {Object} contact - Contact object from PDL
 * @param {number} [ttlDays] - TTL in days (default 21)
 */
async function setCachedContact(domain, contact, ttlDays = DEFAULT_TTL_DAYS) {
  if (!domain) return;
  const sb = getSupabaseClient();
  if (!sb) return;

  const cacheKey = domain.toLowerCase().trim();

  try {
    await axios.post(
      `${sb.url}/rest/v1/contact_cache`,
      {
        cache_key: cacheKey,
        domain: domain.toLowerCase().trim(),
        contact: contact,
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

    console.log(`[ContactCache] STORED contact for ${domain}: ${contact?.fullName || 'no contact'} (TTL: ${ttlDays} days)`);
  } catch (err) {
    // Cache write failure should never block the pipeline
    console.warn(`[ContactCache] Error writing cache: ${err.message}`);
  }
}

/**
 * Get cache stats (for monitoring)
 */
async function getContactCacheStats() {
  const sb = getSupabaseClient();
  if (!sb) return { totalEntries: 0 };

  try {
    const response = await axios.get(`${sb.url}/rest/v1/contact_cache`, {
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
    console.warn(`[ContactCache] Error getting stats: ${err.message}`);
    return { totalEntries: 0 };
  }
}

/**
 * Clear expired entries
 */
async function pruneExpiredContacts() {
  const sb = getSupabaseClient();
  if (!sb) return;

  try {
    const cutoff = new Date(Date.now() - DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await axios.delete(`${sb.url}/rest/v1/contact_cache`, {
      headers: {
        'apikey': sb.key,
        'Authorization': `Bearer ${sb.key}`,
      },
      params: {
        created_at: `lt.${cutoff}`,
      },
    });
    console.log(`[ContactCache] Pruned expired entries (older than ${DEFAULT_TTL_DAYS} days)`);
  } catch (err) {
    console.warn(`[ContactCache] Error pruning: ${err.message}`);
  }
}

module.exports = {
  getCachedContact,
  setCachedContact,
  getContactCacheStats,
  pruneExpiredContacts,
  DEFAULT_TTL_DAYS,
};
