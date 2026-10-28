/**
 * Ops alert emails sent by run-now.js — pipeline failure / zero leads, global
 * timeout, and LinkedIn session expiry. All go to OPS_EMAIL through Resend.
 * Kept out of run-now.js so the entry point reads as orchestration.
 */
const axios = require('axios');
const config = require('./security/config-loader');

const FROM = 'Kurrent <kurrent@kurrentlabs.com>';

function opsEmail() {
  return config.get('OPS_EMAIL') || 'ops@example.com';
}

/** Post one HTML email to the ops address. Logs and swallows failures — alerts must never crash the run. */
async function sendOpsEmail(subject, html, label) {
  const resendKey = config.get('RESEND_API_KEY');
  if (!resendKey) {
    console.error(`[ALERT] RESEND_API_KEY is not set — cannot send ${label}`);
    return null;
  }
  try {
    const response = await axios.post('https://api.resend.com/emails', {
      from: FROM, to: opsEmail(), subject, html,
    }, {
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    });
    console.log(`[ALERT] ${label} sent to ${opsEmail()}. Message ID: ${response.data.id}`);
    return response.data.id;
  } catch (error) {
    console.error(`[ALERT] Failed to send ${label}:`, error.message);
    if (error.response) console.error('[ALERT] Response data:', error.response.data);
    return null;
  }
}

/**
 * Pipeline failure / zero-leads alert.
 * @param {string} clientName
 * @param {string} timestamp - ISO timestamp of the run
 * @param {number} jobsDiscovered - 0 for zero-lead alerts
 * @param {string} errorMessage
 */
