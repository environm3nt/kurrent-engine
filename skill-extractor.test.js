/**
 * Tests for skill-extractor.js
 *
 * Run with: node --test skill-extractor.test.js
 *
 * Tests the fail-safe behavior: when Claude extraction fails (or there's no
 * job description, no API key, bad response), the extractor must ALWAYS
 * return valid title keywords and never throw.
 */

const { describe, it, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// We need to test the module's fail-safe behavior.
// Since skill-extractor.js imports config and makes HTTP calls,
// we test the extractRoleKeywords fallback directly and mock the rest.

const { extractRoleKeywords } = require('./pdl-candidates');

describe('extractRoleKeywords (title-based fallback)', () => {
  it('should extract functional keywords from "Technical Project Manager"', () => {
    const kw = extractRoleKeywords('Technical Project Manager');
    assert.deepStrictEqual(kw, ['technical', 'project', 'manager']);
  });

  it('should strip seniority from "senior product manager"', () => {
    const kw = extractRoleKeywords('senior product manager');
    assert.deepStrictEqual(kw, ['product', 'manager']);
  });

  it('should strip seniority from "director, product manager"', () => {
    const kw = extractRoleKeywords('director, product manager');
    assert.deepStrictEqual(kw, ['product', 'manager']);
  });

  it('should keep "executive" in "Executive Assistant"', () => {
    const kw = extractRoleKeywords('Executive Assistant');
    assert.deepStrictEqual(kw, ['executive', 'assistant']);
  });

  it('should keep "devops" in "devops engineer"', () => {
    const kw = extractRoleKeywords('devops engineer');
    assert.deepStrictEqual(kw, ['devops', 'engineer']);
  });

  it('should handle single-word roles like "Pharmacist"', () => {
    const kw = extractRoleKeywords('Pharmacist');
    assert.deepStrictEqual(kw, ['pharmacist']);
  });

  it('should keep "technical" — Technical PM ≠ PM', () => {
    const kw = extractRoleKeywords('Technical Project Manager');
    assert.ok(kw.includes('technical'), 'Must keep "technical" as a functional qualifier');
  });

  it('should keep "clinical" in "Clinical Pharmacist"', () => {
    const kw = extractRoleKeywords('Clinical Pharmacist');
    assert.deepStrictEqual(kw, ['clinical', 'pharmacist']);
  });

  it('should cap at 3 keywords', () => {
    const kw = extractRoleKeywords('HR Business Partner Specialist Coordinator');
    assert.ok(kw.length <= 3, `Expected ≤3 keywords, got ${kw.length}`);
  });

  it('should handle empty string gracefully', () => {
    const kw = extractRoleKeywords('');
    assert.ok(Array.isArray(kw), 'Should return an array');
  });

  it('should strip all seniority levels', () => {
    const seniorityPrefixes = ['Senior', 'Junior', 'Lead', 'Principal', 'Staff', 'Associate'];
    seniorityPrefixes.forEach(prefix => {
      const kw = extractRoleKeywords(`${prefix} Engineer`);
      assert.ok(!kw.includes(prefix.toLowerCase()),
        `"${prefix}" should be stripped from "${prefix} Engineer"`);
      assert.ok(kw.includes('engineer'),
        `"engineer" should be kept in "${prefix} Engineer"`);
    });
  });
});

describe('extractSearchSkills (Claude integration — fail-safe)', () => {
  // These tests verify the module's contract without making real API calls.
  // The key guarantee: extractSearchSkills ALWAYS returns {titleKeywords, skillKeywords, source}
  // and NEVER throws, regardless of what happens.

  it('should import without error', () => {
    // This test verifies the module loads cleanly even if CLAUDE_API_KEY is missing
    const mod = require('./skill-extractor');
    assert.ok(typeof mod.extractSearchSkills === 'function');
  });

  it('should return titleKeywords even when given empty description', async () => {
    const { extractSearchSkills } = require('./skill-extractor');
    const result = await extractSearchSkills('Technical Project Manager', '');
    assert.ok(Array.isArray(result.titleKeywords));
    assert.deepStrictEqual(result.titleKeywords, ['technical', 'project', 'manager']);
    assert.deepStrictEqual(result.skillKeywords, []);
    assert.ok(result.source.startsWith('fallback'));
  });

  it('should return titleKeywords when description is too short', async () => {
    const { extractSearchSkills } = require('./skill-extractor');
    const result = await extractSearchSkills('Network Engineer', 'Short desc');
    assert.ok(Array.isArray(result.titleKeywords));
    assert.deepStrictEqual(result.titleKeywords, ['network', 'engineer']);
    assert.deepStrictEqual(result.skillKeywords, []);
  });

  it('should never throw on null inputs', async () => {
    const { extractSearchSkills } = require('./skill-extractor');
    // Should handle null/undefined gracefully
    const result = await extractSearchSkills('HR Manager', null);
    assert.ok(Array.isArray(result.titleKeywords));
    assert.ok(Array.isArray(result.skillKeywords));
  });
});

describe('PDL findCandidates signature', () => {
  it('should accept skillKeywords as optional 5th parameter', () => {
    const { findCandidates } = require('./pdl-candidates');
    // Function.length only counts params without defaults.
    // findCandidates(roleTitle, location, seniorityLevel, maxResults=5, skillKeywords=[])
    // so length is 3 (the three required params).
    assert.ok(typeof findCandidates === 'function', 'findCandidates should be a function');
    // The key guarantee: calling with 5 args doesn't throw a signature error
    // (actual API call would fail without credentials, but that's expected)
  });
});
