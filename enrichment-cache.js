/**
 * Enrichment Cache Module
 *
 * Checks Supabase for existing company enrichment and contact data before
 * calling Apollo/PDL APIs. Saves real money on every pipeline run by skipping
 * lookups for companies we've already enriched.
 *
 * TTLs:
 *   - Company data (domain, headcount, industry): 90 days — this rarely changes
 *   - Contact data (name, email, title): 30 days — people change jobs
 *
 * Falls through to live API calls when cache misses or data is stale.
 */

const axios = require('axios');

const COMPANY_TTL_DAYS = 90;
const CONTACT_TTL_DAYS = 30;

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const then = new Date(dateStr);
  const now = new Date();
  return (now - then) / (1000 * 60 * 60 * 24);
}

/**
 * Look up cached company enrichment + contact data from Supabase leads table.
 * Searches by company name first, then by domain across ALL clients (contacts
 * for the same domain are reusable regardless of which client found them first).
 *
 * @param {string} companyName - Company name to look up
 * @param {string} clientId - Client ID to scope the name query
 * @param {string} [domain] - Optional company domain for cross-client cache lookup
 * @returns {Promise<{company: Object|null, contact: Object|null, hitType: string}>}
 */
async function getCachedEnrichment(companyName, clientId, domain) {
  const sb = getSupabaseClient();
  if (!sb) return { company: null, contact: null, hitType: 'no-supabase' };

  try {
    const headers = {
      'apikey': sb.key,
      'Authorization': `Bearer ${sb.key}`,
      'Content-Type': 'application/json',
    };
    const selectFields = 'company_domain,company_headcount,industry,hiring_contact_name,hiring_contact_title,hiring_contact_email,hiring_contact_linkedin,contact_quality,updated_at';

    // Strategy 1: Look up by company name within this client (exact match)
    const response = await axios.get(
      `${sb.url}/rest/v1/leads`,
      {
        headers,
        params: {
          'company_name': `eq.${companyName}`,
          'client_id': `eq.${clientId}`,
          'order': 'updated_at.desc',
          'limit': 1,
          'select': selectFields,
        },
      }
    );

    let lead = response.data?.[0] || null;

    // Strategy 2: If no name match and we have a domain, search by domain across ALL clients
    // Same company posting different roles → same domain → reuse the contact
    if (!lead && domain) {
      const domainResponse = await axios.get(
        `${sb.url}/rest/v1/leads`,
        {
          headers,
          params: {
            'company_domain': `eq.${domain}`,
            'contact_quality': 'neq.none',
            'hiring_contact_name': 'not.is.null',
            'order': 'updated_at.desc',
            'limit': 1,
            'select': selectFields,
          },
        }
      );
      lead = domainResponse.data?.[0] || null;
      if (lead) {
        console.log(`    [EnrichCache] Cross-client domain match for ${domain}`);
      }
    }

    if (!lead) {
      return { company: null, contact: null, hitType: 'miss' };
    }

    const age = daysSince(lead.updated_at);

    // Check company data freshness
    let company = null;
    if (lead.company_domain && age < COMPANY_TTL_DAYS) {
      company = {
        companyName: companyName,
        domain: lead.company_domain,
        industry: lead.industry || null,
        headcount: lead.company_headcount ? parseInt(lead.company_headcount, 10) || null : null,
        // These fields aren't stored in leads table — will be null from cache
        // but that's fine, they're not critical for the pipeline
        foundedYear: null,
        city: null,
        country: null,
        technologies: [],
        linkedinUrl: null,
        twitterUrl: null,
        annualRevenue: null,
        fundingTotal: null,
        shortDescription: null,
      };
    }

    // Check contact data freshness
    let contact = null;
    if (lead.contact_quality && lead.contact_quality !== 'none' && age < CONTACT_TTL_DAYS) {
      contact = {
        fullName: lead.hiring_contact_name || null,
        title: lead.hiring_contact_title || null,
        email: lead.hiring_contact_email || null,
        linkedinUrl: lead.hiring_contact_linkedin || null,
        phone: null,
        contactQuality: lead.contact_quality,
        source: 'cache',
      };
    }

    const hitType = company && contact ? 'full-hit' :
                    company ? 'company-only' :
                    contact ? 'contact-only' : 'stale';

    return { company, contact, hitType };

  } catch (err) {
    // Cache errors should never block the pipeline
    console.warn(`[EnrichCache] Error checking cache for ${companyName}: ${err.message}`);
    return { company: null, contact: null, hitType: 'error' };
  }
}

/**
 * Get cache stats — how many unique companies have enrichment data.
 * Useful for ops logging.
 */
async function getEnrichmentCacheStats(clientId) {
  const sb = getSupabaseClient();
  if (!sb) return { cachedCompanies: 0, withContacts: 0 };

  try {
    const response = await axios.get(
      `${sb.url}/rest/v1/leads`,
      {
        headers: {
          'apikey': sb.key,
          'Authorization': `Bearer ${sb.key}`,
          'Content-Type': 'application/json',
          'Prefer': 'count=exact',
        },
        params: {
          'client_id': `eq.${clientId}`,
          'company_domain': 'not.is.null',
          'select': 'company_name',
          'limit': 0,
        },
      }
    );

    const cachedCompanies = parseInt(response.headers['content-range']?.split('/')[1] || '0', 10);

    const contactResponse = await axios.get(
      `${sb.url}/rest/v1/leads`,
      {
        headers: {
          'apikey': sb.key,
          'Authorization': `Bearer ${sb.key}`,
          'Content-Type': 'application/json',
          'Prefer': 'count=exact',
        },
        params: {
          'client_id': `eq.${clientId}`,
          'contact_quality': 'neq.none',
          'hiring_contact_name': 'not.is.null',
          'select': 'company_name',
          'limit': 0,
        },
      }
    );

    const withContacts = parseInt(contactResponse.headers['content-range']?.split('/')[1] || '0', 10);

    return { cachedCompanies, withContacts };

  } catch (err) {
    console.warn(`[EnrichCache] Error getting stats: ${err.message}`);
    return { cachedCompanies: 0, withContacts: 0 };
  }
}

module.exports = {
  getCachedEnrichment,
  getEnrichmentCacheStats,
  COMPANY_TTL_DAYS,
  CONTACT_TTL_DAYS,
};
