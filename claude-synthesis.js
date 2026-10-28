const config = require('./security/config-loader');
const axios = require('axios');

const CLAUDE_API_KEY = config.get('CLAUDE_API_KEY');
const CLAUDE_API_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;

if (!CLAUDE_API_KEY) {
  console.warn('Warning: CLAUDE_API_KEY not found in environment variables');
}

const claudeClient = axios.create({
  baseURL: CLAUDE_API_ENDPOINT,
  headers: {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    'x-api-key': CLAUDE_API_KEY,
  },
});

/**
 * Synthesizes market intelligence using Claude API
 * @param {Object} data - Data object containing recruitment context
 * @param {string} data.companyName - The company name
 * @param {string} data.roleTitle - Job title for the role
 * @param {string} data.location - Job location
 * @param {string} data.seniorityTier - Seniority level (e.g., Junior, Mid, Senior)
 * @param {string} data.workArrangement - Work arrangement (Remote, Hybrid, On-Site)
 * @param {string} data.jobDescription - Full job description
 * @param {Object} data.companyData - Company enrichment data from Apollo
 * @param {Object} data.contactData - Contact data from Apollo
 * @param {Array} data.candidates - Scored candidates from PDL + LinkedIn
 * @param {string} data.marketContext - Market context from web search results
 * @returns {Promise<Object|null>} Synthesis result with market intelligence or null on failure
 */
