#!/usr/bin/env node
/**
 * Kurrent BDD Runner
 *
 * Runs the BDD spec suite and outputs results.
 * Usage:
 *   node bdd/bdd-runner.js                    # Run all features
 *   node bdd/bdd-runner.js --tag @step5       # Run only Step 5 scenarios
 *   node bdd/bdd-runner.js --validate         # Validate specs match code (dry run)
 *   node bdd/bdd-runner.js --version          # Show BDD spec version
 *   node bdd/bdd-runner.js --rollback 0.9.0   # Roll back to a tagged version
 */

const fs = require('fs');
const path = require('path');

const VERSION_FILE = path.join(__dirname, '../bdd-version.json');
const FEATURES_DIR = path.join(__dirname, 'features');

// --- CLI Argument Parsing ---
const args = process.argv.slice(2);

if (args.includes('--version')) {
  const version = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
  console.log(`\nKurrent BDD Spec v${version.version}`);
  console.log(`Last updated: ${version.lastUpdated}`);
  console.log(`Total scenarios: ${version.totalScenarios}`);
  console.log(`Feature files: ${version.featureFiles.length}`);
  console.log(`\nChangelog:`);
  version.changelog.forEach(entry => {
    console.log(`  v${entry.version} (${entry.date})`);
    entry.changes.forEach(c => console.log(`    - ${c}`));
  });
  process.exit(0);
}

if (args.includes('--validate')) {
  console.log('\n🔍 Validating BDD specs against codebase...\n');
  validateSpecs();
  process.exit(0);
}

if (args.includes('--rollback')) {
  const targetVersion = args[args.indexOf('--rollback') + 1];
  if (!targetVersion) {
    console.error('Usage: --rollback <version>');
    process.exit(1);
  }
  console.log(`\n⏪ Rolling back BDD specs to v${targetVersion}...`);
  console.log('   Use: git checkout v${targetVersion}-bdd -- bdd/ bdd-version.json');
  console.log('   Or:  git log --all --oneline -- bdd/ to find the commit\n');
  process.exit(0);
}

// --- Spec Validation ---
function validateSpecs() {
  const version = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
  const issues = [];
  let totalScenarios = 0;

  // Check all feature files exist
  version.featureFiles.forEach(file => {
    const filePath = path.join(FEATURES_DIR, file);
    if (!fs.existsSync(filePath)) {
      issues.push(`❌ Missing feature file: ${file}`);
    } else {
      const content = fs.readFileSync(filePath, 'utf8');
      const scenarioCount = (content.match(/^\s*Scenario/gm) || []).length;
      totalScenarios += scenarioCount;
      console.log(`  ✅ ${file} — ${scenarioCount} scenarios`);
    }
  });

  // Check scenario count matches version file
  if (totalScenarios !== version.totalScenarios) {
    issues.push(`⚠️  Scenario count mismatch: found ${totalScenarios}, version file says ${version.totalScenarios}`);
  }

  // Check referenced source files exist
  const sourceFiles = [
    'kurrent-pipeline.js', 'digest-email.js', 'candidate-cache.js',
    'apollo-enrichment.js', 'pdl-candidates.js', 'claude-synthesis.js',
    'relevance-filter.js', 'airtable-writer.js', 'pdf-generator.js',
    'linkedin-scraper.js', 'indeed-scraper.js', 'client-config.json'
  ];
  sourceFiles.forEach(file => {
    const filePath = path.join(__dirname, '..', file);
    if (!fs.existsSync(filePath)) {
      issues.push(`⚠️  Referenced source file missing: ${file}`);
    }
  });

  console.log(`\n  Total scenarios: ${totalScenarios}`);

  if (issues.length === 0) {
    console.log('\n  ✅ All specs valid. No issues found.\n');
  } else {
    console.log(`\n  Found ${issues.length} issue(s):`);
    issues.forEach(i => console.log(`    ${i}`));
    console.log('');
  }

  return issues;
}

// --- Default: List features and scenarios ---
console.log('\n🧪 Kurrent BDD Spec Suite\n');

const version = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
console.log(`Version: ${version.version} | Last updated: ${version.lastUpdated}\n`);

const tagFilter = args.find(a => a.startsWith('--tag'));
const filterTag = tagFilter ? args[args.indexOf(tagFilter) + 1] : null;

let totalScenarios = 0;
const featureFiles = fs.readdirSync(FEATURES_DIR).filter(f => f.endsWith('.feature')).sort();

featureFiles.forEach(file => {
  const content = fs.readFileSync(path.join(FEATURES_DIR, file), 'utf8');
  const tags = (content.match(/^@.+$/m) || [''])[0];

  // Filter by tag if specified
  if (filterTag && !tags.includes(filterTag)) return;

  const featureName = (content.match(/^Feature:\s*(.+)$/m) || ['', file])[1];
  const scenarios = content.match(/^\s*Scenario[^:]*:/gm) || [];
  totalScenarios += scenarios.length;

  console.log(`  📋 ${file}`);
  console.log(`     ${featureName}`);
  console.log(`     ${tags} — ${scenarios.length} scenarios`);
  scenarios.forEach(s => {
    const name = s.replace(/^\s*Scenario[^:]*:\s*/, '');
    console.log(`       • ${name}`);
  });
  console.log('');
});

console.log(`Total: ${totalScenarios} scenarios across ${featureFiles.length} features`);
console.log(`\nTo validate: node bdd/bdd-runner.js --validate`);
console.log(`To filter:   node bdd/bdd-runner.js --tag @step5\n`);
