/**
 * PDF Generator Module for Kurrent Project
 * Handles PDF generation via PDFMonkey API, OneDrive uploads, and HTML template building
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('./security/config-loader');

const PDFMONKEY_BASE_URL = 'https://api.pdfmonkey.io/api/v1';
const PDFMONKEY_API_KEY = config.get('PDFMONKEY_API_KEY');

/**
 * Generate a report PDF using PDFMonkey API
 * @param {Object} clientConfig - Client configuration (logoUrl, brandColors, contact info, whiteLabel)
 * @param {Object} reportData - Report data from synthesis (all synthesis fields + company/role info)
 * @returns {Promise<string|null>} Download URL on success, null on error
 */
async function generateReport(clientConfig, reportData) {
  try {
    if (!PDFMONKEY_API_KEY) {
      console.error('[PDF-GEN] Error: PDFMONKEY_API_KEY not set in environment');
      return null;
    }

    console.log('[PDF-GEN] Starting report generation for:', reportData.companyName);

    // Build candidate array for the Liquid template
    // Synthesis now provides headline, meta, matchScore (skills-based), and tags
    const candidates = [];
    if (reportData.candidate1) {
      const c1 = reportData.candidate1;
      candidates.push({
        rank_label: 'Top Pick',
        headline: c1.headline || `${reportData.roleTitle} Candidate — Verified Profile`,
        meta: c1.meta || `${c1.yearsExperience ? c1.yearsExperience + ' years experience · ' : ''}${c1.location || reportData.location || ''}`,
        match_score: c1.matchScore || c1.match_score || 0,
        tags: c1.tags || [
          { label: reportData.roleTitle || 'Matched', style: 'primary' }
        ],
      });
    }
    if (reportData.candidate2) {
      const c2 = reportData.candidate2;
      candidates.push({
        rank_label: 'Strong',
        headline: c2.headline || `${reportData.roleTitle} Candidate — Verified Profile`,
        meta: c2.meta || `${c2.yearsExperience ? c2.yearsExperience + ' years experience · ' : ''}${c2.location || reportData.location || ''}`,
        match_score: c2.matchScore || c2.match_score || 0,
        tags: c2.tags || [
          { label: reportData.roleTitle || 'Matched', style: 'primary' }
        ],
      });
    }

    // Format report date
    const now = new Date();
    const formattedDate = reportData.reportDate || now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    // Prepare payload for PDFMonkey Liquid template (snake_case variable names)
    const templatePayload = {
      // Agency branding
      agency_name: clientConfig.agencyName || 'Your Agency',
      agency_initials: clientConfig.agencyInitials || (clientConfig.agencyName || 'AG').split(' ').map(w => w[0]).join('').substring(0, 3).toUpperCase(),
      agency_logo_url: clientConfig.logoUrl || null,
      brand_primary: clientConfig.brandPrimaryColor || '#2F2C25',
      brand_accent: clientConfig.brandAccentColor || '#FEFAF3',
      white_label: clientConfig.whiteLabel || false,

      // Report metadata
      report_date: formattedDate,
      role_title: reportData.roleTitle || '',
      location: reportData.location || '',
      industry: reportData.industry || 'Professional Services',
      work_arrangement: reportData.workArrangement || 'Full-Time',

      // Stat strip
      competing_postings: reportData.competingPostings || String(reportData.activeCandidates || '—'),
      salary_range: reportData.salaryRange || '—',
      avg_time_to_fill: reportData.timeToFill || '—',
      talent_availability: reportData.talentAvailability || reportData.supplyDemandSignal || '—',

      // Market intelligence narrative (from Claude synthesis)
      market_insight: reportData.marketNarrative || reportData.market_insight || '',
      scarcity_insight: reportData.scarcityInsight || reportData.hiringRiskFlag || reportData.scarcity_insight || '',
      competition_insight: reportData.competitionInsight || reportData.competition_insight || '',
      speed_insight: reportData.speedInsight || reportData.speed_insight || '',

      // Candidates
      candidates: candidates,

      // CTA contact info
      agent_name: clientConfig.salesRepName || '',
      agent_title: clientConfig.salesRepTitle || 'Recruitment Director',
      agent_phone: clientConfig.agencyPhone || '',
      agent_email: clientConfig.salesRepEmail || '',

      // Methodology
      methodology_text: 'This brief is compiled from real-time job market data, proprietary talent pool analytics, and AI-powered candidate matching. Market statistics reflect a 30-day rolling window. Candidate match scores are based on skills alignment, experience relevance, and availability signals. All candidate identities are anonymized — full profiles are available upon engagement.',
    };

    // Create document request for PDFMonkey
    const payload = {
      document: {
        document_template_id: '509f8103-11a1-46ef-9625-2c4cfa270cee',
        status: 'pending',
        payload: templatePayload,
      },
    };

    console.log('[PDF-GEN] Posting document request to PDFMonkey...');

    // POST to PDFMonkey API
    const response = await axios.post(`${PDFMONKEY_BASE_URL}/documents`, payload, {
      headers: {
        Authorization: `Bearer ${PDFMONKEY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    const documentId = response.data.document.id;
    console.log('[PDF-GEN] Document created with ID:', documentId);

    // Poll for completion
    let statusResponse;
    let attempts = 0;
    const maxAttempts = 20; // 20 * 3 seconds = 60 seconds
    const pollInterval = 3000; // 3 seconds

    while (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      attempts++;

      console.log(`[PDF-GEN] Polling status (attempt ${attempts}/${maxAttempts})...`);

      try {
        statusResponse = await axios.get(`${PDFMONKEY_BASE_URL}/documents/${documentId}`, {
          headers: {
            Authorization: `Bearer ${PDFMONKEY_API_KEY}`,
          },
          timeout: 5000,
        });

        const status = statusResponse.data.document.status;
        console.log(`[PDF-GEN] Document status: ${status}`);

        if (status === 'success') {
          const downloadUrl = statusResponse.data.document.download_url;
          console.log('[PDF-GEN] PDF generation successful!');
          console.log('[PDF-GEN] Download URL:', downloadUrl);
          return downloadUrl;
        } else if (status === 'error') {
          const errorMessage = statusResponse.data.document.error || 'Unknown error';
          console.error('[PDF-GEN] Document generation failed:', errorMessage);
          return null;
        }
        // If pending or processing, continue polling
      } catch (pollError) {
        console.error('[PDF-GEN] Poll request error:', pollError.message);
        // Continue polling on network errors
      }
    }

    console.error('[PDF-GEN] Timeout: Document generation did not complete within 60 seconds');
    return null;
  } catch (error) {
    console.error('[PDF-GEN] Error generating report:', error.message);
    if (error.response?.data) {
      console.error('[PDF-GEN] API Response:', error.response.data);
    }
    return null;
  }
}

/**
 * Upload PDF to OneDrive using Microsoft Graph API
 * @param {string} pdfUrl - URL of PDF to download and upload
 * @param {Object} clientConfig - Must contain oneDriveAccessToken and folderPath
 * @returns {Promise<string|null>} OneDrive share link on success, null on error
 */
async function uploadToOneDrive(pdfUrl, clientConfig) {
  try {
    if (!pdfUrl) {
      console.error('[ONEDRIVE] Error: pdfUrl is required');
      return null;
    }

    if (!clientConfig.oneDriveAccessToken) {
      console.error('[ONEDRIVE] Error: oneDriveAccessToken not provided');
      return null;
    }

    const folderPath = clientConfig.folderPath || 'Kurrent Reports';
    console.log('[ONEDRIVE] Starting PDF upload to OneDrive...');
    console.log('[ONEDRIVE] Target folder:', folderPath);

    // Download PDF from PDFMonkey
    console.log('[ONEDRIVE] Downloading PDF from:', pdfUrl);
    const pdfResponse = await axios.get(pdfUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    const pdfBuffer = Buffer.from(pdfResponse.data, 'binary');
    const fileName = `Kurrent-Report-${Date.now()}.pdf`;

    console.log('[ONEDRIVE] PDF downloaded, size:', pdfBuffer.length, 'bytes');
    console.log('[ONEDRIVE] Uploading to OneDrive as:', fileName);

    // Upload to OneDrive using Microsoft Graph API
    const uploadUrl = `https://graph.microsoft.com/v1.0/me/drive/root:/${folderPath}/${fileName}:/content`;

    const uploadResponse = await axios.put(uploadUrl, pdfBuffer, {
      headers: {
        Authorization: `Bearer ${clientConfig.oneDriveAccessToken}`,
        'Content-Type': 'application/pdf',
      },
      timeout: 30000,
    });

    const driveItemId = uploadResponse.data.id;
    console.log('[ONEDRIVE] File uploaded successfully, item ID:', driveItemId);

    // Create share link
    console.log('[ONEDRIVE] Creating share link...');
    const shareUrl = `https://graph.microsoft.com/v1.0/me/drive/items/${driveItemId}/createLink`;
    const shareResponse = await axios.post(
      shareUrl,
      {
        type: 'view',
        scope: 'organization',
      },
      {
        headers: {
          Authorization: `Bearer ${clientConfig.oneDriveAccessToken}`,
        },
        timeout: 10000,
      }
    );

    const shareLink = shareResponse.data.link.webUrl;
    console.log('[ONEDRIVE] Share link created:', shareLink);

    return shareLink;
  } catch (error) {
    console.error('[ONEDRIVE] Error uploading to OneDrive:', error.message);
    if (error.response?.data) {
      console.error('[ONEDRIVE] API Response:', error.response.data);
    }
    return null;
  }
}

/**
 * @deprecated — Do NOT call this function. The approved PDF template lives at
 * templates/report-template-v1.0.html and must not be overwritten programmatically.
 * Edit the HTML file directly instead.
 */
async function buildPDFTemplate() {
  console.warn('[TEMPLATE] buildPDFTemplate() is DEPRECATED. Edit templates/report-template-v1.0.html directly.');
  return null;
}


// Export functions
module.exports = {
  generateReport,
  uploadToOneDrive,
  buildPDFTemplate,
};
