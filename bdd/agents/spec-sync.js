#!/usr/bin/env node
/**
 * Spec Sync Agent
 *
 * Detects when pipeline code has changed and flags BDD specs that may be stale.
 * Compares function signatures, config shapes, and key constants against what
 * the feature files expect.
 *
 * Usage:
 *   node bdd/agents/spec-sync.js              # Check for drift
 *   node bdd/agents/spec-sync.js --detailed   # Show exact mismatches
 *   node bdd/agents/spec-sync.js --auto-fix   # Suggest spec updates (future)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '../..');
const FEATURES_DIR = path.join(__dirname, '../features');

// --- Code Fingerprints ---
// These are the "contract points" between the code and the BDD specs.
// If these change in the code, the specs need updating.

function extractCodeFingerprints() {
  const fingerprints = {};

  // 1. Tier logic in kurrent-pipeline.js
  try {
    const pipeline = fs.readFileSync(path.join(ROOT, 'kurrent-pipeline.js'), 'utf8');

    // Check tier variable name and logic
    const tierMatch = pipeline.match(/const\s+(\w+)\s*=\s*\(clientConfig\.tier.*?\)\.toLowerCase\(\)/);
    fingerprints['pipeline.tierVariable'] = tierMatch ? tierMatch[1] : 'NOT_FOUND';

    const skipMatch = pipeline.match(/const\s+(\w+)\s*=\s*\w+\s*===\s*'(\w+)'/);
    fingerprints['pipeline.skipConditionTier'] = skipMatch ? skipMatch[2] : 'NOT_FOUND';

    // Check test mode — look for slice pattern on same or nearby line
    const testModeMatch = pipeline.match(/targetRoles\.slice\(0,\s*(\d+)\)/);
    fingerprints['pipeline.testModeRoleLimit'] = testModeMatch ? parseInt(testModeMatch[1]) : 'NOT_FOUND';

    // Check step count
    const stepMatches = pipeline.match(/\[STEP \d+\]/g) || [];
    fingerprints['pipeline.stepCount'] = stepMatches.length;
  } catch (e) {
    fingerprints['pipeline'] = 'FILE_NOT_FOUND';
  }

  // 2. Seniority mapping in pdl-candidates.js
  try {
    const pdl = fs.readFileSync(path.join(ROOT, 'pdl-candidates.js'), 'utf8');

    const icMatch = pdl.match(/'ic':\s*\[([^\]]+)\]/);
    fingerprints['pdl.icMapping'] = icMatch ? icMatch[1].replace(/'/g, '').replace(/\s/g, '') : 'NOT_FOUND';

    const managerMatch = pdl.match(/'manager':\s*\[([^\]]+)\]/);
    fingerprints['pdl.managerMapping'] = managerMatch ? managerMatch[1].replace(/'/g, '').replace(/\s/g, '') : 'NOT_FOUND';

    const vpMatch = pdl.match(/'vp\/c-suite':\s*\[([^\]]+)\]/);
    fingerprints['pdl.vpMapping'] = vpMatch ? vpMatch[1].replace(/'/g, '').replace(/\s/g, '') : 'NOT_FOUND';
  } catch (e) {
    fingerprints['pdl'] = 'FILE_NOT_FOUND';
  }

  // 3. Airtable valid statuses in kurrent-pipeline.js
  try {
    const pipeline = fs.readFileSync(path.join(ROOT, 'kurrent-pipeline.js'), 'utf8');
    const statusMatch = pipeline.match(/validStatus\s*=\s*\[([^\]]+)\]/);
    if (statusMatch) {
      fingerprints['airtable.validStatuses'] = statusMatch[1].replace(/'/g, '').replace(/\s/g, '');
    }
  } catch (e) { /* skip */ }

  // 4. Digest email design
  try {
    const digest = fs.readFileSync(path.join(ROOT, 'digest-email.js'), 'utf8');

    const maxWidthMatch = digest.match(/max-width:\s*(\d+)px/);
    fingerprints['digest.maxWidth'] = maxWidthMatch ? parseInt(maxWidthMatch[1]) : 'NOT_FOUND';

    const fnSignature = digest.match(/async function buildDigestHTML\(([^)]+)\)/);
    fingerprints['digest.buildDigestHTMLParams'] = fnSignature ? fnSignature[1].replace(/\s/g, '') : 'NOT_FOUND';
  } catch (e) {
    fingerprints['digest'] = 'FILE_NOT_FOUND';
  }

  // 5. Client config shape
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'client-config.json'), 'utf8'));
    fingerprints['config.tier'] = config.tier;
    fingerprints['config.fromAddress'] = config.digestRecipients?.from || 'NOT_SET';
    fingerprints['config.roleCount'] = config.targetRoles?.length || 0;
    fingerprints['config.hasAirtableBaseId'] = !!config.airtableBaseId;
  } catch (e) {
    fingerprints['config'] = 'FILE_NOT_FOUND';
  }

  // 6. Cache TTL
  try {
    const cache = fs.readFileSync(path.join(ROOT, 'candidate-cache.js'), 'utf8');
    const ttlMatch = cache.match(/DEFAULT_TTL_DAYS\s*=\s*(\d+)/);
    fingerprints['cache.defaultTTL'] = ttlMatch ? parseInt(ttlMatch[1]) : 'NOT_FOUND';
  } catch (e) {
    fingerprints['cache'] = 'FILE_NOT_FOUND';
  }

  return fingerprints;
}