async function sendPipelineAlert(clientName, timestamp, jobsDiscovered, errorMessage) {
  const isZeroLeads = jobsDiscovered === 0 && !errorMessage.includes('failed');
  const subject = isZeroLeads
    ? `Pipeline Alert — 0 leads produced for ${clientName}`
    : `Pipeline Alert — Run failed for ${clientName}`;

  const alertHTML = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<title>Kurrent — Pipeline Alert</title>
<!--[if mso]>
<style>body,table,td{font-family:Georgia,serif!important;}</style>
<![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#FEFAF3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FEFAF3;">
<tr><td align="center" style="padding:32px 16px;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#FAF9F5;border-radius:16px;border:1px solid #F1EADD;">

  <!-- Red Alert Bar -->
  <tr>
    <td style="height:4px;background-color:#2F2C25;font-size:0;line-height:0;border-radius:16px 16px 0 0;">&nbsp;</td>
  </tr>

  <!-- Header -->
  <tr>
    <td style="padding:28px 32px 0 32px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td width="34" height="34" style="width:34px;height:34px;background-color:#2F2C25;border-radius:8px;text-align:center;vertical-align:middle;font-family:Georgia,'Times New Roman',serif;font-size:17px;font-weight:normal;color:#FEFAF3;line-height:34px;">K</td>
          <td width="10" style="width:10px;font-size:0;">&nbsp;</td>
          <td style="vertical-align:middle;font-family:Georgia,'Times New Roman',serif;font-size:19px;font-weight:normal;color:#2F2C25;line-height:34px;">Kurrent</td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Alert Content -->
  <tr>
    <td style="padding:24px 32px 0 32px;">
      <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#7A7468;font-weight:500;">Pipeline Alert</p>
      <p style="margin:8px 0 0 0;font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:normal;color:#2F2C25;line-height:1.25;">${isZeroLeads ? '0 leads produced' : 'Pipeline failed'}</p>
    </td>
  </tr>

  <!-- Divider -->
  <tr>
    <td style="padding:24px 32px 0 32px;"><div style="height:1px;background-color:#F1EADD;font-size:0;line-height:0;">&nbsp;</div></td>
  </tr>

  <!-- Details -->
  <tr>
    <td style="padding:24px 32px 0 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#7A7468;line-height:1.6;">
            <p style="margin:0 0 12px 0;"><strong style="color:#2F2C25;">Client:</strong> ${clientName}</p>
            <p style="margin:0 0 12px 0;"><strong style="color:#2F2C25;">Timestamp:</strong> ${new Date(timestamp).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</p>
            <p style="margin:0 0 12px 0;"><strong style="color:#2F2C25;">Jobs Discovered:</strong> ${jobsDiscovered}</p>
            ${errorMessage ? `<p style="margin:0;"><strong style="color:#2F2C25;">Issue:</strong> ${errorMessage}</p>` : ''}
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Divider -->
  <tr>
    <td style="padding:24px 32px 0 32px;"><div style="height:1px;background-color:#F1EADD;font-size:0;line-height:0;">&nbsp;</div></td>
  </tr>

  <!-- Action -->
  <tr>
    <td style="padding:24px 32px 0 32px;">
      <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#7A7468;line-height:1.6;">Check the <a href="https://app.kurrentlabs.com/dashboard/admin" style="color:#2F2C25;text-decoration:underline;">admin dashboard</a> for pipeline run history and error logs.</p>
    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td style="padding:32px 32px 32px 32px;">
      <div style="height:1px;background-color:#F1EADD;font-size:0;line-height:0;margin-bottom:20px;">&nbsp;</div>
      <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#9A9084;">Kurrent Automated Pipeline Alert</p>
    </td>
  </tr>

</table>

</td></tr>
</table>

</body>
</html>`;

  return sendOpsEmail(subject, alertHTML, 'pipeline alert');
}

/** Sent by the global safety timeout right before the process is force-exited. */
async function sendTimeoutAlert(minutes) {
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:20px;">
          <p style="color:#2F2C25;font-size:16px;font-weight:600;">Pipeline Timeout</p>
          <p style="color:#7A7468;">The pipeline run exceeded the ${minutes}-minute safety limit and was force-terminated. This usually means a browser session is stuck waiting for a page that will never load (e.g. expired LinkedIn auth).</p>
          <p style="color:#7A7468;">Check the <a href="https://app.kurrentlabs.com/dashboard/admin" style="color:#2F2C25;">admin dashboard</a> for details.</p>
        </div>`;
  return sendOpsEmail(`Pipeline Alert — Run exceeded ${minutes} minute timeout`, html, 'timeout alert');
}

/**
 * LinkedIn session-expired alert, with a one-click re-auth button when a
 * Browserbase session URL is available.
 * @param {{count:number, details:string[]}} authFailures
 * @param {string|null} reauthUrl
 */
async function sendLinkedInAuthAlert(authFailures, reauthUrl) {
  const failureList = authFailures.details.map(d => `<li style="margin:0 0 6px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#7A7468;">${d}</li>`).join('');

  // Build the "How to fix" section — if we have a re-auth URL, show a big button; otherwise fallback to manual instructions
  const fixInstructions = reauthUrl
    ? `<p style="margin:0 0 16px 0;font-size:13px;color:#7A7468;line-height:1.6;">Click the button below to open a browser session. Log into LinkedIn there, then close the tab. That's it — future pipeline runs will use the saved cookies automatically.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 8px 0;"><tr><td style="background-color:#2F2C25;border-radius:9px;padding:0;">
<a href="${reauthUrl}" style="display:inline-block;padding:12px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#FEFAF3;text-decoration:none;border-radius:9px;">Log into LinkedIn</a>
    </td></tr></table>
    <p style="margin:8px 0 0 0;font-size:11px;color:#9A9084;">Opens in Browserbase — log in with the ops LinkedIn account</p>`
    : `<p style="margin:0;font-size:13px;color:#7A7468;line-height:1.6;">1. Go to <a href="https://www.browserbase.com/sessions" style="color:#2F2C25;">Browserbase dashboard</a><br>2. Open a live debug session using the LinkedIn context<br>3. Log into LinkedIn manually<br>4. Close the session — cookies will persist for future runs</p>`;

  const alertHTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background-color:#FEFAF3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FEFAF3;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#FAF9F5;border-radius:16px;border:1px solid #F1EADD;">
  <tr><td style="height:4px;background-color:#2F2C25;font-size:0;line-height:0;border-radius:16px 16px 0 0;">&nbsp;</td></tr>
  <tr><td style="padding:28px 32px 0 32px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="34" height="34" style="width:34px;height:34px;background-color:#2F2C25;border-radius:8px;text-align:center;vertical-align:middle;font-family:Georgia,'Times New Roman',serif;font-size:17px;color:#FEFAF3;line-height:34px;">K</td>
<td width="10" style="width:10px;">&nbsp;</td>
<td style="vertical-align:middle;font-family:Georgia,'Times New Roman',serif;font-size:19px;color:#2F2C25;line-height:34px;">Kurrent</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:24px 32px 0 32px;">
    <p style="margin:0;font-size:14px;color:#7A7468;font-weight:500;">LinkedIn Auth Alert</p>
    <p style="margin:8px 0 0 0;font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#2F2C25;line-height:1.25;">LinkedIn session expired</p>
  </td></tr>
  <tr><td style="padding:20px 32px 0 32px;"><div style="height:1px;background-color:#F1EADD;">&nbsp;</div></td></tr>
  <tr><td style="padding:20px 32px 0 32px;">
    <p style="margin:0 0 12px 0;font-size:13px;color:#7A7468;line-height:1.6;">LinkedIn redirected <strong style="color:#2F2C25;">${authFailures.count} scrape(s)</strong> to the login page. Job and candidate discovery is degraded until the session is re-authenticated.</p>
    <p style="margin:0 0 8px 0;font-size:13px;color:#2F2C25;font-weight:600;">Failed searches:</p>
    <ul style="margin:0;padding:0 0 0 20px;">${failureList}</ul>
  </td></tr>
  <tr><td style="padding:20px 32px 0 32px;"><div style="height:1px;background-color:#F1EADD;">&nbsp;</div></td></tr>
  <tr><td style="padding:20px 32px 0 32px;">
    <p style="margin:0 0 8px 0;font-size:13px;color:#2F2C25;font-weight:600;">How to fix:</p>
    ${fixInstructions}
  </td></tr>
  <tr><td style="padding:32px 32px 32px 32px;">
    <div style="height:1px;background-color:#F1EADD;margin-bottom:20px;">&nbsp;</div>
    <p style="margin:0;font-size:11px;color:#9A9084;">Kurrent Automated Pipeline Alert</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  return sendOpsEmail(`LinkedIn Auth Alert — Session expired (${authFailures.count} failures)`, alertHTML, 'LinkedIn auth alert');
}

module.exports = { sendPipelineAlert, sendTimeoutAlert, sendLinkedInAuthAlert, sendOpsEmail };
