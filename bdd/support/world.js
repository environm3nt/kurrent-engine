/**
 * BDD World — shared state for all step definitions
 *
 * This module provides the test context that persists across steps within a scenario.
 * It also sets up mocks/stubs for external APIs so BDD tests run without real credentials.
 */

const path = require('path');

class KurrentWorld {
  constructor() {
    // Pipeline state
    this.clientConfig = null;
    this.jobs = [];
    this.deduplicatedJobs = [];
    this.enrichedJobs = [];
    this.candidates = [];
    this.synthesisResults = [];
    this.airtableRecords = [];
    this.digestHTML = null;
    this.metrics = {};
    this.errors = [];

    // Mock responses (set per scenario)
    this.mocks = {
      linkedinJobs: null,
      indeedJobs: null,
      apolloCompany: null,
      apolloContact: null,
      pdlCandidates: null,
      claudeSynthesis: null,
      pdfMonkey: null,
      airtable: null,
      resend: null
    };

    // API call tracking
    this.apiCalls = {
      linkedin: [],
      indeed: [],
      apollo: [],
      pdl: [],
      claude: [],
      pdfmonkey: [],
      airtable: [],
      resend: []
    };

    // Cache state
    this.cache = {};
    this.cacheHits = 0;
    this.cacheMisses = 0;

    // Pipeline options
    this.testMode = false;
    this.pipelineResult = null;
  }

  /**
   * Load the real client config from disk
   */
  loadClientConfig() {
    const configPath = path.join(__dirname, '../../client-config.json');
    this.clientConfig = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
    return this.clientConfig;
  }

  /**
   * Create a minimal test client config
   */
  createTestConfig(overrides = {}) {
    this.clientConfig = {
      clientId: 'test-001',
      agencyName: 'Test Agency',
      tier: 'starter',
      targetRoles: [
        { title: 'Legal Assistant', function: 'Legal', seniority: 'IC' },
        { title: 'Paralegal', function: 'Legal', seniority: 'IC' }
      ],
      targetLocations: ['Toronto Ontario Canada'],
      maxResultsPerRole: 3,
      digestRecipients: {
        to: ['test@example.com'],
        cc: [],
        from: 'Kurrent <kurrent@kurrentlabs.com>',
        replyTo: 'test@example.com'
      },
      digestSendTime: '07:00',
      timezone: 'America/Toronto',
      airtableBaseId: 'appTEST123',
      whiteLabel: true,
      brandPrimaryHex: '#0A1F8F',
      brandPrimaryColor: '#0A1F8F',
      brandAccentColor: '#FFFFFF',
      agencyInitials: 'HG',
      ...overrides
    };
    return this.clientConfig;
  }

  /**
   * Track an API call for assertion
   */
  trackApiCall(service, { method, url, data, response }) {
    this.apiCalls[service].push({ method, url, data, response, timestamp: Date.now() });
  }

  /**
   * Get count of API calls to a service
   */
  getApiCallCount(service) {
    return this.apiCalls[service].length;
  }

  /**
   * Reset all state between scenarios
   */
  reset() {
    this.jobs = [];
    this.deduplicatedJobs = [];
    this.enrichedJobs = [];
    this.candidates = [];
    this.synthesisResults = [];
    this.airtableRecords = [];
    this.digestHTML = null;
    this.metrics = {};
    this.errors = [];
    this.cache = {};
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.testMode = false;
    this.pipelineResult = null;

    Object.keys(this.mocks).forEach(k => this.mocks[k] = null);
    Object.keys(this.apiCalls).forEach(k => this.apiCalls[k] = []);
  }
}

module.exports = KurrentWorld;