async function synthesizeIntelligence(data) {
  try {
    if (!data || typeof data !== 'object') {
      console.error('[synthesizeIntelligence] Invalid data object provided');
      return null;
    }

    const {
      companyName = 'Unknown',
      roleTitle = 'Unknown Role',
      location = 'Unknown Location',
      seniorityTier = 'Mid',
      workArrangement = 'Hybrid',
      jobDescription = '',
      companyData = {},
      contactData = {},
      candidates = [],
      marketContext = '',
    } = data;

    console.log(`[synthesizeIntelligence] Starting synthesis for ${roleTitle} at ${companyName} in ${location}`);

    // Build the prompt for Claude
    const systemPrompt = `You are a senior recruitment market analyst with deep expertise in talent acquisition strategy, market dynamics, and hiring forecasts. Your task is to analyze recruitment data and provide structured market intelligence for decision-making.

TONE — CRITICAL: This intelligence brief may be shared directly WITH the hiring company as a sales tool by a recruitment agency. Never characterize the target company negatively — no "struggling to retain," "facing high turnover," "behind competitors," or "failing to attract." Instead, frame all dynamics as market-wide forces and position challenges as opportunities: "High demand across the sector creates urgency" not "Company X is struggling to fill roles." The reader should feel informed and empowered, never called out. Keep the language confident, authoritative, and opportunity-focused.

You MUST return ONLY valid JSON with no preamble, no markdown, no code blocks, and no additional text. Return the JSON object directly.`;

    const userPrompt = `Analyze the following recruitment context and return a comprehensive market intelligence synthesis as a JSON object.

**Recruitment Context:**
Company: ${companyName}
Role: ${roleTitle}
Location: ${location}
Seniority: ${seniorityTier}
Work Arrangement: ${workArrangement}

**Job Description:**
${jobDescription || 'Not provided'}

**Company Data:**
${JSON.stringify(companyData, null, 2) || 'Not available'}

**Contact Data:**
${JSON.stringify(contactData, null, 2) || 'Not available'}

**Candidate Pool (${candidates.length} candidates):**
${candidates.length > 0 ? candidates.map((c, i) => `${i + 1}. ${c.name || c.fullName} - ${c.title || c.currentTitle} at ${c.currentCompany || 'Unknown'} (${c.location}) - Skills: ${(c.topSkills || c.skills || []).join(', ') || 'N/A'} - Experience: ${c.yearsExperience || c.experience || 'N/A'} years - Availability: ${c.matchLabel || 'Unknown'}`).join('\n') : 'No candidates provided'}

**Market Context:**
${marketContext || 'No market context provided'}

Return a JSON object with the following exact structure:
{
  "marketNarrative": "A two-paragraph narrative describing the overall market dynamics, competitive landscape, and supply-demand conditions for this role",
  "salaryRange": "Estimated annual salary range. MUST be short format: '$XXK-$XXXK' (e.g., '$85K-$110K'). No hourly, no 'annually', no descriptive text.",
  "timeToFill": "Estimated days to fill. MUST be format: 'XX days' (e.g., '34 days'). Single number + 'days' only, no ranges like '45-60 days'.",
  "activeCandidates": <number of active candidates in market>,
  "passiveCandidates": <number of passive candidates willing to consider opportunity>,
  "supplyDemandSignal": "<'Tight', 'Moderate', or 'Abundant' with brief 1-2 sentence explanation>",
  "salesTalkingPoints": [
    "First compelling reason for the hiring company to engage a recruitment partner for this role (e.g., market tightness, time pressure, specialized talent pool access, competitive advantage)",
    "Second compelling reason to use a recruitment agency (e.g., cost of vacancy, passive candidate reach, speed to hire)",
    "Third compelling reason (e.g., market intelligence, salary benchmarking, reduced hiring risk)"
  ],
  "candidatePitchPoints": [
    "First compelling reason a candidate should consider this role (e.g., career growth, compensation, company culture)",
    "Second compelling reason to take this opportunity (e.g., work arrangement flexibility, benefits, industry prestige)",
    "Third compelling reason (e.g., learning opportunities, team, mission, location advantages)"
  ],
  "roleChangeDrivers": "Key factors driving demand for this role in the current market",
  "hiringRiskFlag": "Any significant risks or challenges in filling this position",
  "marketTrend": "Current market trend for this role and seniority level",
  "competingPostings": "Number of competing postings. MUST be a plain number as a string (e.g., '23'). No text, no ranges.",
  "talentAvailability": "Percentage of candidates open to new roles. MUST be format: 'XX%' (e.g., '18%'). Plain number + '%' only, no text like 'Low' or 'actively searching'.",
  "scarcityInsight": "ONE sentence ONLY (max 120 characters) on talent scarcity. Example: 'Only 12% of qualified candidates are actively searching — passive outreach is essential.' Keep it punchy.",
  "competitionInsight": "ONE sentence ONLY (max 120 characters) on employer competition. Example: 'Major banks and Big Four firms are competing for the same talent pool.' Keep it punchy.",
  "speedInsight": "ONE sentence ONLY (max 120 characters) on speed advantage. Example: 'Top candidates accept within 10 days — the average time-to-fill is 38 days.' Keep it punchy.",
  "candidate1": {
    "name": "Top candidate name",
    "headline": "Anonymized headline for PDF (e.g., 'Senior Financial Analyst — Big Five Bank'). Never use the real candidate name — describe by current role and employer type.",
    "meta": "Experience summary (e.g., '7 years experience · CFA Level III · Toronto, ON')",
    "title": "Current title",
    "location": "Location",
    "workPreference": "Remote/Hybrid/On-site preference",
    "yearsExperience": <number>,
    "topSkills": ["Skill1", "Skill2", "Skill3"],
    "availabilityStatement": "When candidate could start",
    "matchLabel": "Why this is a strong match",
    "matchScore": <number 0-100 representing how well this candidate's skills, experience, seniority, and qualifications align with the role requirements — NOT availability, purely fit>,
    "tags": [
      {"label": "Primary skill/qualification tag", "style": "primary"},
      {"label": "Secondary credential/background tag", "style": "accent"},
      {"label": "Availability status (e.g., 'Open to Move', 'Actively Looking', 'Passive')", "style": "outline"}
    ]
  },
  "candidate2": {
    "name": "Second candidate name",
    "headline": "Anonymized headline for PDF (e.g., 'Finance Manager — Mid-Market PE Firm')",
    "meta": "Experience summary (e.g., '5 years experience · MBA Finance · Mississauga, ON')",
    "title": "Current title",
    "location": "Location",
    "workPreference": "Remote/Hybrid/On-site preference",
    "yearsExperience": <number>,
    "topSkills": ["Skill1", "Skill2", "Skill3"],
    "availabilityStatement": "When candidate could start",
    "matchLabel": "Why this is a strong match",
    "matchScore": <number 0-100 representing skills/experience fit against role requirements>,
    "tags": [
      {"label": "Primary skill/qualification tag", "style": "primary"},
      {"label": "Secondary credential/background tag", "style": "accent"},
      {"label": "Availability status", "style": "outline"}
    ]
  },
  "candidate3": {
    "name": "Third candidate name (if available, otherwise null)",
    "headline": "Anonymized headline for PDF",
    "meta": "Experience summary",
    "title": "Current title",
    "location": "Location",
    "workPreference": "Remote/Hybrid/On-site preference",
    "yearsExperience": <number>,
    "topSkills": ["Skill1", "Skill2", "Skill3"],
    "availabilityStatement": "When candidate could start",
    "matchLabel": "Why this is a strong match",
    "matchScore": <number 0-100 representing skills/experience fit against role requirements>,
    "tags": [
      {"label": "Primary skill/qualification tag", "style": "primary"},
      {"label": "Secondary credential/background tag", "style": "accent"},
      {"label": "Availability status", "style": "outline"}
    ]
  },
  "ctaCopy": "A 3-sentence maximum call-to-action summary for decision makers",
  "digestBullets": [
    "Key insight bullet 1",
    "Key insight bullet 2",
    "Key insight bullet 3"
  ]
}

IMPORTANT scoring rules for matchScore:
- matchScore measures SKILLS and EXPERIENCE FIT against the role, NOT availability or willingness to move.
- 90-100: Near-perfect alignment — candidate's title, skills, seniority, and industry all match the role requirements closely.
- 75-89: Strong fit — most qualifications match with minor gaps (e.g., adjacent industry, slightly less seniority).
- 60-74: Moderate fit — transferable skills but notable gaps (e.g., different industry, different seniority level).
- Below 60: Weak fit — significant skills or experience gaps.
- Base the score on concrete evidence from the candidate's profile data, not assumptions.

Ensure all fields are populated with realistic, data-driven insights. Return ONLY the JSON object.`;

    console.log('[synthesizeIntelligence] Sending request to Claude API');

    const response = await claudeClient.post('', {
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    });

    if (!response.data || !response.data.content || response.data.content.length === 0) {
      console.error('[synthesizeIntelligence] Invalid response structure from Claude API');
      return null;
    }

    const responseText = response.data.content[0].text;
    console.log('[synthesizeIntelligence] Received response from Claude API');

    // Parse the JSON response — strip markdown fences if Claude wraps in ```json
    let cleanedText = responseText.trim();
    if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    let synthesis;
    try {
      synthesis = JSON.parse(cleanedText);
    } catch (parseError) {
      console.error('[synthesizeIntelligence] Failed to parse Claude response as JSON');
      console.error('[synthesizeIntelligence] Parse error:', parseError.message);
      console.log('[synthesizeIntelligence] Response length:', responseText.length, 'chars');
      console.log('[synthesizeIntelligence] First 500 chars:', responseText.substring(0, 500));
      console.log('[synthesizeIntelligence] Last 200 chars:', responseText.substring(responseText.length - 200));
      return null;
    }

    // Validate required fields
    const requiredFields = [
      'marketNarrative',
      'salaryRange',
      'timeToFill',
      'activeCandidates',
      'passiveCandidates',
      'supplyDemandSignal',
      'salesTalkingPoints',
      'candidatePitchPoints',
      'roleChangeDrivers',
      'hiringRiskFlag',
      'marketTrend',
      'candidate1',
      'candidate2',
      'ctaCopy',
      'digestBullets',
    ];

    for (const field of requiredFields) {
      if (!(field in synthesis)) {
        console.warn(`[synthesizeIntelligence] Missing required field: ${field}`);
      }
    }

    console.log('[synthesizeIntelligence] Successfully synthesized market intelligence');
    return synthesis;
  } catch (error) {
    console.error('[synthesizeIntelligence] Error during synthesis:', error.message);
    if (error.response) {
      console.error('[synthesizeIntelligence] API Error:', error.response.status, error.response.data);
    }
    return null;
  }
}

