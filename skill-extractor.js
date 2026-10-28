/**
 * Skill Extractor — Claude-powered keyword extraction from job descriptions.
 *
 * Given a job title and description, asks Claude to extract the 5-8 most
 * searchable skills/keywords for finding matching candidates on PDL.
 *
 * Fail-safe: if Claude call fails, times out, returns garbage, or the
 * job description is empty, falls back to title-based keywords via
 * extractRoleKeywords(). The pipeline never breaks.
 *
 * Cost: ~$0.005-0.01 per call (very short prompt + response, Haiku-class).
 * Uses Sonnet since we already have the key, but prompt is minimal.
 */

const config = require('./security/config-loader');
const axios = require('axios');
const { extractRoleKeywords } = require('./pdl-candidates');

const CLAUDE_API_KEY = config.get('CLAUDE_API_KEY');
const CLAUDE_API_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

// Timeout for Claude call — 10 seconds max. If it takes longer, fall back.
const EXTRACTION_TIMEOUT_MS = 10000;

const claudeClient = axios.create({
  baseURL: CLAUDE_API_ENDPOINT,
  headers: {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    'x-api-key': CLAUDE_API_KEY,
  },
  timeout: EXTRACTION_TIMEOUT_MS,
});

/**
 * Extract searchable candidate skills from a job posting using Claude.
 *
 * @param {string} roleTitle - Job title (e.g., "Technical Project Manager")
 * @param {string} jobDescription - Full job description text
 * @returns {Promise<{titleKeywords: string[], skillKeywords: string[], source: string}>}
 *   - titleKeywords: core role keywords (from title, always present)
 *   - skillKeywords: extracted skills (from Claude, may be empty on failure)
 *   - source: 'claude' | 'fallback' (for logging/debugging)
 */
async function extractSearchSkills(roleTitle, jobDescription) {
  // Always compute title keywords as the baseline/fallback
  const titleKeywords = extractRoleKeywords(roleTitle);

  // If no job description, return title keywords only
  if (!jobDescription || jobDescription.trim().length < 50) {
    console.log(`[SkillExtract] No job description for "${roleTitle}" — using title keywords only`);
    return { titleKeywords, skillKeywords: [], source: 'fallback-no-description' };
  }

  // If no Claude API key, fall back silently
  if (!CLAUDE_API_KEY) {
    console.log(`[SkillExtract] No CLAUDE_API_KEY — using title keywords only`);
    return { titleKeywords, skillKeywords: [], source: 'fallback-no-key' };
  }

  try {
    // Truncate job description to ~1500 chars to keep costs minimal
    const descTruncated = jobDescription.slice(0, 1500);

    const response = await claudeClient.post('', {
      model: CLAUDE_MODEL,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Extract the 5-8 most important searchable skills, certifications, or technical competencies from this job posting that would help find matching candidates on LinkedIn/PDL. Return ONLY a JSON array of lowercase strings — no explanation.

Focus on: specific technologies, tools, certifications, methodologies, and domain expertise. Skip generic soft skills like "communication" or "leadership."

Role: ${roleTitle}
Description: ${descTruncated}

Respond with ONLY a JSON array, e.g.: ["kubernetes","aws","pmp","agile","ci/cd"]`
      }],
    });

    const content = response.data?.content?.[0]?.text?.trim();
    if (!content) {
      console.warn(`[SkillExtract] Empty Claude response for "${roleTitle}" — falling back`);
      return { titleKeywords, skillKeywords: [], source: 'fallback-empty-response' };
    }

    // Parse the JSON array — handle markdown code blocks, extra text, etc.
    let jsonStr = content;
    // Strip markdown code fences if present
    jsonStr = jsonStr.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    // Find the array in the response
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      console.warn(`[SkillExtract] No JSON array found in Claude response for "${roleTitle}": ${content.slice(0, 100)}`);
      return { titleKeywords, skillKeywords: [], source: 'fallback-parse-error' };
    }

    const skills = JSON.parse(arrayMatch[0]);

    // Validate: must be an array of strings
    if (!Array.isArray(skills) || skills.length === 0) {
      console.warn(`[SkillExtract] Invalid skills array for "${roleTitle}"`);
      return { titleKeywords, skillKeywords: [], source: 'fallback-invalid-array' };
    }

    // Clean and deduplicate
    const cleanSkills = skills
      .filter(s => typeof s === 'string' && s.length > 0 && s.length < 50)
      .map(s => s.toLowerCase().trim())
      .filter((s, i, arr) => arr.indexOf(s) === i) // dedupe
      .slice(0, 8);

    console.log(`[SkillExtract] "${roleTitle}" → ${JSON.stringify(cleanSkills)}`);
    return { titleKeywords, skillKeywords: cleanSkills, source: 'claude' };

  } catch (error) {
    // Any failure — timeout, network, API error, JSON parse — falls back silently
    const reason = error.code === 'ECONNABORTED' ? 'timeout' :
                   error.response?.status ? `HTTP ${error.response.status}` :
                   error.message;
    console.warn(`[SkillExtract] Claude extraction failed for "${roleTitle}" (${reason}) — using title keywords only`);
    return { titleKeywords, skillKeywords: [], source: `fallback-${reason}` };
  }
}

module.exports = {
  extractSearchSkills,
};
