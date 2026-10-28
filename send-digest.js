#!/usr/bin/env node
require('dotenv').config();

/**
 * Standalone Digest Email Sender
 *
 * Runs on its own cron schedule (e.g., 7am EDT) independent of the pipeline.
 * Reads today's leads from Supabase, loads client + recruiter configs, and
 * sends personalized digest emails.
 *
 * Pipeline writes leads at 2am → this script sends digests at 7am.
 * Decouples data processing from email delivery timing.
 *
 * Railway cron: 0 11 * * *  (11:00 UTC = 7:00 AM EDT)
 */

const { loadAllClients } = require('./supabase-config-loader');
const { sendDigest } = require('./digest-email');

// Initialize Sentry if configured
const Sentry = process.env.SENTRY_DSN_PIPELINE ? require('@sentry/node') : null;
if (Sentry) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN_PIPELINE,
    tracesSampleRate: 0.2,
    environment: process.env.NODE_ENV || 'production',
  });
}

async function main() {
  console.log(`[DIGEST] Starting digest email sender at ${new Date().toISOString()}`);

  let supabase;
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    }

    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Load all active clients
    const clients = await loadAllClients();
    console.log(`[DIGEST] Loaded ${clients.length} client(s)`);

    for (const clientConfig of clients) {
      console.log(`\n[DIGEST] Processing: ${clientConfig.agencyName}`);

      try {
        await sendDigestForClient(supabase, clientConfig);
      } catch (err) {
        console.error(`[DIGEST] ✗ ${clientConfig.agencyName} failed: ${err.message}`);
        if (Sentry) Sentry.captureException(err, { tags: { client: clientConfig.agencyName } });
      }
    }

    console.log('\n[DIGEST] All clients processed. Exiting.');
  } catch (err) {
    console.error('[DIGEST] Fatal error:', err.message);
    if (Sentry) Sentry.captureException(err);
  }

  if (Sentry) await Sentry.flush(5000);
  process.exit(0);
}

/**
 * Send digest emails for a single client.
 * Reads today's leads from Supabase, loads recruiter configs,
 * and sends personalized digest per recruiter (or legacy single-send).
 */
async function sendDigestForClient(supabase, clientConfig) {
  const clientId = clientConfig.clientId;
  if (!clientId) {
    console.log(`  Skipping — no clientId`);
    return;
  }

  // Get today's date in the client's timezone
  const timezone = clientConfig.timezone || 'America/Toronto';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD

  // Read today's leads from Supabase
  const { data: leads, error: leadsError } = await supabase
    .from('leads')
    .select('*')
    .eq('client_id', clientId)
    .eq('date_identified', today);

  if (leadsError) {
    throw new Error(`Failed to fetch leads: ${leadsError.message}`);
  }

  if (!leads || leads.length === 0) {
    console.log(`  No leads found for ${today} — skipping digest`);
    return;
  }

  console.log(`  Found ${leads.length} leads for ${today}`);

  // Transform Supabase rows to the format digest-email.js expects
  const leadsForDigest = leads.map(lead => ({
    companyName: lead.company_name,
    roleTitle: lead.role_title,
    location: lead.location,
    functionCategory: lead.industry || 'Operations',
    seniorityTier: lead.seniority_tier || 'IC',
    jobUrl: lead.job_posting_url || '',
    salaryRange: lead.salary_range || '',
    projectedFee: lead.projected_fee || null,
    hiringContactEmail: lead.hiring_contact_email || null,
    salesTalkingPoints: lead.sales_talking_points || null,
    marketInsight: lead.market_insight || null,
    pdfReportLink: lead.pdf_report_link || null,
    discoveredDate: lead.date_identified || today,
  }));

  // Load per-recruiter configs
  let recruiterConfigs = [];
  try {
    const { data: configs } = await supabase
      .from('recruiter_configs')
      .select('user_id, target_roles, target_locations, schedule, digest_enabled, digest_days, display_name')
      .eq('client_id', clientId)
      .eq('digest_enabled', true);

    if (configs && configs.length > 0) {
      // Fetch email addresses from user_clients
      const userIds = configs.map(c => c.user_id);
      const { data: userClients } = await supabase
        .from('user_clients')
        .select('user_id, contact_email, contact_name')
        .in('user_id', userIds);

      const emailMap = {};
      (userClients || []).forEach(uc => {
        emailMap[uc.user_id] = { email: uc.contact_email, name: uc.contact_name };
      });

      recruiterConfigs = configs.map(c => ({
        userId: c.user_id,
        displayName: c.display_name || emailMap[c.user_id]?.name || null,
        email: emailMap[c.user_id]?.email || null,
        targetRoles: c.target_roles || [],
        targetLocations: c.target_locations || [],
        schedule: c.schedule || {},
        digestDays: c.digest_days || [],
      }));
    }
    console.log(`  ${recruiterConfigs.length} recruiter config(s) with digest enabled`);
  } catch (rcErr) {
    console.warn(`  Warning: Could not load recruiter_configs: ${rcErr.message}`);
  }

  // Check digest day
  const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const todayKey = dayKeys[new Date().getDay()];

  // Build lightweight metrics object (digest template uses contactsFound, hotLeads)
  const metrics = {
    contactsFound: leads.filter(l => l.contact_quality === 'verified' || l.contact_quality === 'partial').length,
    hotLeads: leads.filter(l => l.contact_quality === 'verified').length,
  };

  let totalSent = 0;

  if (recruiterConfigs.length > 0) {
    for (const rc of recruiterConfigs) {
      if (rc.digestDays.length > 0 && !rc.digestDays.includes(todayKey)) {
        console.log(`  Skipping digest for ${rc.displayName || rc.email} — not scheduled for ${todayKey}`);
        continue;
      }
      if (!rc.email) {
        console.log(`  Skipping digest for user ${rc.userId} — no email address`);
        continue;
      }

      console.log(`  Sending digest to ${rc.email}...`);
      try {
        const messageId = await sendDigest(leadsForDigest, clientConfig, metrics, rc);
        if (messageId) {
          totalSent++;
          console.log(`  ✓ Sent to ${rc.email} (${messageId})`);
        }
      } catch (err) {
        console.error(`  ✗ Failed to send to ${rc.email}: ${err.message}`);
      }
    }
  } else {
    // Legacy: single digest to client-level recipients
    console.log(`  Sending legacy digest with ${leadsForDigest.length} leads...`);
    try {
      const messageId = await sendDigest(leadsForDigest, clientConfig, metrics);
      if (messageId) {
        totalSent++;
        console.log(`  ✓ Legacy digest sent (${messageId})`);
      }
    } catch (err) {
      console.error(`  ✗ Legacy digest failed: ${err.message}`);
    }
  }

  console.log(`  ${totalSent} digest email(s) sent for ${clientConfig.agencyName}`);
}

main();
