/**
 * End-to-end pipeline test.
 *
 * Runs all ten stages of runPipeline() with every external module replaced
 * by an in-process stub, so the orchestration itself — stage order, the
 * metrics.steps handoff between stages, error isolation, tier gating — is
 * exercised without any network, keys or database.
 *
 * Stubs are installed into require.cache before kurrent-pipeline.js loads,
 * so the pipeline's own `require('./x')` lines resolve to them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const calls = {};
function record(name, ...args) { (calls[name] ||= []).push(args); }

function stub(relPath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsObj };
}

const sampleJobs = require('./samples/jobs.sample.json');

// ---- external modules -------------------------------------------------------
stub('security/config-loader.js', {
  validate: () => true,
  get: (k) => process.env[k] || '',
  mask: (v) => v,
});
stub('linkedin-scraper.js', {
  scrapeLinkedInJobs: async ({ roleTitle }) => {
    record('scrapeLinkedInJobs', roleTitle);
    const jobs = sampleJobs.filter(j => j.roleTitle === roleTitle);
    return jobs;
  },
  scrapeLinkedInCandidates: async () => ({ candidates: [] }),
});
stub('apollo-enrichment.js', {
  enrichCompany: async (name) => { record('enrichCompany', name); return { domain: `${name.toLowerCase().replace(/[^a-z]/g, '')}.example`, headcount: 400, industry: 'Engineering', foundedYear: 1992 }; },
  findContact: async (name) => { record('findContact', name); return { fullName: 'Maria R.', title: 'Talent Acquisition Manager', email: 'm.r@example.com', contactQuality: 'verified', source: 'pdl-tier1' }; },
  batchEnrichCompanies: async () => [],
});
stub('pdl-candidates.js', {
  findCandidates: async (roleTitle) => { record('findCandidates', roleTitle); return [{ fullName: 'James K.', currentTitle: 'Senior Structural Engineer', yearsExperience: 12, location: 'Toronto, ON', topSkills: ['Bridges'] }]; },
  scoreCandidates: async (c) => c.map(x => ({ ...x, matchLabel: 'WARM' })),
});
stub('candidate-cache.js', {
  getCachedCandidates: async () => null,
  setCachedCandidates: async () => true,
  getCacheStats: async () => ({ totalEntries: 0 }),
  pruneExpired: async () => 0,
});
stub('enrichment-cache.js', {
  getCachedEnrichment: async () => ({ company: null, contact: null, hitType: 'miss' }),
  getEnrichmentCacheStats: async () => ({ companies: 0, contacts: 0 }),
});
// The pipeline destructures these at load time, so tests swap behaviour through `impl`.
const impl = {
  synthesize: async ({ companyName, roleTitle }) => { record('synthesizeIntelligence', companyName); return { companyName, roleTitle, salaryRange: '$120K–$155K', timeToFill: '45-60 days', marketNarrative: 'Tight market.', salesTalkingPoints: ['a'], candidatePitchPoints: ['b'] }; },
};
stub('claude-synthesis.js', {
  getMarketContext: async (roleTitle) => { record('getMarketContext', roleTitle); return { salaryRange: '$120K–$155K', timeToFill: '45-60 days' }; },
  synthesizeIntelligence: (...args) => impl.synthesize(...args),
});
stub('skill-extractor.js', { extractSearchSkills: async () => ({ skills: ['bridge design'], source: 'stub' }) });
stub('pdf-generator.js', { generateReport: async () => 'https://example.com/report.pdf', uploadToOneDrive: async () => null });
stub('airtable-writer.js', { batchWriteLeads: async () => ({ written: 0 }) });
stub('supabase-writer.js', { writeLeadsToSupabase: async (clientId, leads) => { record('writeLeadsToSupabase', leads); return { written: leads.length, skipped: 0 }; }, isConfigured: () => true });
stub('digest-email.js', { sendDigest: async () => true, sendRunSummaryToOps: async (m) => { record('sendRunSummaryToOps', m.runId); return true; } });
stub('cost-tracker.js', {
  createCostTracker: () => ({
    track: (service) => record('cost', service),
    flush: async () => { record('flush'); return true; },
    getSummary: () => ({}),
  }),
});
// relevance-filter.js is pure (reads relevance-config.json) — use the real module.

const { runPipeline, STAGES, TIER_CONFIG } = require('./kurrent-pipeline');

const baseConfig = {
  clientId: 'test-001',
  agencyName: 'Test Agency',
  targetRoles: [
    { title: 'Senior Structural Engineer', function: 'Engineering', seniority: 'IC' },
    { title: 'Project Manager', function: 'Construction', seniority: 'Manager' },
    { title: 'Paralegal', function: 'Legal', seniority: 'IC' },
  ],
  targetLocations: ['Toronto Ontario Canada'],
  maxResultsPerRole: 3,
  digestRecipients: { to: ['test@example.com'], from: 'kurrent@kurrentlabs.com' },
};

test.beforeEach(() => { for (const k of Object.keys(calls)) delete calls[k]; });

test('STAGES lists the ten stages plus sub-stages, in order', () => {
  const names = STAGES.map(f => f.name);
  assert.deepEqual(names, [
    'stageJobDiscovery', 'stageDeduplication', 'stageMarketContext', 'stageCompanyEnrichment',
    'stageStaffingAgencyFilter', 'stageCandidateScoring', 'stageIntelligenceSynthesis',
    'stagePdfGeneration', 'stageLeadRecords', 'stageSupabaseWrite', 'stageAutoAssign',
    'stageDigestDeferral', 'stageRunSummary',
  ]);
});

test('growth tier: every stage runs and hands its output to the next', async () => {
  const metrics = await runPipeline({ ...baseConfig, tier: 'growth' });

  // 1 → 2: four postings in, three unique company/role pairs out
  assert.equal(metrics.jobsDiscovered, 4);
  assert.equal(metrics.steps.deduplication.status, 'completed');
  assert.equal(metrics.steps.deduplication.jobsList.length, 3);

  // 3: one market-context call per unique role
  assert.equal(calls.getMarketContext.length, 3);
  assert.equal(metrics.steps.marketContext.status, 'completed');

  // 4: enrichment + contact waterfall ran per company
  assert.equal(calls.enrichCompany.length, 3);
  assert.equal(calls.findContact.length, 3);
  assert.equal(metrics.companiesEnriched, 3);

  // 5: bulk candidate scoring is skipped — candidate search moved on-demand to the portal
  assert.equal(metrics.steps.candidateScoring.status, 'skipped');
  assert.equal(calls.findCandidates, undefined);

  // 6: synthesis per lead
  assert.equal(calls.synthesizeIntelligence.length, 3);
  assert.equal(metrics.intelligenceSynthesized, 3);

  // 7: PDFs are on-demand by default
  assert.equal(metrics.steps.pdfGeneration.status, 'skipped');

  // 8 → 8b: lead records built and mirrored
  const written = calls.writeLeadsToSupabase[0][0];
  assert.equal(written.length, 3);
  assert.equal(metrics.steps.supabaseWrite.status, 'completed');
  assert.equal(metrics.steps.airtableWrite.status, 'skipped'); // Airtable sink is deprecated
  const lead = written.find(r => r['Company Name'] === 'Northgate Engineering');
  assert.equal(lead['Role Title'], 'Senior Structural Engineer');
  assert.equal(lead['Salary Range'], '$120,000 - $155,000'); // scraped salary wins over the LLM estimate
  assert.equal(lead['Contact Quality'], 'Verified');
  assert.equal(lead['Hiring Contact Name'], 'Maria R.');

  // 9: digest deferred to send-digest.js
  assert.equal(metrics.steps.digestEmail.status, 'deferred');

  // 10: summary sent, costs flushed, run closed out
  assert.equal(calls.sendRunSummaryToOps.length, 1);
  assert.ok(calls.flush.length >= 1);
  assert.ok(metrics.endTime);
  assert.deepEqual(metrics.errors, []);
});

test('tier config caps roles and locations', async () => {
  assert.equal(TIER_CONFIG.starter.maxRoles, 6);
  assert.equal(TIER_CONFIG.starter.includeCandidates, false);
  const metrics = await runPipeline({ ...baseConfig, tier: 'starter', targetLocations: ['Toronto Ontario Canada', 'Vancouver BC Canada'] });
  // starter: 1 location → 3 roles × 1 location = 3 scrapes
  assert.equal(calls.scrapeLinkedInJobs.length, 3);
  assert.equal(metrics.steps.candidateScoring.status, 'skipped');
});

test('test mode limits the run to one role and one location', async () => {
  await runPipeline({ ...baseConfig, tier: 'growth' }, { testMode: true });
  assert.equal(calls.scrapeLinkedInJobs.length, 1);
});

test('a failing stage is recorded and the run continues', async () => {
  const original = impl.synthesize;
  impl.synthesize = async () => { throw new Error('boom'); };
  try {
    const metrics = await runPipeline({ ...baseConfig, tier: 'growth' });
    // per-lead synthesis failures are tolerated; later stages still ran
    assert.equal(metrics.intelligenceSynthesized, 0);
    assert.equal(metrics.steps.supabaseWrite.status, 'completed');
    assert.equal(metrics.steps.runSummary.status, 'completed');
  } finally {
    impl.synthesize = original;
  }
});
