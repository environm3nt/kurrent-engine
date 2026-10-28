/**
 * Cost Tracker — logs every API call to Supabase api_usage table,
 * writes the pipeline_runs row at the end of each run, and sends
 * email alerts when monthly spend crosses warning/critical thresholds.
 *
 * Usage:
 *   const tracker = createCostTracker(clientId)
 *   tracker.track('claude', 1, 0.025, 'Synthesis for Software Engineer')
 *   tracker.track('apollo', 1, 0.08, 'Org search: Shopify')
 *   ...
 *   await tracker.flush(metrics)  // writes api_usage rows + pipeline_runs row
 */

// Estimated cost per unit by service (used when exact cost is unknown)
const COST_ESTIMATES = {
  claude: 0.025,       // per synthesis call (avg ~2K input + 1K output tokens)
  apollo: 0.08,        // per API credit
  pdl: 0.28,           // per search credit
  browserbase: 0.002,  // per minute of session time
  pdfmonkey: 0.02,     // per document generated
  resend: 0.00,        // per-email cost negligible (Transactional Pro $20/mo flat)
  airtable: 0.00,      // free tier
};

// Monthly budget per service (USD). Alert at 80% (warning) and 100% (critical).
// Set to 0 or omit to disable alerts for a service.
const MONTHLY_BUDGETS = {
  claude: 30,          // ~1200 synthesis calls
  apollo: 80,          // ~1000 credits
  pdl: 100,            // ~357 searches
  browserbase: 25,     // ~12500 minutes
  pdfmonkey: 20,       // ~1000 docs
  _total: 250,         // overall monthly cap across all services
};

const ALERT_THRESHOLDS = [
  { pct: 0.80, level: 'WARNING', emoji: '⚠️' },
  { pct: 1.00, level: 'CRITICAL', emoji: '🚨' },
];

// Ops email for alerts — falls back to a placeholder
const ALERT_EMAIL = process.env.OPS_EMAIL || 'ops@example.com';

/**
 * Send a usage alert email via Resend
 */
async function sendAlertEmail(subject, htmlBody) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.warn('[COST-ALERT] No RESEND_API_KEY — alert email skipped');
    console.warn(`[COST-ALERT] Would have sent: ${subject}`);
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'Kurrent <kurrent@kurrentlabs.com>',
        to: [ALERT_EMAIL],
        reply_to: 'hello@kurrentlabs.com',
        subject,
        html: htmlBody,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[COST-ALERT] Email send failed: ${res.status} ${errText}`);
    } else {
      console.log(`[COST-ALERT] ✓ Alert sent: ${subject}`);
    }
  } catch (err) {
    console.error(`[COST-ALERT] Email error: ${err.message}`);
  }
}

/**
 * Fetch current month's spend from Supabase api_usage
 */
async function fetchMonthlySpend() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/api_usage?recorded_at=gte.${monthStart}&select=service,cost_usd`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    if (!res.ok) return null;
    const rows = await res.json();

    // Aggregate by service
    const spend = { _total: 0 };
    for (const row of rows) {
      const svc = row.service;
      if (!spend[svc]) spend[svc] = 0;
      spend[svc] += row.cost_usd || 0;
      spend._total += row.cost_usd || 0;
    }
    return spend;
  } catch (err) {
    console.error(`[COST-ALERT] Failed to fetch monthly spend: ${err.message}`);
    return null;
  }
}

