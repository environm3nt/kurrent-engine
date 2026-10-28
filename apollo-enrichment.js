const config = require('./security/config-loader');
const axios = require('axios');
const { getCachedContact, setCachedContact } = require('./contact-cache');

const APOLLO_API_KEY = config.get('APOLLO_API_KEY');
const BASE_URL = 'https://api.apollo.io/api/v1';

if (!APOLLO_API_KEY) {
  console.warn('Warning: APOLLO_API_KEY not found in environment variables');
}

const apiClient = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'X-Api-Key': APOLLO_API_KEY,
  },
});

/**
 * Enriches a company with Apollo organization data
 * @param {string} companyName - The company name to search for
 * @param {string} [domain] - Optional domain for more precise matching
 * @returns {Promise<Object|null>} Company enrichment data or null on failure
 */
async function enrichCompany(companyName, domain) {
  try {
    if (!companyName || typeof companyName !== 'string') {
      console.error('Invalid companyName provided to enrichCompany');
      return null;
    }

    console.log(`[enrichCompany] Searching for company: ${companyName}${domain ? ` (domain: ${domain})` : ''}`);

    const body = {
      q_organization_name: companyName,
      page: 1,
      per_page: 10,
    };

    if (domain) {
      body.q_organization_domains = domain;
    }

    const response = await apiClient.post('/organizations/search', body);

    if (!response.data || !response.data.organizations || response.data.organizations.length === 0) {
      console.log(`[enrichCompany] No organizations found for: ${companyName}`);
      return null;
    }

    // Get the first matching organization
    const org = response.data.organizations[0];

    // Build technologies array
    const technologies = [];
    if (org.technologies && Array.isArray(org.technologies)) {
      technologies.push(...org.technologies);
    }
    if (org.technology_names && Array.isArray(org.technology_names)) {
      technologies.push(...org.technology_names);
    }

    const enrichedData = {
      companyName: org.name || null,
      domain: org.primary_domain || org.domain || null,
      industry: org.industry || null,
      headcount: org.estimated_num_employees || null,
      foundedYear: org.founded_year || null,
      city: org.city || null,
      country: org.country || null,
      technologies: [...new Set(technologies)], // deduplicate
      linkedinUrl: org.linkedin_url || null,
      twitterUrl: org.twitter_url || null,
      annualRevenue: org.annual_revenue || null,
      fundingTotal: org.total_funding || null,
      shortDescription: org.short_description || null,
    };

    console.log(`[enrichCompany] Successfully enriched: ${companyName} — domain: ${enrichedData.domain || 'NONE'}, headcount: ${enrichedData.headcount || 'NONE'}, industry: ${enrichedData.industry || 'NONE'}`);
    return enrichedData;
  } catch (error) {
    console.error(`[enrichCompany] Error enriching company "${companyName}":`, error.message);
    return null;
  }
}

/**
 * Tries to match a person at a company via Apollo /people/match.
 * Costs 1 Apollo credit per call. Returns contact data or null.
 *
 * IMPORTANT: Rejects redacted matches (name missing) — these are useless for
 * outreach and waste credits. Only returns verified contacts with a real name.
 * @private
 */
async function _apolloMatchPerson(companyName, domain, title) {
  const matchBody = {
    organization_name: companyName,
    title: title,
    reveal_personal_emails: false,
    reveal_phone_number: false,
  };
  if (domain) matchBody.domain = domain;

  const response = await apiClient.post('/people/match', matchBody);

  // Check both 'person' and 'match' response formats
  const person = response.data?.person || response.data?.match || null;
  if (person) {
    // Build fullName from available name fields
    let fullName = null;
    if (person.name) {
      fullName = person.name;
    } else if (person.first_name || person.last_name) {
      fullName = `${person.first_name || ''} ${person.last_name || ''}`.trim();
    }

    // REJECT redacted matches — Apollo Basic plan returns title but no name/email.
    // These produce "HR Manager" as both name and title with no contact info.
    // Let the waterfall continue to PDL which returns real names.
    if (!fullName) {
      console.log(`[findContact]   Apollo returned redacted match (title: ${person.title || 'none'}, no name) — rejecting`);
      return null;
    }

    return {
      fullName,
      title: person.title || title,
      email: person.email || null,
      linkedinUrl: person.linkedin_url || null,
      phone: null,
      contactQuality: (fullName && (person.email || person.linkedin_url)) ? 'verified' : 'partial',
    };
  }
  return null;
}

