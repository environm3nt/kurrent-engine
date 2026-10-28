#!/usr/bin/env node
/**
 * Secure Config Loader
 *
 * Single entry point for loading all configuration and secrets.
 * Validates that required env vars are set before the pipeline runs.
 * Masks sensitive values in logs. Provides a clean API for all modules.
 *
 * Usage:
 *   const config = require('./security/config-loader');
 *   config.validate();           // Throws if required vars missing
 *   config.get('APOLLO_API_KEY') // Returns the key
 *   config.mask('sk-ant-abc123') // Returns 'sk-ant-***'
 *   config.loadClientConfig()    // Returns client-config.json safely
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// --- Required environment variables by pipeline step ---
const REQUIRED_VARS = {
  core: ['CLAUDE_API_KEY'],
  scraping: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'],
  enrichment: ['APOLLO_API_KEY'],
  database: ['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID'],
  email: ['RESEND_API_KEY']
};

const OPTIONAL_VARS = {
  candidates: ['PDL_API_KEY'],
  pdf: ['PDFMONKEY_API_KEY'],
  linkedin: ['LINKEDIN_EMAIL', 'LINKEDIN_PASSWORD'],
  payments: ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY'],
  auth: ['SUPABASE_URL', 'SUPABASE_ANON_KEY'],
  supabaseWrite: ['SUPABASE_SERVICE_ROLE_KEY']
};

// --- Masking ---

function mask(value) {
  if (!value || typeof value !== 'string') return '(not set)';
  if (value.length <= 8) return '***';

  // Show prefix for identifiable key types
  if (value.startsWith('ghp_')) return `ghp_***${value.slice(-4)}`;
  if (value.startsWith('sk-ant-')) return `sk-ant-***${value.slice(-4)}`;
  if (value.startsWith('re_')) return `re_***${value.slice(-4)}`;
  if (value.startsWith('app')) return `app***${value.slice(-4)}`; // Airtable base IDs
  if (value.startsWith('pat')) return `pat***${value.slice(-4)}`; // Airtable PATs
  if (value.includes('@')) return maskEmail(value);

  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

// --- Getters ---

function get(key) {
  return process.env[key] || null;
}

function getRequired(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

// --- Validation ---

function validate(options = {}) {
  const { skipOptional = true, quiet = false } = options;
  const missing = [];
  const present = [];
  const warnings = [];

  // Check required vars
  Object.entries(REQUIRED_VARS).forEach(([group, vars]) => {
    vars.forEach(v => {
      if (process.env[v]) {
        present.push({ key: v, group, masked: mask(process.env[v]) });
      } else {
        missing.push({ key: v, group });
      }
    });
  });

  // Check optional vars
  if (!skipOptional) {
    Object.entries(OPTIONAL_VARS).forEach(([group, vars]) => {
      vars.forEach(v => {
        if (process.env[v]) {
          present.push({ key: v, group, masked: mask(process.env[v]) });
        } else {
          warnings.push({ key: v, group, message: `Optional: ${v} not set (${group} features disabled)` });
        }
      });
    });
  }

  if (!quiet) {
    console.log('\n🔐 Config Validation\n');
    if (present.length > 0) {
      present.forEach(p => console.log(`  ✅ ${p.key} = ${p.masked}`));
    }
    if (warnings.length > 0) {
      console.log('');
      warnings.forEach(w => console.log(`  ⚠️  ${w.message}`));
    }
    if (missing.length > 0) {
      console.log('');
      missing.forEach(m => console.log(`  ❌ ${m.key} (${m.group}) — REQUIRED`));
    }
    console.log('');
  }

  return {
    valid: missing.length === 0,
    present,
    missing,
    warnings
  };
}

// --- Client Config ---

function loadClientConfig() {
  const configPath = path.join(ROOT, 'client-config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(
      'client-config.json not found. Copy client-config.example.json and fill in your values.'
    );
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// --- Sensitive Data Detection ---
// Use this to scan strings before logging them

const SENSITIVE_PATTERNS = [
  /ghp_[A-Za-z0-9]{36}/g,           // GitHub PAT
  /sk-ant-[A-Za-z0-9_-]{20,}/g,     // Claude API key
  /re_[A-Za-z0-9]{20,}/g,           // Resend API key
  /pat[A-Za-z0-9]{14}\.[A-Za-z0-9]{64}/g, // Airtable PAT
  /key-live-[A-Za-z0-9]+/g,         // PDFMonkey
  /[A-Za-z0-9]{32,}/g               // Generic long tokens (catch-all)
];

function redactSecrets(text) {
  let redacted = text;
  // Specific patterns first
  SENSITIVE_PATTERNS.slice(0, -1).forEach(pattern => {
    redacted = redacted.replace(pattern, match => mask(match));
  });
  return redacted;
}

function safelog(message) {
  console.log(redactSecrets(String(message)));
}

// --- Exports ---

module.exports = {
  get,
  getRequired,
  mask,
  maskEmail,
  validate,
  loadClientConfig,
  redactSecrets,
  safelog,
  REQUIRED_VARS,
  OPTIONAL_VARS
};

// Run validation if called directly
if (require.main === module) {
  const result = validate({ skipOptional: false });
  if (!result.valid) {
    console.error('❌ Configuration invalid. Set missing environment variables in .env\n');
    process.exit(1);
  } else {
    console.log('✅ All required configuration present.\n');
  }
}
