require('dotenv').config();

// Initialize Sentry for pipeline error tracking (if configured)
const Sentry = process.env.SENTRY_DSN_PIPELINE ? require('@sentry/node') : null;
if (Sentry) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN_PIPELINE,
    tracesSampleRate: 0.2,
    environment: process.env.NODE_ENV || 'production',
  });
  console.log('[RUN] Sentry initialized for pipeline error tracking');
}

const { runPipeline } = require('./kurrent-pipeline');
const { loadAllClients } = require('./supabase-config-loader');
const { sendPipelineAlert, sendTimeoutAlert, sendLinkedInAuthAlert } = require('./ops-alerts');
const { getAuthFailures, resetAuthFailures, createReauthSession, resetLinkedInContext } = require('./linkedin-scraper');

// Global safety timeout — force-kill the process if it runs too long.
// Normal runs take 30-45 minutes (human-speed scraping delays). 60 minutes means something is stuck.
const MAX_RUN_MINUTES = 60;
const globalTimeout = setTimeout(async () => {
  console.error(`[RUN] ⚠️  GLOBAL TIMEOUT — pipeline exceeded ${MAX_RUN_MINUTES} minutes. Force-exiting.`);
  await sendTimeoutAlert(MAX_RUN_MINUTES);
  if (Sentry) { Sentry.captureMessage(`Pipeline timeout after ${MAX_RUN_MINUTES} minutes`); await Sentry.flush(5000); }
  process.exit(1);
}, MAX_RUN_MINUTES * 60 * 1000);

// Don't let the timeout keep the process alive if main() finishes normally
globalTimeout.unref();

/**
 * Entry point for daily pipeline runs.
 *
 * Production: loads all active client configs from Supabase, runs pipeline for each.
 * Local dev: falls back to client-config.json if no Supabase credentials.
 */
async function main() {
  try {
    const clients = await loadAllClients();
    console.log(`[RUN] Starting pipeline for ${clients.length} client(s)`);
    console.log(`[RUN] Global timeout set: ${MAX_RUN_MINUTES} minutes`);

    for (const clientConfig of clients) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`[RUN] Processing client: ${clientConfig.agencyName} (${clientConfig.tier})`);
      console.log(`${'='.repeat(60)}\n`);

      try {
        const testMode = process.env.TEST_MODE === 'true';
        if (testMode) console.log(`[RUN] ⚠️  TEST MODE — 1 role, 1 location, 1 result\n`);
        const summary = await runPipeline(clientConfig, { testMode });
        console.log(`[RUN] ✓ ${clientConfig.agencyName} complete:`, JSON.stringify(summary, null, 2));

        // Alert on zero leads (pipeline succeeded but produced no results)
        const jobsDiscovered = summary.jobsDiscovered || 0;
        if (jobsDiscovered === 0) {
          console.log(`[RUN] ⚠️  Zero leads alert for ${clientConfig.agencyName}`);
          await sendPipelineAlert(
            clientConfig.agencyName,
            summary.startTime || new Date().toISOString(),
            jobsDiscovered,
            'Pipeline completed but discovered 0 jobs across all scraped roles and locations.'
          );
        }
      } catch (err) {
        console.error(`[RUN] ✗ ${clientConfig.agencyName} failed:`, err.message);
        if (Sentry) Sentry.captureException(err, { tags: { client: clientConfig.agencyName } });

        // Alert on pipeline failure
        const errorDetails = err.metrics || {};
        const clientName = clientConfig.agencyName || 'Unknown Client';
        const runStart = errorDetails.startTime || new Date().toISOString();
        const jobsDiscovered = errorDetails.jobsDiscovered || 0;
        await sendPipelineAlert(
          clientName,
          runStart,
          jobsDiscovered,
          err.error || err.message
        );

        // Continue to next client — don't let one failure stop others
      }
    }

    // Check for LinkedIn auth failures across all clients and alert
    const authFailures = getAuthFailures();
    if (authFailures.count > 0) {
      console.warn(`[RUN] ⚠️  LinkedIn auth failed ${authFailures.count} times — sending alert`);

      // Reset the stale context so the next run creates a fresh one and tries automated login
      await resetLinkedInContext();

      // Auto-create a re-auth session so the alert email has a direct clickable link
      let reauthUrl = null;
      try {
        reauthUrl = await createReauthSession();
      } catch (reauthErr) {
        console.warn(`[RUN] Could not create re-auth session: ${reauthErr.message}`);
      }
      await sendLinkedInAuthAlert(authFailures, reauthUrl);
      resetAuthFailures();
    }

    console.log('\n[RUN] All clients processed. Exiting.');
    if (Sentry) await Sentry.flush(5000);
    process.exit(0);
  } catch (err) {
    console.error('[RUN] Fatal error:', err);
    if (Sentry) { Sentry.captureException(err); await Sentry.flush(5000); }
    process.exit(1);
  }
}

main();