/**
 * Finds a contact at a company using a PDL-first waterfall.
 *
 * PDL-first is cheaper and returns higher-quality data:
 *   - PDL returns real names + work emails for $0.28/record (1 credit, size=1)
 *   - Apollo Basic redacts names ~70% of the time, wasting $0.20/credit
 *   - Cost per VERIFIED contact drops from ~$2.37 to ~$0.89
 *
 * Waterfall order:
 *   Tier 1: PDL domain search (1 credit, returns name + email + LinkedIn)
 *   Tier 2: Apollo — Headcount-aware title matching (up to 3 tries)
 *           Rejects redacted matches — only accepts verified names.
 *   Tier 3: Apollo — Senior fallback (up to 3 tries, last resort)
 *
 * Returns contact object with contactQuality: 'verified' | 'partial' | 'none'
 *
 * @param {string} companyName - The company name
 * @param {string} [domain] - Company domain for precise matching
 * @param {Object} [options] - Options including headcount for smart tier selection
 * @returns {Promise<Object>} Contact data (always returns, with contactQuality field)
 */
async function findContact(companyName, domain, options = {}) {
  const noContact = {
    fullName: null,
    title: null,
    email: null,
    linkedinUrl: null,
    phone: null,
    contactQuality: 'none',
    source: null,
  };

  try {
    if (!companyName || typeof companyName !== 'string') {
      console.error('Invalid companyName provided to findContact');
      return noContact;
    }

    const headcount = options.headcount || 0;
    const isSmallCompany = headcount > 0 && headcount < 50;

    console.log(`[findContact] Searching for contact at ${companyName}${domain ? ` (${domain})` : ''} [headcount: ${headcount || 'unknown'}, size: ${isSmallCompany ? 'small' : 'mid/large'}]`);

    // ================================================================
    // CACHE CHECK: Return cached contact if we've seen this domain before
    // Saves PDL credits on repeat companies (21-day TTL)
    // ================================================================
    if (domain) {
      const cached = await getCachedContact(domain);
      if (cached) {
        cached.source = 'contact-cache';
        return cached;
      }
    }

    // ================================================================
    // TIER 1: PDL — Best value. 1 credit returns a real name + work email.
    // PDL never redacts names and includes work_email for most records.
    // ================================================================
    if (domain) {
      console.log(`[findContact] Tier 1: PDL person search at ${domain}...`);
      try {
        const pdlResult = await _pdlFindContact(companyName, domain);
        if (pdlResult) {
          console.log(`[findContact] ✓ Tier 1 hit (PDL): ${pdlResult.fullName} (${pdlResult.title}) — email: ${pdlResult.email ? 'yes' : 'no'}`);
          pdlResult.source = 'pdl-tier1';
          pdlResult.contactQuality = (pdlResult.fullName && (pdlResult.email || pdlResult.linkedinUrl)) ? 'verified' : 'partial';
          await setCachedContact(domain, pdlResult);
          return pdlResult;
        }
      } catch (pdlErr) {
        console.warn(`[findContact]   PDL error: ${pdlErr.message}`);
      }
    } else {
      // No domain from Apollo enrichment — try PDL company enrichment to resolve one
      console.log(`[findContact] Tier 1: No domain from Apollo — attempting PDL domain resolution...`);
      const resolvedDomain = await _pdlResolveDomain(companyName);
      if (resolvedDomain) {
        domain = resolvedDomain; // Update domain for use in Apollo tiers too
        console.log(`[findContact] Tier 1: PDL resolved domain → ${resolvedDomain}, running contact search...`);
        try {
          const pdlResult = await _pdlFindContact(companyName, resolvedDomain);
          if (pdlResult) {
            console.log(`[findContact] ✓ Tier 1 hit (PDL via resolved domain): ${pdlResult.fullName} (${pdlResult.title}) — email: ${pdlResult.email ? 'yes' : 'no'}`);
            pdlResult.source = 'pdl-tier1-resolved';
            pdlResult.contactQuality = (pdlResult.fullName && (pdlResult.email || pdlResult.linkedinUrl)) ? 'verified' : 'partial';
            await setCachedContact(resolvedDomain, pdlResult);
            return pdlResult;
          }
        } catch (pdlErr) {
          console.warn(`[findContact]   PDL contact search error: ${pdlErr.message}`);
        }
      } else {
        console.log(`[findContact] Tier 1: Skipping PDL (no domain available, PDL resolution failed)`);
      }
    }

    // ================================================================
    // TIER 2: Apollo — Headcount-aware title matching
    // Only accepts verified matches (real name). Redacted = skip.
    // Small co: Owner/Partner/Founder/Principal/Co-Founder
    // Larger co: HR/People/Talent leadership titles (expanded April 2026)
    // ================================================================
    const tier2Titles = isSmallCompany
      ? ['Owner', 'Managing Partner', 'Founder', 'Principal', 'Co-Founder']
      : ['HR Manager', 'Talent Acquisition Manager', 'Recruiter', 'VP Human Resources', 'Head of People', 'Head of Talent', 'People Operations Manager', 'Recruiting Director', 'Head of HR'];

    let apolloBlocked = false;
    console.log(`[findContact] Tier 2: ${isSmallCompany ? 'Owner/Partner (small co)' : 'HR/recruiting (mid/large co)'} via Apollo...`);

    for (const title of tier2Titles) {
      try {
        console.log(`[findContact]   Trying: "${title}"...`);
        const result = await _apolloMatchPerson(companyName, domain, title);
        if (result) {
          console.log(`[findContact] ✓ Tier 2 hit: ${result.fullName} (${result.title}) — email: ${result.email ? 'yes' : 'no'}`);
          result.source = 'apollo-tier2';
          if (domain) await setCachedContact(domain, result);
          return result;
        }
      } catch (err) {
        if (err.response?.status === 403 || err.response?.status === 429) {
          console.warn(`[findContact]   Apollo blocked (${err.response.status}) — skipping remaining Apollo tiers`);
          apolloBlocked = true;
          break;
        }
        if (err.response?.status === 404 || err.response?.status === 422) continue;
        console.warn(`[findContact]   Error: ${err.message}`);
        continue;
      }
    }

    // ================================================================
    // TIER 3: Apollo — Senior fallback (last resort, expanded April 2026)
    // ================================================================
    if (!apolloBlocked) {
      const tier3Titles = ['CEO', 'President', 'Director', 'VP', 'Managing Director', 'General Manager'];
      console.log(`[findContact] Tier 3: Senior fallback via Apollo...`);

      for (const title of tier3Titles) {
        try {
          console.log(`[findContact]   Trying: "${title}"...`);
          const result = await _apolloMatchPerson(companyName, domain, title);
          if (result) {
            console.log(`[findContact] ✓ Tier 3 hit: ${result.fullName} (${result.title}) — email: ${result.email ? 'yes' : 'no'}`);
            result.source = 'apollo-tier3';
            if (domain) await setCachedContact(domain, result);
            return result;
          }
        } catch (err) {
          if (err.response?.status === 403 || err.response?.status === 429) break;
          if (err.response?.status === 404 || err.response?.status === 422) continue;
          continue;
        }
      }
    }

    console.log(`[findContact] ✗ No contact found at ${companyName} after all tiers`);
    // Cache the miss too — don't retry a dead end for 21 days
    if (domain) await setCachedContact(domain, noContact);
    return noContact;
  } catch (error) {
    console.error(`[findContact] Error finding contact for "${companyName}":`, error.message);
    if (error.response) {
      console.error(`[findContact] HTTP Status: ${error.response.status}`);
      console.error(`[findContact] Response Body:`, JSON.stringify(error.response.data, null, 2));
    }
    return noContact;
  }
}

