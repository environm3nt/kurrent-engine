#!/usr/bin/env node
/**
 * Bug Reporter Agent
 *
 * Runs the QA suite, captures failures, and generates structured bug reports.
 * Designed to run on a schedule or after every code change.
 *
 * Output: Markdown bug report + JSON for programmatic consumption.
 *
 * Usage:
 *   node bdd/agents/bug-reporter.js                  # Run and report
 *   node bdd/agents/bug-reporter.js --github          # Create GitHub issues (future)
 *   node bdd/agents/bug-reporter.js --history         # Show historical trends
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '../..');
const REPORTS_DIR = path.join(__dirname, '../reports');

function getGitInfo() {
  try {
    const commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT }).toString().trim();
    const message = execSync('git log -1 --pretty=%s', { cwd: ROOT }).toString().trim();
    const author = execSync('git log -1 --pretty=%an', { cwd: ROOT }).toString().trim();
    return { commit, branch, message, author };
  } catch (e) {
    return { commit: 'unknown', branch: 'unknown', message: '', author: '' };
  }
}

function runQaSuite() {
  try {
    const output = execSync('node bdd/agents/qa-runner.js --report 2>&1', {
      cwd: ROOT,
      timeout: 30000
    }).toString();
    return { exitCode: 0, output };
  } catch (e) {
    return { exitCode: e.status || 1, output: e.stdout?.toString() || e.message };
  }
}

function getLatestReport() {
  const files = fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('qa-report-') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) return null;
  return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, files[0]), 'utf8'));
}

function getReportHistory(limit = 10) {
  const files = fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('qa-report-') && f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit);

  return files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8'));
    return {
      file: f,
      timestamp: data.timestamp,
      passed: data.passed.length || data.passed,
      failed: data.failed.length || data.failed,
      total: data.total
    };
  });
}

function generateBugReport(qaReport, gitInfo) {
  const now = new Date().toISOString();
  const failures = qaReport.failed || [];

  if (failures.length === 0) {
    return {
      markdown: `# ✅ Kurrent QA Report — All Clear\n\n**Date:** ${now}\n**Commit:** ${gitInfo.commit} (${gitInfo.branch})\n**Result:** ${qaReport.passed} passed, 0 failed\n\nNo bugs detected.\n`,
      json: { status: 'clean', bugs: [], timestamp: now, git: gitInfo }
    };
  }

  // Categorize bugs by severity
  const bugs = failures.map((f, i) => {
    const scenario = typeof f === 'string' ? f : f.scenario;
    const error = typeof f === 'string' ? '' : (f.error || '');

    // Infer severity from the test area
    let severity = 'medium';
    if (scenario.includes('Cache') || scenario.includes('Config')) severity = 'high';
    if (scenario.includes('Scoring') || scenario.includes('Tier')) severity = 'high';
    if (scenario.includes('Airtable') || scenario.includes('Digest')) severity = 'medium';
    if (scenario.includes('Dedup')) severity = 'low';

    return {
      id: `BUG-${Date.now()}-${i}`,
      scenario,
      error,
      severity,
      category: scenario.split(':')[0]?.trim() || 'Unknown',
      suggestedFix: inferFix(scenario, error)
    };
  });

  // Generate markdown report
  const md = `# 🐛 Kurrent Bug Report

**Date:** ${now}
**Commit:** ${gitInfo.commit} (${gitInfo.branch})
**Last commit:** ${gitInfo.message}
**Author:** ${gitInfo.author}

## Summary

| Metric | Value |
|--------|-------|
| Total tests | ${qaReport.total} |
| Passed | ${typeof qaReport.passed === 'number' ? qaReport.passed : qaReport.passed.length} |
| Failed | ${failures.length} |
| Skipped | ${typeof qaReport.skipped === 'number' ? qaReport.skipped : (qaReport.skipped?.length || 0)} |

## Bugs Found

${bugs.map(bug => `### ${bug.id} [${bug.severity.toUpperCase()}]

**Scenario:** ${bug.scenario}
**Error:** ${bug.error}
**Category:** ${bug.category}
**Suggested fix:** ${bug.suggestedFix}

---
`).join('\n')}

## Trend

${getReportHistory(5).map(h => `- ${h.timestamp}: ${h.passed}✅ ${h.failed}❌ / ${h.total} total`).join('\n')}
`;

  return {
    markdown: md,
    json: { status: 'bugs_found', bugs, timestamp: now, git: gitInfo, summary: qaReport }
  };
}

function inferFix(scenario, error) {
  if (error.includes('null') || error.includes('undefined')) {
    return 'Add null check or default value for the failing field';
  }
  if (error.includes('Expected') && error.includes('got')) {
    return 'Logic mismatch — verify the expected behavior matches the implementation';
  }
  if (error.includes('not loadable') || error.includes('Cannot find module')) {
    return 'Module missing or path incorrect — check require() paths';
  }
  if (error.includes('mapping') || error.includes('map')) {
    return 'Update the mapping object to include the missing key';
  }
  return 'Review the scenario in the .feature file and compare against the implementation';
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--history')) {
    console.log('\n📊 QA Report History\n');
    getReportHistory(10).forEach(h => {
      const status = h.failed > 0 ? '❌' : '✅';
      console.log(`  ${status} ${h.timestamp} — ${h.passed} passed, ${h.failed} failed / ${h.total}`);
    });
    console.log('');
    process.exit(0);
  }

  console.log('\n🐛 Kurrent Bug Reporter Agent\n');
  console.log('  Step 1: Running QA suite...');

  const gitInfo = getGitInfo();
  console.log(`  Commit: ${gitInfo.commit} (${gitInfo.branch})`);

  // Run QA
  const { exitCode, output } = runQaSuite();
  console.log(output);

  // Get the report QA runner generated
  const qaReport = getLatestReport();
  if (!qaReport) {
    console.error('  ❌ No QA report generated. Check qa-runner output above.');
    process.exit(1);
  }

  // Generate bug report
  console.log('  Step 2: Generating bug report...\n');
  const { markdown, json } = generateBugReport(qaReport, gitInfo);

  // Save reports
  const timestamp = Date.now();
  const mdPath = path.join(REPORTS_DIR, `bug-report-${timestamp}.md`);
  const jsonPath = path.join(REPORTS_DIR, `bug-report-${timestamp}.json`);

  fs.writeFileSync(mdPath, markdown);
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));

  console.log(`  📄 Markdown report: ${mdPath}`);
  console.log(`  📄 JSON report:     ${jsonPath}`);

  const bugCount = json.bugs?.length || 0;
  if (bugCount > 0) {
    console.log(`\n  🐛 ${bugCount} bug(s) found. Review the report for details.\n`);
  } else {
    console.log(`\n  ✅ All clear — no bugs detected.\n`);
  }

  process.exit(bugCount > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Bug Reporter crashed:', e);
  process.exit(2);
});