/**
 * Gets market context for a role by querying Claude with its training data
 * @param {string} roleTitle - The job title to research
 * @param {string} location - The location for the role
 * @returns {Promise<string>} Market context summary or empty string on failure
 */
async function getMarketContext(roleTitle, location) {
  try {
    if (!roleTitle || typeof roleTitle !== 'string') {
      console.error('[getMarketContext] Invalid roleTitle provided');
      return '';
    }

    console.log(`[getMarketContext] Fetching market context for ${roleTitle} in ${location}`);

    const systemPrompt = `You are a recruitment market analyst with access to current labor market data and trends. Provide concise, data-driven market intelligence based on your knowledge. Frame all insights as opportunities — describe market dynamics without characterizing any specific company negatively. This intelligence may be shared with hiring companies directly.`;

    const userPrompt = `Based on your training data and market knowledge, provide a brief market intelligence summary for the following role:

Role: ${roleTitle}
Location: ${location}

Please provide information on:
1. Current salary ranges for this role and seniority level in this location
2. Average time to fill for this type of position
3. Candidate supply signals (tight, moderate, or abundant)
4. Recent market trends affecting this role

Be specific and data-driven. Keep the response to 2-3 paragraphs.`;

    console.log('[getMarketContext] Sending request to Claude API');

    const response = await claudeClient.post('', {
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    });

    if (!response.data || !response.data.content || response.data.content.length === 0) {
      console.error('[getMarketContext] Invalid response structure from Claude API');
      return '';
    }

    const contextText = response.data.content[0].text;
    console.log('[getMarketContext] Successfully retrieved market context');
    return contextText;
  } catch (error) {
    console.error('[getMarketContext] Error fetching market context:', error.message);
    if (error.response) {
      console.error('[getMarketContext] API Error:', error.response.status, error.response.data);
    }
    return '';
  }
}

module.exports = {
  synthesizeIntelligence,
  getMarketContext,
};
