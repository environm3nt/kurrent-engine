#!/usr/bin/env node
/**
 * QA Agent Orchestrator
 *
 * Ties all QA agents together into a single workflow:
 *   1. Spec Sync — detect code-spec drift
 *   2. QA Runner — execute all BDD scenarios
 *   3. Bug Reporter — generate bug report from failures
 *
 * Can run on-demand or be scheduled via cron / CI.
 *
 * Usage:
 *   node bdd/agents/orchestrator.js            # Full QA cycle
 *   node bdd/agents/orchestrator.js --quick    # Skip spec sync, just run tests
 *   node bdd/agents/orchestrator.js --ci       # CI mode: exit 1 on any failure
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const REPORTS_DIR = path.join(__dirname, '../reports');
const VERSION_FILE = path.join(ROOT, 'bdd-version.json');

// Ensure reports dir exists
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

function runAgent(name, script, allowFail = false) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  🤖 Running: ${name}`);
  console.log(`${'─'.repeat(60)}\n`);

  try {
    const output = execSync(`node ${script}`, {
      cwd: ROOT,
      timeout: 60000,
      stdio: 'pipe'
    }).toString();
    console.log(output);
    return { success: true, output };
  } catch (e) {
    const output = e.stdout?.toString() || e.message;
    console.log(output);
    if (!allowFail) {
      return { success: false, output, exitCode: e.status };
    }
    return { success: true, output, warnings: true };
  }
}

function generateSummary(results) {
  const version = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
  const now = new Date().toISOString();

  const summary = {
    orchestrator: 'kurrent-qa',
    timestamp: now,
    specVersion: version.version,
    agents: results,
    overallStatus: results.every(r => r.success) ? 'PASS' : 'FAIL'
  };

  // Save orchestrator report
  const reportPath = path.join(REPORTS_DIR, `orchestrator-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));

  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const quick = args.includes('--quick');
  const ci = args.includes('--ci');

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║          🧪 Kurrent QA Agent Orchestrator                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const version = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
  console.log(`\n  BDD Spec Version: ${version.version}`);
  console.log(`  Total Scenarios:  ${version.totalScenarios}`);
  console.log(`  Run Time:         ${new Date().toISOString()}`);

  const agentResults = [];

  // --- Agent 1: Spec Sync ---
  if (!quick) {
    const syncResult = runAgent(
      'Spec Sync Agent',
      'bdd/agents/spec-sync.js',
      true // allow drift warnings without failing
    );
    agentResults.push({
      agent: 'spec-sync',
      success: syncResult.success,
      warnings: syncResult.warnings || false
    });
  }

  // --- Agent 2: QA Runner ---
  const qaResult = runAgent(
    'QA Runner Agent',
    'bdd/agents/qa-runner.js --report'
  );
  agentResults.push({
    agent: 'qa-runner',
    success: qaResult.success
  });

  // --- Agent 3: Bug Reporter (only if QA had failures) ---
  if (!qaResult.success) {
    const bugResult = runAgent(
      'Bug Reporter Agent',
      'bdd/agents/bug-reporter.js'
    );
    agentResults.push({
      agent: 'bug-reporter',
      success: bugResult.success
    });
  } else {
    agentResults.push({
      agent: 'bug-reporter',
      success: true,
      skipped: true,
      reason: 'No failures to report'
    });
  }

  // --- Summary ---
  const summary = generateSummary(agentResults);

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║          📊 Orchestrator Summary                        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  agentResults.forEach(r => {
    const icon = r.skipped ? '⏭️' : (r.success ? '✅' : '❌');
    const status = r.skipped ? 'SKIPPED' : (r.success ? 'PASS' : 'FAIL');
    const extra = r.warnings ? ' (with warnings)' : '';
    console.log(`  ${icon} ${r.agent}: ${status}${extra}`);
  });

  console.log(`\n  Overall: ${summary.overallStatus}`);
  console.log(`  Report:  ${REPORTS_DIR}/\n`);

  if (ci && summary.overallStatus === 'FAIL') {
    process.exit(1);
  }

  process.exit(0);
}

main().catch(e => {
  console.error('Orchestrator crashed:', e);
  process.exit(2);
});