/**
 * PDL company enrichment — resolves a company name to its website domain.
 * Used as a fallback when Apollo enrichment returns no domain, so that
 * PDL Tier 1 contact search can still run (it requires a domain).
 *
 * Costs 1 PDL credit ($0.28) per successful match. No charge on miss.
 * Added April 2026 to address 86% "no contact" rate — many companies
 * had no domain from Apollo, causing PDL contact search to be skipped entirely.
 * @private
 */
async function _pdlResolveDomain(companyName) {
  const PDL_API_KEY = config.get('PDL_API_KEY');
  if (!PDL_API_KEY) {
    return null;
  }

  try {
    console.log(`[findContact-PDL] Resolving domain for "${companyName}" via PDL company enrichment...`);
    const response = await axios.get(
      'https://api.peopledatalabs.com/v5/company/enrich',
      {
        params: { name: companyName, pretty: true },
        headers: {
          'X-Api-Key': PDL_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    const domain = response.data?.website || null;
    if (domain) {
      // Strip protocol and trailing slash to get clean domain
      const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
      console.log(`[findContact-PDL] ✓ Domain resolved: "${companyName}" → ${cleanDomain}`);
      return cleanDomain;
    }

    console.log(`[findContact-PDL] No domain found for "${companyName}" via PDL`);
    return null;
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`[findContact-PDL] Company not found in PDL: "${companyName}"`);
      return null;
    }
    if (err.response?.status === 402) {
      console.warn(`[findContact-PDL] ⚠ PDL credits exhausted (402) — skipping domain resolution`);
      return null;
    }
    console.warn(`[findContact-PDL] Domain resolution error for "${companyName}": ${err.message}`);
    return null;
  }
}

/**
 * PDL person search — finds an HR/senior contact at a company by domain.
 * Uses size=1 to minimize credit usage ($0.28/record). PDL charges per
 * record returned, so size=1 costs 1 credit vs size=5 costing 5.
 *
 * The SQL query already filters and ranks by title relevance (HR > recruiting
 * > senior leadership), so the single result is the best match.
 * @private
 */
async function _pdlFindContact(companyName, domain) {
  const PDL_API_KEY = config.get('PDL_API_KEY');
  if (!PDL_API_KEY) {
    console.log(`[findContact-PDL] No PDL_API_KEY — skipping PDL tier`);
    return null;
  }

  // Search for HR/recruiting people at this company domain
  // PDL SQL ranks by relevance — HR titles surface first
  const sqlQuery = `SELECT * FROM person WHERE job_company_website='${domain}' AND (job_title LIKE '%human resources%' OR job_title LIKE '%hr %' OR job_title LIKE '%recruiter%' OR job_title LIKE '%talent%' OR job_title LIKE '%hiring%' OR job_title LIKE '%people operations%' OR job_title LIKE '%office manager%' OR job_title LIKE '%owner%' OR job_title LIKE '%founder%' OR job_title LIKE '%ceo%' OR job_title LIKE '%president%' OR job_title LIKE '%director%') AND job_title_levels IN ('owner', 'c_suite', 'vp', 'director', 'manager')`;

  console.log(`[findContact-PDL] SQL: searching ${domain} for HR/senior contacts`);

  let response;
  try {
    response = await axios.post(
      'https://api.peopledatalabs.com/v5/person/search',
      { sql: sqlQuery, size: 1, pretty: true },
      {
        headers: {
          'X-Api-Key': PDL_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (pdlError) {
    if (pdlError.response?.status === 402) {
      console.warn(`[findContact-PDL] ⚠ PDL credits exhausted (402 payment_required) — skipping PDL tier`);
      return null;
    }
    throw pdlError; // re-throw non-credit errors
  }

  if (!response.data?.data?.length) {
    console.log(`[findContact-PDL] No results for ${domain}`);
    return null;
  }

  const bestPerson = response.data.data[0];
  if (!bestPerson) return null;

  const fullName = bestPerson.full_name || `${bestPerson.first_name || ''} ${bestPerson.last_name || ''}`.trim() || null;
  const email = bestPerson.work_email || null;
  const linkedinUrl = bestPerson.linkedin_url || null;

  return {
    fullName,
    title: bestPerson.job_title || null,
    email,
    linkedinUrl,
    phone: null,
    contactQuality: (fullName && (email || linkedinUrl)) ? 'verified' : 'partial',
  };
}

/**
 * Batch enriches multiple companies with rate limiting
 * @param {Object[]} companies - Array of company objects with name and optional domain
 * @returns {Promise<Object[]>} Array of enriched company objects
 */
async function batchEnrichCompanies(companies) {
  try {
    if (!Array.isArray(companies) || companies.length === 0) {
      console.error('Invalid companies array provided to batchEnrichCompanies');
      return [];
    }

    console.log(`[batchEnrichCompanies] Starting batch enrichment for ${companies.length} companies`);

    const enrichedCompanies = [];

    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];

      if (!company.name || typeof company.name !== 'string') {
        console.warn(`[batchEnrichCompanies] Skipping invalid company at index ${i}`);
        continue;
      }

      try {
        // Enrich company data
        const enrichmentData = await enrichCompany(company.name, company.domain);

        // Find contact at company
        const contactData = await findContact(
          company.name,
          company.domain,
          company.priorityTitles
        );

        const enrichedCompany = {
          ...company,
          enrichment: enrichmentData,
          contact: contactData,
          enrichedAt: new Date().toISOString(),
        };

        enrichedCompanies.push(enrichedCompany);

        // Rate limiting: delay between requests (1000ms as specified)
        if (i < companies.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        console.error(`[batchEnrichCompanies] Error processing company ${company.name}:`, error.message);
        // Continue with next company instead of crashing
        const failedCompany = {
          ...company,
          enrichment: null,
          contact: null,
          error: error.message,
          enrichedAt: new Date().toISOString(),
        };
        enrichedCompanies.push(failedCompany);
      }
    }

    console.log(`[batchEnrichCompanies] Batch enrichment complete. Processed ${enrichedCompanies.length} companies`);
    return enrichedCompanies;
  } catch (error) {
    console.error('[batchEnrichCompanies] Fatal error in batch processing:', error.message);
    return [];
  }
}

module.exports = {
  enrichCompany,
  findContact,
  batchEnrichCompanies,
};
