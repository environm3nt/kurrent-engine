/**
 * Supabase Writer Module
 *
 * Writes pipeline lead data to the Supabase `leads` table so the client portal
 * can display them immediately. Mirrors the Airtable write but uses Supabase
 * as the portal's read store.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (service role bypasses RLS).
 */

const axios = require('axios');

/**
 * Check whether Supabase credentials are available.
 * Reads env vars lazily (not at module load) so Doppler/Railway injection is always picked up.
 */
function isConfigured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Write an array of lead records to the Supabase `leads` table.
 * Uses upsert on (client_id, company_name, role_title) to avoid duplicates on re-runs.
 *
 * @param {string} clientId - Supabase UUID of the client (from clients table)
 * @param {Array<Object>} leadRecords - Array of Airtable-shaped lead records
 * @param {Array<Object>} airtableResults - Optional Airtable write results (for record IDs)
 * @returns {Promise<{written: number, errors: number}>}
 */
async function writeLeadsToSupabase(clientId, leadRecords, airtableResults = []) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('[SUPABASE-WRITE] Skipped — SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    console.log(`[SUPABASE-WRITE] DEBUG: SUPABASE_URL=${SUPABASE_URL ? 'set' : 'missing'}, SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_KEY ? 'set' : 'missing'}`);
    return { written: 0, errors: 0, skipped: true };
  }

  if (!clientId || !leadRecords || leadRecords.length === 0) {
    console.log('[SUPABASE-WRITE] No leads to write');
    return { written: 0, errors: 0 };
  }

  console.log(`[SUPABASE-WRITE] Writing ${leadRecords.length} leads for client ${clientId}...`);

  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates',
  };

  let written = 0;
  let errors = 0;

  for (let i = 0; i < leadRecords.length; i++) {
    const record = leadRecords[i];
    // Try to match Airtable record ID if available
    const airtableId = airtableResults[i]?.id || null;

    try {
      const row = {
        client_id: clientId,
        airtable_record_id: airtableId,
        company_name: record['Company Name'] || 'Unknown',
        role_title: record['Role Title'] || 'Unknown',
        industry: record['Industry'] || null,
        seniority_tier: record['Seniority Tier'] || null,
        work_arrangement: record['Work Arrangement'] || null,
        location: record['Location'] || null,
        date_identified: record['Date Identified'] || new Date().toISOString().split('T')[0],
        job_posting_url: record['Job Posting URL'] || null,
        job_description: record['Job Description'] || null,
        company_headcount: record['Company Headcount'] || null,
        years_in_business: record['Years in Business'] || null,
        hiring_contact_name: record['Hiring Contact Name'] || null,
        hiring_contact_title: record['Hiring Contact Title'] || null,
        hiring_contact_email: record['Hiring Contact Email'] || null,
        hiring_contact_linkedin: record['Hiring Contact LinkedIn'] || null,
        company_domain: record['Company Domain'] || null,
        // Airtable stores user-friendly labels; Supabase CHECK expects lowercase
        contact_quality: {
          'Verified': 'verified',
          'Unverified': 'partial',
          'No Contact': 'none',
        }[record['Contact Quality']] || record['Contact Quality'] || 'none',
        salary_range: record['Salary Range'] || null,
        time_to_fill_estimate: record['Time to Fill Estimate'] || null,
        active_candidates: record['Active Candidates'] || 0,
        passive_candidates: record['Passive Candidates'] || 0,
        role_change_drivers: record['Role Change Drivers'] || null,
        candidate_1_name: record['Candidate 1 Name'] || null,
        candidate_1_url: record['Candidate 1 URL'] || null,
        candidate_1_headline: record['Candidate 1 Headline'] || null,
        candidate_1_signal: record['Candidate 1 Signal'] || null,
        candidate_1_match_score: record['Candidate 1 Match Score'] || null,
        candidate_2_name: record['Candidate 2 Name'] || null,
        candidate_2_url: record['Candidate 2 URL'] || null,
        candidate_2_headline: record['Candidate 2 Headline'] || null,
        candidate_2_signal: record['Candidate 2 Signal'] || null,
        candidate_2_match_score: record['Candidate 2 Match Score'] || null,
        candidate_3_name: record['Candidate 3 Name'] || null,
        candidate_3_url: record['Candidate 3 URL'] || null,
        candidate_3_headline: record['Candidate 3 Headline'] || null,
        candidate_3_signal: record['Candidate 3 Signal'] || null,
        candidate_3_match_score: record['Candidate 3 Match Score'] || null,
        sales_talking_points: record['Sales Talking Points'] || null,
        candidate_pitch_points: record['Candidate Pitch Points'] || null,
        pdf_report_link: record['PDF Report Link'] || null,
        assigned_to_user_id: record['Assigned To User ID'] || null,
        projected_fee: record['Projected Fee'] || null,
        // Market intelligence fields (from Claude synthesis — needed for PDF reports)
        competing_postings: record['Competing Postings'] || null,
        talent_availability: record['Talent Availability'] || null,
        market_insight: record['Market Insight'] || null,
        scarcity_insight: record['Scarcity Insight'] || null,
        competition_insight: record['Competition Insight'] || null,
        speed_insight: record['Speed Insight'] || null,
        status: 'New',
      };

      await axios.post(
        `${SUPABASE_URL}/rest/v1/leads`,
        row,
        { headers }
      );

      written++;
      console.log(`  ✓ ${row.company_name} — ${row.role_title}`);

    } catch (err) {
      errors++;
      const detail = err.response?.data?.message || err.message;
      console.error(`  ✗ ${record['Company Name']}: ${detail}`);
    }
  }

  console.log(`[SUPABASE-WRITE] Done: ${written} written, ${errors} errors`);
  return { written, errors };
}

module.exports = { writeLeadsToSupabase, isConfigured };
