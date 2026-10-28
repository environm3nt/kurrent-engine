const config = require('./security/config-loader');
const axios = require('axios');

// Read env vars lazily (at call time) so Railway/Doppler vars are available
function getResendApiKey() {
  const key = config.get('RESEND_API_KEY');
  if (!key) {
    throw new Error('[Digest] RESEND_API_KEY is not set — cannot send email');
  }
  return key;
}
function getOpsEmail() {
  return config.get('OPS_EMAIL') || 'ops@kurrentlabs.com';
}

/**
 * Generate a dynamic hero headline based on today's pipeline results.
 * Replaces the static "Your market moved overnight." with context-aware copy.
 *
 * @param {number} totalLeads - Total lead count
 * @param {number} uniqueCompanies - Distinct companies
 * @param {number} uniqueRoles - Distinct role titles
 * @param {number} hotCount - Leads with verified contact (HOT)
 * @param {string[]} todayRoles - Roles scheduled for today
 * @returns {string} Headline string (no HTML)
 */
function generateHeroHeadline(totalLeads, uniqueCompanies, uniqueRoles, hotCount, todayRoles) {
  // Zero leads — quiet day
  if (totalLeads === 0) {
    return 'Quiet day — no new leads, but your pipeline is still working.';
  }

  // Big day: 10+ leads
  if (totalLeads >= 10) {
    return `Big day — ${totalLeads} new leads across ${uniqueRoles} role${uniqueRoles !== 1 ? 's' : ''}.`;
  }

  // Multiple HOT leads
  if (hotCount >= 3) {
    return `${hotCount} leads came in hot — verified contacts ready to go.`;
  }

  // Single HOT lead in a small batch
  if (hotCount === 1 && totalLeads <= 4) {
    return `${totalLeads} lead${totalLeads !== 1 ? 's' : ''} today — one came in hot.`;
  }

  // Multiple HOT in a moderate batch
  if (hotCount >= 2) {
    return `${totalLeads} new leads, ${hotCount} with verified contacts.`;
  }

  // Good variety of companies
  if (uniqueCompanies >= 5) {
    return `${uniqueCompanies} new companies entered your pipeline.`;
  }

  // Moderate day — default dynamic
  if (totalLeads >= 3) {
    return `${totalLeads} new leads across ${uniqueCompanies} compan${uniqueCompanies !== 1 ? 'ies' : 'y'}.`;
  }

  // Small trickle (1-2 leads)
  if (totalLeads === 1) {
    return 'One new lead today — quality over quantity.';
  }

  return `${totalLeads} new leads today — here\u2019s what\u2019s worth your time.`;
}

/**
 * Build email-safe daily briefing HTML using the approved Kurrent template.
 * Table-based layout, web-safe fonts, warm neutral palette, VML button for Outlook.
 *
 * @param {Array} leadsArray - Array of lead records from the pipeline
 * @param {Object} clientConfig - Client configuration
 * @param {Object} pipelineStats - Optional stats { contactsFound, hotLeads }
 * @param {Object} recruiterConfig - Optional per-recruiter config { displayName, targetRoles, schedule, digestDays }
 * @returns {String} HTML string for digest email
 */
