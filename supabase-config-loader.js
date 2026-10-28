/**
 * Supabase Config Loader
 *
 * Production config source: reads client configurations from Supabase (the same DB
 * the dashboard writes to). This replaces client-config.json for deployed pipelines.
 *
 * Industry standard: database-as-source-of-truth for multi-tenant SaaS.
 * Dashboard writes → Supabase → Pipeline reads. No config file sync needed.
 *
 * Fallback: if SUPABASE_URL is not set, falls back to client-config.json for local dev.
 */

const axios = require('axios');
const path = require('path');

async function loadAllClients() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // service role for pipeline (bypasses RLS)

  if (!supabaseUrl || !supabaseKey) {
    console.log('[CONFIG] No Supabase credentials — falling back to client-config.json');
    const localConfig = require(path.join(__dirname, 'client-config.json'));
    return [localConfig];
  }

  console.log('[CONFIG] Loading client configs from Supabase...');

  try {
    const response = await axios.get(`${supabaseUrl}/rest/v1/clients`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      params: {
        select: '*',
        pipeline_active: 'neq.false', // Skip paused clients (null = active for backwards compat)
      },
    });

    const clients = response.data;
    console.log(`[CONFIG] Loaded ${clients.length} active client(s) from Supabase`);

    // Map Supabase schema to pipeline config format
    return clients.map(mapClientToConfig);
  } catch (error) {
    console.error('[CONFIG] Failed to load from Supabase:', error.message);
    console.log('[CONFIG] Falling back to client-config.json');
    const localConfig = require(path.join(__dirname, 'client-config.json'));
    return [localConfig];
  }
}

async function loadClientById(clientId) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.log('[CONFIG] No Supabase credentials — falling back to client-config.json');
    return require(path.join(__dirname, 'client-config.json'));
  }

  const response = await axios.get(`${supabaseUrl}/rest/v1/clients`, {
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
    },
    params: {
      select: '*',
      id: `eq.${clientId}`,
    },
  });

  if (!response.data || response.data.length === 0) {
    throw new Error(`Client ${clientId} not found in Supabase`);
  }

  return mapClientToConfig(response.data[0]);
}

/**
 * Map Supabase client row → pipeline clientConfig object.
 * The pipeline expects camelCase fields; Supabase stores snake_case.
 */
function mapClientToConfig(row) {
  return {
    clientId: row.id,
    agencyName: row.agency_name || '',
    agencyInitials: row.agency_initials || '',
    logoUrl: row.logo_url || '',
    brandPrimaryHex: row.brand_primary_color || '#2F2C25',
    brandPrimaryColor: row.brand_primary_color || '#2F2C25',
    brandSecondaryHex: row.brand_accent_color || '#FEFAF3',
    brandAccentColor: row.brand_accent_color || '#FEFAF3',
    salesRepName: row.sales_rep_name || '',
    salesRepTitle: row.sales_rep_title || 'Recruitment Director',
    salesRepEmail: row.sales_rep_email || '',
    agencyPhone: row.agency_phone || '',
    agencyWebsite: row.agency_website || '',
    whiteLabel: row.white_label || false,
    targetRoles: (row.target_roles || []).map(r => ({
      title: r.title || '',
      function: r.industry || r.function || '',
      seniority: r.seniority || 'IC',
    })),
    targetLocations: row.target_locations || [],
    maxResultsPerRole: row.max_results_per_role || 3,
    digestRecipients: row.digest_recipients || { to: [], cc: [], from: '', replyTo: '' },
    digestSendTime: row.digest_send_time || '08:00',
    timezone: row.timezone || 'America/Toronto',
    airtableBaseId: row.airtable_base_id || process.env.AIRTABLE_BASE_ID,
    storagePreference: row.storage_preference || 'none',
    tier: row.tier || 'starter',
    generatePdfs: row.generate_pdfs || false,
    // Staffing agency exclusion list (client-specific company names to always filter out)
    excludedCompanies: row.excluded_companies || [],
    // Assignment engine config (see migrations/2026-04-10-assignment-engine.sql)
    assignmentMode: row.assignment_mode || 'legacy',
    assignmentWeights: row.assignment_weights || null,
    assignmentFallbackUserId: row.assignment_fallback_user_id || null,
  };
}

module.exports = { loadAllClients, loadClientById, mapClientToConfig };