// --- Expected values from BDD specs ---
function getExpectedFingerprints() {
  return {
    'pipeline.tierVariable': 'clientTier',
    'pipeline.skipConditionTier': 'starter',
    'pipeline.testModeRoleLimit': 1,
    'pdl.icMapping': 'entry,mid,senior',
    'pdl.managerMapping': 'manager,director',
    'pdl.vpMapping': 'vp,executive',
    'digest.maxWidth': 420,
    'digest.buildDigestHTMLParams': 'leadsArray,clientConfig,pipelineStats={}',
    'config.fromAddress': 'Kurrent <kurrent@kurrentlabs.com>',
    'config.hasAirtableBaseId': true,
    'cache.defaultTTL': 14
  };
}

// --- Drift Detection ---

function detectDrift() {
  const actual = extractCodeFingerprints();
  const expected = getExpectedFingerprints();
  const drift = [];

  for (const [key, expectedVal] of Object.entries(expected)) {
    const actualVal = actual[key];
    if (actualVal === undefined) {
      drift.push({ key, expected: expectedVal, actual: 'MISSING', severity: 'high' });
    } else if (String(actualVal) !== String(expectedVal)) {
      drift.push({ key, expected: expectedVal, actual: actualVal, severity: 'medium' });
    }
  }

  return { drift, actual, expected };
}

// --- Git Change Detection ---

function getRecentChanges(since = '7 days ago') {
  try {
    const files = execSync(`git log --since="${since}" --name-only --pretty=format: -- '*.js' '*.json'`, {
      cwd: ROOT
    }).toString().split('\n').filter(Boolean);

    // Unique files
    return [...new Set(files)];
  } catch (e) {
    return [];
  }
}

function mapFileToFeature(filename) {
  const mapping = {
    'kurrent-pipeline.js': ['01-job-discovery.feature', '02-deduplication.feature', '10-error-resilience.feature', '11-tier-logic.feature'],
    'linkedin-scraper.js': ['01-job-discovery.feature'],
    'indeed-scraper.js': ['01-job-discovery.feature'],
    'relevance-filter.js': ['01-job-discovery.feature'],
    'apollo-enrichment.js': ['04-enrichment.feature'],
    'pdl-candidates.js': ['05-candidate-scoring.feature'],
    'candidate-cache.js': ['05-candidate-scoring.feature'],
    'claude-synthesis.js': ['06-synthesis.feature'],
    'pdf-generator.js': ['07-pdf-generation.feature'],
    'airtable-writer.js': ['08-airtable.feature'],
    'digest-email.js': ['09-digest-email.feature'],
    'client-config.json': ['11-tier-logic.feature']
  };

  return mapping[filename] || [];
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const detailed = args.includes('--detailed');

  console.log('\n🔄 Kurrent Spec Sync Agent\n');

  // 1. Check for drift between code and specs
  console.log('  Step 1: Checking code-spec drift...\n');
  const { drift, actual } = detectDrift();

  if (drift.length === 0) {
    console.log('  ✅ No drift detected — specs match code\n');
  } else {
    console.log(`  ⚠️  ${drift.length} drift point(s) detected:\n`);
    drift.forEach(d => {
      const icon = d.severity === 'high' ? '🔴' : '🟡';
      console.log(`    ${icon} ${d.key}`);
      console.log(`       Expected: ${d.expected}`);
      console.log(`       Actual:   ${d.actual}\n`);
    });
  }

  // 2. Check which files changed recently
  console.log('  Step 2: Checking recent code changes...\n');
  const recentChanges = getRecentChanges();

  if (recentChanges.length === 0) {
    console.log('  No code changes in the last 7 days\n');
  } else {
    const affectedFeatures = new Set();
    recentChanges.forEach(file => {
      mapFileToFeature(file).forEach(f => affectedFeatures.add(f));
    });

    if (affectedFeatures.size > 0) {
      console.log(`  📝 ${recentChanges.length} file(s) changed → ${affectedFeatures.size} feature(s) may need review:\n`);
      affectedFeatures.forEach(f => console.log(`    → ${f}`));
      console.log('');
    } else {
      console.log(`  ${recentChanges.length} file(s) changed but none affect BDD specs\n`);
    }
  }

  // 3. Detailed fingerprint dump
  if (detailed) {
    console.log('  Step 3: Code fingerprints:\n');
    Object.entries(actual).forEach(([key, val]) => {
      console.log(`    ${key}: ${val}`);
    });
    console.log('');
  }

  // 4. Write sync report
  const report = {
    agent: 'spec-sync',
    timestamp: new Date().toISOString(),
    driftCount: drift.length,
    drift,
    recentChanges,
    fingerprints: actual
  };

  const reportPath = path.join(__dirname, '../reports', `sync-report-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`  📄 Report: ${reportPath}\n`);

  process.exit(drift.length > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Spec Sync Agent crashed:', e);
  process.exit(2);
});