async function buildDigestHTML(leadsArray, clientConfig, pipelineStats = {}, recruiterConfig = null) {
  try {
    if (!Array.isArray(leadsArray)) {
      throw new Error('leadsArray must be an array');
    }
    if (!clientConfig || typeof clientConfig !== 'object') {
      throw new Error('clientConfig must be an object');
    }

    const clientName = clientConfig.agencyName || clientConfig.clientName || 'Client';
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const dashboardUrl = clientConfig.dashboardUrl || 'https://app.kurrentlabs.com/dashboard';
    const settingsUrl = clientConfig.settingsUrl || 'https://app.kurrentlabs.com/dashboard/settings';

    // Greeting name — per-recruiter name if available, else client-level fallback
    const greetingName = recruiterConfig?.displayName
      ? recruiterConfig.displayName.split(' ')[0]
      : (clientConfig.salesRepName || 'there').split(' ')[0];

    // Per-recruiter: figure out today's scheduled roles
    const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const todayKey = dayKeys[today.getDay()];
    let todayRoles = [];
    if (recruiterConfig?.targetRoles && Array.isArray(recruiterConfig.targetRoles)) {
      const schedule = recruiterConfig.schedule || {};
      todayRoles = recruiterConfig.targetRoles
        .filter(role => {
          const roleName = typeof role === 'string' ? role : role.title;
          const days = schedule[roleName] || [];
          // If no days assigned, show every day (unscheduled = always active)
          return days.length === 0 || days.includes(todayKey);
        })
        .map(role => typeof role === 'string' ? role : role.title);
    }

    // Per-recruiter: filter leads to recruiter's target roles (if configured)
    let filteredLeads = leadsArray;
    if (todayRoles.length > 0) {
      const roleTitlesLower = todayRoles.map(r => r.toLowerCase());
      const matched = leadsArray.filter(l =>
        l.roleTitle && roleTitlesLower.some(r => l.roleTitle.toLowerCase().includes(r) || r.includes(l.roleTitle.toLowerCase()))
      );
      // If we matched some, use those; otherwise fall back to all leads (don't send empty digest)
      if (matched.length > 0) filteredLeads = matched;
    }

    // Compute stats
    const totalLeads = filteredLeads.length;
    const uniqueCompanies = new Set(filteredLeads.map(l => l.companyName)).size;
    const uniqueRoles = new Set(filteredLeads.map(l => l.roleTitle).filter(Boolean)).size;

    // Pick top 3 leads — prioritize those with contacts + hooks
    const ranked = [...filteredLeads].sort((a, b) => {
      const scoreA = (a.hiringContactEmail ? 2 : 0) + (a.salesTalkingPoints ? 1 : 0);
      const scoreB = (b.hiringContactEmail ? 2 : 0) + (b.salesTalkingPoints ? 1 : 0);
      return scoreB - scoreA;
    });
    const topLeads = ranked.slice(0, 3);
    const remainingCount = Math.max(0, totalLeads - 3);

    // Dynamic headline — varies based on what actually happened today
    const hotLeads = filteredLeads.filter(l => l.hiringContactEmail);
    const heroHeadline = generateHeroHeadline(totalLeads, uniqueCompanies, uniqueRoles, hotLeads.length, todayRoles);

    // Per-recruiter: compute pipeline value estimate (20% of median salary for active leads)
    let pipelineValueEstimate = 0;
    if (filteredLeads.length > 0) {
      filteredLeads.forEach(l => {
        if (l.projectedFee) {
          pipelineValueEstimate += Number(l.projectedFee) || 0;
        } else if (l.salaryRange || l.salary) {
          const range = l.salaryRange || l.salary || '';
          const nums = range.match(/[\d,]+/g);
          if (nums && nums.length > 0) {
            const values = nums.map(n => parseInt(n.replace(/,/g, '')));
            const median = values.reduce((a, b) => a + b, 0) / values.length;
            pipelineValueEstimate += Math.round(median * 0.2);
          }
        }
      });
    }

    // Build "Today's Roles" chips HTML for the email
    let todayRolesHTML = '';
    if (todayRoles.length > 0) {
      const chips = todayRoles.map(role =>
        `<td style="background-color:#2F2C25;border-radius:6px;padding:4px 10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:600;color:#FEFAF3;">${role}</td><td width="6" style="font-size:0;">&nbsp;</td>`
      ).join('');
      todayRolesHTML = `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;">
        <tr>
          <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#9A9084;font-weight:500;padding-right:8px;">Today&rsquo;s roles:</td>
          ${chips}
        </tr>
      </table>`;
    }

    // Build market snapshot — aggregate by role title
    const roleMap = {};
    leadsArray.forEach(l => {
      const role = l.roleTitle;
      if (!role) return;
      if (!roleMap[role]) roleMap[role] = { salaries: [], fills: [], count: 0 };
      roleMap[role].count++;
      if (l.salary || l.salaryRange) roleMap[role].salaries.push(l.salary || l.salaryRange);
      if (l.timeToFill) roleMap[role].fills.push(l.timeToFill);
    });

    // Market pulse narrative
    const roleNames = Object.keys(roleMap);
    let marketPulseHTML = '';
    if (roleNames.length > 0) {
      // Use first lead's market insight if available, otherwise build a simple one
      const firstWithInsight = leadsArray.find(l => l.marketInsight);
      if (firstWithInsight && firstWithInsight.marketInsight) {
        marketPulseHTML = firstWithInsight.marketInsight;
      } else {
        const parts = roleNames.map(role => {
          const d = roleMap[role];
          const salary = d.salaries[0] || '';
          const fill = d.fills[0] || '';
          return `<strong style="color:#2F2C25;">${role}</strong>: ${d.count} posting${d.count !== 1 ? 's' : ''}${salary ? ` · ${salary}` : ''}${fill ? ` · ${fill} to fill` : ''}`;
        });
        marketPulseHTML = parts.join('. ') + '.';
      }
    }

    // PDF count
    const pdfCount = pipelineStats.pdfsGenerated || leadsArray.filter(l => l.pdfReportLink).length;

    // Tag helper
    function tagHTML(lead) {
      if (lead.hiringContactEmail) {
        return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                    <td style="background-color:#2F2C25;border-radius:6px;padding:3px 10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:10px;font-weight:700;color:#FEFAF3;letter-spacing:0.4px;text-transform:uppercase;text-align:center;">HOT</td>
                  </tr></table>`;
      }
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                    <td style="background-color:#F1EADD;border-radius:6px;padding:3px 10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:10px;font-weight:700;color:#2F2C25;letter-spacing:0.4px;text-transform:uppercase;text-align:center;">NEW</td>
                  </tr></table>`;
    }

    // Build lead cards
    let leadCardsHTML = '';
    topLeads.forEach((lead, i) => {
      const isLast = i === topLeads.length - 1;
      const location = lead.location ? lead.location.split(',')[0].split(' ')[0] : '';
      const role = lead.roleTitle || '';
      const detail = [role, location].filter(Boolean).join(' · ');

      leadCardsHTML += `
      <!-- Lead ${i + 1} -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-radius:10px;border:1px solid #F1EADD;${isLast ? '' : 'margin-bottom:8px;'}">
        <tr>
          <td style="padding:14px 16px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="vertical-align:middle;">
                  <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#2F2C25;">${lead.companyName || 'Company'}</p>
                  <p style="margin:2px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#7A7468;">${detail}</p>
                </td>
                <td align="right" width="50" style="vertical-align:middle;">
                  ${tagHTML(lead)}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>`;
    });

    // "+X more" link
    let moreLeadsHTML = '';
    if (remainingCount > 0) {
      moreLeadsHTML = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td align="center" style="padding:14px 0 0 0;">
          <a href="${dashboardUrl}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:600;color:#2F2C25;text-decoration:none;border-bottom:2px solid #2F2C25;padding-bottom:2px;">+ ${remainingCount} more lead${remainingCount !== 1 ? 's' : ''} &rarr;</a>
        </td></tr>
      </table>`;
    }

    // ── Assemble full HTML ──
    const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
<title>Stay Kurrent &mdash; ${totalLeads} new lead${totalLeads !== 1 ? 's' : ''} for ${clientName}</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>body,table,td{font-family:Georgia,serif!important;}</style>
<![endif]-->
<style>
  /* Gmail strips <style> in non-AMP, but Apple Mail / iOS Mail / Outlook.com honor it */
  @media only screen and (max-width: 599px) {
    .email-container { width: 100% !important; border-radius: 0 !important; }
    .email-padding { padding-left: 24px !important; padding-right: 24px !important; }
    .hero-heading { font-size: 22px !important; }
    .stat-number { font-size: 32px !important; }
    .pipeline-value { font-size: 24px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#FEFAF3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">

<!-- Wrapper -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FEFAF3;">
<tr><td align="center" style="padding:32px 16px;">

<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->

<!-- Email Container — fluid width, max 560px -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-container" style="max-width:560px;width:100%;background-color:#FAF9F5;border-radius:16px;border:1px solid #F1EADD;">

  <!-- Top Accent Bar -->
  <tr>
    <td style="height:4px;background-color:#2F2C25;font-size:0;line-height:0;border-radius:16px 16px 0 0;">&nbsp;</td>
  </tr>

  <!-- Header -->
  <tr>
    <td class="email-padding" style="padding:28px 32px 0 32px;">
      <!-- Logo row -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td width="34" height="34" style="width:34px;height:34px;background-color:#2F2C25;border-radius:8px;text-align:center;vertical-align:middle;font-family:Georgia,'Times New Roman',serif;font-size:17px;font-weight:normal;color:#FEFAF3;line-height:34px;">K</td>
          <td width="10" style="width:10px;font-size:0;">&nbsp;</td>
          <td style="vertical-align:middle;font-family:Georgia,'Times New Roman',serif;font-size:19px;font-weight:normal;color:#2F2C25;line-height:34px;">Kurrent</td>
        </tr>
      </table>
      <!-- Date on its own line -->
      <p style="margin:8px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#9A9084;font-weight:500;">${dateStr}</p>
    </td>
  </tr>

  <!-- Greeting -->
  <tr>
    <td class="email-padding" style="padding:24px 32px 0 32px;">
      <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#7A7468;font-weight:500;">Good morning, ${greetingName}</p>
      <p class="hero-heading" style="margin:6px 0 0 0;font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:normal;color:#2F2C25;line-height:1.25;">${heroHeadline}</p>
${todayRolesHTML}
    </td>
  </tr>

  <!-- Divider -->
  <tr>
    <td class="email-padding" style="padding:24px 32px 0 32px;"><div style="height:1px;background-color:#F1EADD;font-size:0;line-height:0;">&nbsp;</div></td>
  </tr>

  <!-- New Leads Section -->
  <tr>
    <td class="email-padding" style="padding:24px 32px 0 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="vertical-align:top;">
            <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;color:#9A9084;text-transform:uppercase;letter-spacing:1.5px;">New Leads</p>
            <p class="stat-number" style="margin:4px 0 0 0;font-family:Georgia,'Times New Roman',serif;font-size:36px;font-weight:normal;color:#2F2C25;line-height:1.1;">${totalLeads}</p>
            <p style="margin:4px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#9A9084;">compan${uniqueCompanies !== 1 ? 'ies' : 'y'} hiring across ${uniqueRoles} role${uniqueRoles !== 1 ? 's' : ''}</p>
          </td>
          ${pipelineValueEstimate > 0 ? `<td width="140" style="vertical-align:top;text-align:right;">
            <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;color:#9A9084;text-transform:uppercase;letter-spacing:1.5px;">Pipeline Value</p>
            <p class="pipeline-value" style="margin:4px 0 0 0;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:normal;color:#2F2C25;line-height:1.1;">$${pipelineValueEstimate.toLocaleString()}</p>
            <p style="margin:4px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#9A9084;">est. placement fees</p>
          </td>` : ''}
        </tr>
      </table>
    </td>
  </tr>

  <!-- Lead Preview Cards -->
  <tr>
    <td class="email-padding" style="padding:20px 32px 0 32px;">
${leadCardsHTML}
${moreLeadsHTML}
    </td>
  </tr>

  <!-- Divider -->
  <tr>
    <td class="email-padding" style="padding:24px 32px 0 32px;"><div style="height:1px;background-color:#F1EADD;font-size:0;line-height:0;">&nbsp;</div></td>
  </tr>

  <!-- Market Pulse -->
  <tr>
    <td class="email-padding" style="padding:24px 32px 0 32px;">
      <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;color:#9A9084;text-transform:uppercase;letter-spacing:1.5px;">Market Pulse</p>
      <p style="margin:8px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#7A7468;line-height:1.6;">${marketPulseHTML}</p>
    </td>
  </tr>

  <!-- Divider -->
  <tr>
    <td class="email-padding" style="padding:24px 32px 0 32px;"><div style="height:1px;background-color:#F1EADD;font-size:0;line-height:0;">&nbsp;</div></td>
  </tr>

  <!-- Reports Ready -->
  <tr>
    <td class="email-padding" style="padding:24px 32px 0 32px;">
      <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;color:#9A9084;text-transform:uppercase;letter-spacing:1.5px;">Reports Ready</p>
      <p style="margin:8px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#7A7468;line-height:1.6;"><strong style="color:#2F2C25;">${pdfCount || totalLeads} Market Snapshot${(pdfCount || totalLeads) !== 1 ? 's' : ''}</strong> generated &mdash; ready to download or forward to your prospects.</p>
    </td>
  </tr>

  <!-- CTA Button -->
  <tr>
    <td align="center" class="email-padding" style="padding:32px 32px 0 32px;">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${dashboardUrl}" style="height:48px;v-text-anchor:middle;width:260px;" arcsize="19%" fillcolor="#2F2C25" stroke="f">
        <w:anchorlock/>
        <center style="color:#FEFAF3;font-family:sans-serif;font-size:14px;font-weight:600;">View Your Dashboard &rarr;</center>
      </v:roundrect>
      <![endif]-->
      <!--[if !mso]><!-->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:280px;">
        <tr>
          <td align="center" style="background-color:#2F2C25;border-radius:9px;">
            <a href="${dashboardUrl}" target="_blank" style="display:block;padding:14px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#FEFAF3;text-decoration:none;border-radius:9px;text-align:center;">View Your Dashboard &rarr;</a>
          </td>
        </tr>
      </table>
      <!--<![endif]-->
    </td>
  </tr>

  <!-- Sub-CTA text -->
  <tr>
    <td align="center" class="email-padding" style="padding:12px 32px 0 32px;">
      <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#9A9084;">Your leads, reports, and market data &mdash; all in one place.</p>
    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td class="email-padding" style="padding:32px 32px 32px 32px;">
      <div style="height:1px;background-color:#F1EADD;font-size:0;line-height:0;margin-bottom:20px;">&nbsp;</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#9A9084;line-height:1.5;">
            <strong style="color:#7A7468;">${clientName}</strong><br>
            Powered by Kurrent &middot; Delivered daily at 7:00 AM ET
          </td>
          <td align="right" style="vertical-align:top;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#9A9084;">
            <a href="${settingsUrl}" style="color:#9A9084;text-decoration:none;">Settings</a> &middot; <a href="${settingsUrl}" style="color:#9A9084;text-decoration:none;">Unsubscribe</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>

</table>
<!-- /Email Container -->

<!--[if mso]></td></tr></table><![endif]-->

</td></tr>
</table>
<!-- /Wrapper -->

</body>
</html>`;

    return html;
  } catch (error) {
    console.error('Error building digest HTML:', error.message);
    throw error;
  }
}

/**
 * Send digest email via Resend API
 * @param {Array} leadsArray - Array of lead records
 * @param {Object} clientConfig - Configuration object
 * @param {Object} runSummary - Optional run summary object
 * @returns {String|null} Message ID on success, null on failure
 */
async function sendDigest(leadsArray, clientConfig, runSummary = {}, recruiterConfig = null) {
  try {
    console.log('Building digest HTML...');
    const pipelineStats = {
      contactsFound: runSummary.contactsFound || 0,
      hotLeads: runSummary.hotLeads || 0,
      pdfsGenerated: runSummary.pdfsGenerated || 0
    };
    const htmlContent = await buildDigestHTML(leadsArray, clientConfig, pipelineStats, recruiterConfig);

    // Per-recruiter: override recipients if recruiterConfig has a dedicated email
    const dr = clientConfig.digestRecipients || {};
    let toEmails;
    if (recruiterConfig?.email) {
      // Send directly to this recruiter
      toEmails = [recruiterConfig.email];
    } else {
      toEmails = dr.to || clientConfig.toEmails || [];
    }
    const ccEmails = recruiterConfig ? [] : (dr.cc || clientConfig.ccEmails || []);
    const clientName = clientConfig.agencyName || clientConfig.clientName || 'Client';
    // Always use the verified Kurrent sender — clients cannot verify their own domains on Resend
    const fromEmail = 'Kurrent <kurrent@kurrentlabs.com>';
    const replyToEmail = dr.replyTo || clientConfig.replyToEmail || 'hello@kurrentlabs.com';

    if (toEmails.length === 0) {
      throw new Error('No recipient emails provided in digestRecipients.to');
    }

    const resendKey = getResendApiKey();
    console.log(`Sending digest email to: ${toEmails.join(', ')}`);

    const emailPayload = {
      from: fromEmail,
      to: toEmails,
      ...(ccEmails.length > 0 && { cc: ccEmails }),
      reply_to: replyToEmail,
      subject: `Stay Kurrent — ${leadsArray.length} new lead${leadsArray.length !== 1 ? 's' : ''} for ${clientName}`,
      html: htmlContent
    };

    const response = await axios.post('https://api.resend.com/emails', emailPayload, {
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json'
      }
    });

    const messageId = response.data.id;
    console.log(`Email sent successfully. Message ID: ${messageId}`);
    return messageId;
  } catch (error) {
    console.error('Error sending digest email:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
    throw error;
  }
}

/**
 * Send run summary to operations email
 * @param {Object} runSummary - Run summary object
 * @returns {Boolean} True on success, false on failure
 */
async function sendRunSummaryToOps(runSummary) {
  try {
    if (!runSummary || typeof runSummary !== 'object') {
      throw new Error('runSummary must be an object');
    }

    const timestamp = new Date().toISOString();
    const errors = runSummary.errors || [];

    const hasJobs = (runSummary.jobsDiscovered || 0) > 0;
    const hasCriticalFailure = errors.some(e => e.startsWith('STEP 1') || e.startsWith('PIPELINE'));
    const statusText = (hasJobs && !hasCriticalFailure) ? '✓ SUCCESS' : '✗ FAILED';

    const leadsCount = runSummary.jobsDiscovered || 0;
    const dedupedCount = runSummary.companiesDeduped || 0;
    const enrichedCount = runSummary.companiesEnriched || 0;
    const candidatesScored = runSummary.candidatesScored || 0;
    const duration = runSummary.totalDuration
      ? `${(runSummary.totalDuration / 1000).toFixed(1)}s`
      : 'N/A';

    let plainTextContent = `Kurrent run summary report
${timestamp}
${'='.repeat(50)}

Status: ${statusText}

Statistics:
- Jobs Discovered: ${leadsCount}
- After Dedup: ${dedupedCount}
- Companies Enriched: ${enrichedCount}
- Candidates Scored: ${candidatesScored}
- Duration: ${duration}

${errors.length > 0 ? `Errors (${errors.length}):\n${errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n` : 'No errors'}

Run ID: ${runSummary.runId || 'N/A'}
Client: ${runSummary.agencyName || 'N/A'}
Start: ${runSummary.startTime || 'N/A'}
End: ${runSummary.endTime || 'N/A'}

${'='.repeat(50)}
Kurrent Automated System`;

    const opsEmail = getOpsEmail();
    const resendKey = getResendApiKey();
    console.log(`Sending run summary to ops email: ${opsEmail}`);

    const response = await axios.post('https://api.resend.com/emails', {
      from: 'Kurrent <kurrent@kurrentlabs.com>',
      to: opsEmail,
      subject: `Kurrent Run Summary - ${statusText}`,
      text: plainTextContent
    }, {
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json'
      }
    });

    const messageId = response.data.id;
    console.log(`Run summary sent successfully. Message ID: ${messageId}`);
    return true;
  } catch (error) {
    console.error('Error sending run summary to ops:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
    return false;
  }
}

module.exports = {
  buildDigestHTML,
  sendDigest,
  sendRunSummaryToOps
};