function createCostTracker(clientId) {
  const entries = [];
  const totals = {};
  const alertsSent = new Set(); // track which alerts we've already sent this run

  return {
    /**
     * Track a single API call
     * @param {string} service - 'claude'|'apollo'|'pdl'|'browserbase'|'pdfmonkey'|'resend'|'airtable'
     * @param {number} credits - number of credits/calls/units used
     * @param {number|null} costUsd - exact cost in USD (null = use estimate)
     * @param {string} description - what the call was for
     */
    track(service, credits = 1, costUsd = null, description = '') {
      const cost = costUsd !== null ? costUsd : (COST_ESTIMATES[service] || 0) * credits;
      entries.push({
        client_id: clientId,
        service,
        credits_used: credits,
        cost_usd: cost,
        description,
        recorded_at: new Date().toISOString(),
      });

      if (!totals[service]) totals[service] = { credits: 0, cost: 0 };
      totals[service].credits += credits;
      totals[service].cost += cost;
    },

    /**
     * Get current totals by service
     */
    getTotals() {
      return { ...totals };
    },

    /**
     * Get total cost across all services
     */
    getTotalCost() {
      return Object.values(totals).reduce((sum, t) => sum + t.cost, 0);
    },

    /**
     * Check monthly spend against budgets and send alert emails
     * Called automatically at end of flush()
     */
    async checkAlerts() {
      const monthlySpend = await fetchMonthlySpend();
      if (!monthlySpend) {
        console.log('[COST-ALERT] Could not fetch monthly spend — skipping alert check');
        return;
      }

      // Add this run's totals to the monthly spend (they may not be flushed yet)
      for (const [svc, t] of Object.entries(totals)) {
        if (!monthlySpend[svc]) monthlySpend[svc] = 0;
        monthlySpend[svc] += t.cost;
        monthlySpend._total += t.cost;
      }

      const alerts = [];
      const now = new Date();
      const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

      // Check per-service budgets
      for (const [svc, budget] of Object.entries(MONTHLY_BUDGETS)) {
        if (budget <= 0) continue;
        const spent = monthlySpend[svc] || 0;
        const ratio = spent / budget;

        for (const threshold of ALERT_THRESHOLDS) {
          const alertKey = `${svc}-${threshold.level}`;
          if (ratio >= threshold.pct && !alertsSent.has(alertKey)) {
            alertsSent.add(alertKey);
            alerts.push({
              service: svc === '_total' ? 'ALL SERVICES' : svc.toUpperCase(),
              level: threshold.level,
              emoji: threshold.emoji,
              spent: spent.toFixed(2),
              budget: budget.toFixed(2),
              pct: (ratio * 100).toFixed(0),
            });
          }
        }
      }

      if (alerts.length === 0) {
        console.log('[COST-ALERT] All services within budget');
        return;
      }

      // Build and send alert email
      const hasCritical = alerts.some(a => a.level === 'CRITICAL');
      const subject = hasCritical
        ? `Kurrent — CRITICAL: API spend has exceeded budget (${monthName})`
        : `Kurrent — WARNING: API spend approaching budget (${monthName})`;

      const alertRows = alerts.map(a =>
        `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #F1EADD;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#2F2C25;">${a.emoji} ${a.service}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #F1EADD;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#2F2C25;text-align:right;">$${a.spent}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #F1EADD;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#2F2C25;text-align:right;">$${a.budget}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #F1EADD;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:${a.level === 'CRITICAL' ? '#2F2C25' : '#7A7468'};font-weight:${a.level === 'CRITICAL' ? 'bold' : 'normal'};">${a.level} (${a.pct}%)</td>
        </tr>`
      ).join('');

      const html = `
        <div style="background-color:#FEFAF3;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          <div style="max-width:560px;margin:0 auto;background-color:#FAF9F5;border-radius:12px;padding:24px;border:1px solid #F1EADD;">
            <h2 style="margin:0 0 4px 0;font-family:Georgia,'Times New Roman',serif;color:#2F2C25;font-size:20px;">Usage Alert — ${monthName}</h2>
            <p style="margin:0 0 16px 0;color:#7A7468;font-size:13px;">Automated alert from Kurrent pipeline cost tracker</p>
            <table style="width:100%;border-collapse:collapse;" border="0">
              <thead>
                <tr style="background-color:#2F2C25;">
                  <th style="padding:8px 12px;text-align:left;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#FEFAF3;text-transform:uppercase;">Service</th>
                  <th style="padding:8px 12px;text-align:right;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#FEFAF3;text-transform:uppercase;">Spent</th>
                  <th style="padding:8px 12px;text-align:right;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#FEFAF3;text-transform:uppercase;">Budget</th>
                  <th style="padding:8px 12px;text-align:left;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#FEFAF3;text-transform:uppercase;">Status</th>
                </tr>
              </thead>
              <tbody>
                ${alertRows}
              </tbody>
            </table>
            <p style="margin:16px 0 0 0;color:#9A9084;font-size:12px;">Budgets are configured in cost-tracker.js MONTHLY_BUDGETS. Alerts fire at 80% (warning) and 100% (critical).</p>
          </div>
        </div>`;

      await sendAlertEmail(subject, html);

      // Also log to console
      for (const a of alerts) {
        console.log(`[COST-ALERT] ${a.emoji} ${a.level}: ${a.service} at $${a.spent}/$${a.budget} (${a.pct}%)`);
      }
    },

    /**
     * Flush all tracked costs to Supabase:
     * 1. Batch insert all api_usage rows
     * 2. Insert pipeline_runs row with total cost
     * @param {Object} metrics - pipeline metrics object
     */
    async flush(metrics) {
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.warn('[COST-TRACKER] No Supabase credentials — skipping cost flush');
        return;
      }

      const headers = {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal',
      };

      // 1. Write api_usage rows (batch insert)
      if (entries.length > 0) {
        try {
          const res = await fetch(`${SUPABASE_URL}/rest/v1/api_usage`, {
            method: 'POST',
            headers,
            body: JSON.stringify(entries),
          });
          if (!res.ok) {
            const errText = await res.text();
            console.error(`[COST-TRACKER] Failed to write api_usage: ${res.status} ${errText}`);
          } else {
            console.log(`[COST-TRACKER] ✓ ${entries.length} api_usage entries written ($${this.getTotalCost().toFixed(4)} total)`);
          }
        } catch (err) {
          console.error(`[COST-TRACKER] api_usage write error: ${err.message}`);
        }
      }

      // 2. Write pipeline_runs row
      const totalCost = this.getTotalCost();
      const runData = {
        client_id: clientId,
        run_id: metrics.runId || null,
        started_at: metrics.startTime || new Date().toISOString(),
        completed_at: metrics.endTime || new Date().toISOString(),
        status: (metrics.errors && metrics.errors.length > 0) ? 'partial' : 'success',
        jobs_discovered: metrics.jobsDiscovered || 0,
        jobs_enriched: metrics.companiesEnriched || 0,
        jobs_deduped: metrics.companiesDeduped || 0,
        leads_created: metrics.leadsWritten || 0,
        pdfs_generated: metrics.pdfGenerated || 0,
        emails_sent: metrics.digestSent ? 1 : 0,
        duration_ms: metrics.totalDuration || 0,
        cost_usd: totalCost,
        error_log: (metrics.errors && metrics.errors.length > 0)
          ? metrics.errors.join('\n')
          : null,
      };

      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/pipeline_runs`, {
          method: 'POST',
          headers,
          body: JSON.stringify(runData),
        });
        if (!res.ok) {
          const errText = await res.text();
          console.error(`[COST-TRACKER] Failed to write pipeline_runs: ${res.status} ${errText}`);
        } else {
          console.log(`[COST-TRACKER] ✓ pipeline_run recorded (cost: $${totalCost.toFixed(4)}, status: ${runData.status})`);
        }
      } catch (err) {
        console.error(`[COST-TRACKER] pipeline_runs write error: ${err.message}`);
      }

      // 3. Log cost summary
      console.log(`[COST-TRACKER] Cost summary:`);
      for (const [service, t] of Object.entries(totals)) {
        console.log(`  ${service}: ${t.credits} credits, $${t.cost.toFixed(4)}`);
      }
      console.log(`  TOTAL: $${totalCost.toFixed(4)}`);

      // 4. Check budgets and send alerts if thresholds crossed
      await this.checkAlerts();
    },
  };
}

module.exports = { createCostTracker, COST_ESTIMATES, MONTHLY_BUDGETS };
