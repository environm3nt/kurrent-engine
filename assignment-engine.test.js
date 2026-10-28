/**
 * Unit tests for assignment-engine.js
 *
 * Run with: node --test assignment-engine.test.js
 *
 * Uses Node's built-in test runner (node:test, available in Node 18+) so no
 * dev dependencies are required. If you ever want richer reporting, switch
 * to: node --test --test-reporter=spec assignment-engine.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  scoreRecruiterForLead,
  assignLeads,
  assignLeadsLegacy,
  DEFAULT_WEIGHTS,
} = require('./assignment-engine');

// ============================================================================
// FIXTURES
// ============================================================================

const dana = {
  user_id: 'dana-uid',
  display_name: 'Dana',
  target_roles: [
    { title: 'Structural Engineer' },
    { title: 'Civil Engineer' },
  ],
  target_locations: ['Toronto', 'Mississauga'],
  schedule: { 'Structural Engineer': ['mon', 'tue', 'wed', 'thu', 'fri'] },
};

const jordyn = {
  user_id: 'jordyn-uid',
  display_name: 'Jordyn',
  target_roles: [
    { title: 'Structural Engineer' },
    { title: 'Project Manager' },
  ],
  target_locations: ['Vancouver'],
  schedule: {},
};

const nicole = {
  user_id: 'nicole-uid',
  display_name: 'Nicole',
  target_roles: [{ title: 'Marketing Manager' }],
  target_locations: ['Toronto'],
  schedule: { 'Marketing Manager': ['mon', 'wed', 'fri'] },
};

// ============================================================================
// scoreRecruiterForLead — role matching
// ============================================================================

test('exact role match gets the full role weight', () => {
  const lead = { id: 'l1', role_title: 'Structural Engineer', location: 'Toronto' };
  const r = scoreRecruiterForLead(lead, dana, { today: 'fri' });
  assert.equal(r.reason.role.type, 'exact');
  assert.equal(r.reason.role.points, DEFAULT_WEIGHTS.roleExact);
});

test('substring role match scores lower than exact', () => {
  const lead = { id: 'l2', role_title: 'Senior Structural Engineer - Bridges', location: 'Toronto' };
  const r = scoreRecruiterForLead(lead, dana, { today: 'fri' });
  assert.equal(r.reason.role.type, 'substring');
  assert.equal(r.reason.role.points, DEFAULT_WEIGHTS.roleSubstring);
});

test('token overlap catches reworded titles', () => {
  const lead = { id: 'l3', role_title: 'Engineer, Structural', location: 'Toronto' };
  const r = scoreRecruiterForLead(lead, dana, { today: 'fri' });
  // "Engineer, Structural" normalized → "engineer, structural", substring check
  // against "structural engineer" fails (neither contains the other exactly),
  // so token overlap should kick in: both tokens present.
  assert.ok(r.score > 0, 'should match via tokens');
  assert.equal(r.reason.role.type, 'token_overlap');
});

test('no role match returns score 0 even with location match', () => {
  const lead = { id: 'l4', role_title: 'Marketing Director', location: 'Toronto' };
  const r = scoreRecruiterForLead(lead, dana, { today: 'fri' });
  assert.equal(r.score, 0);
  assert.equal(r.reason.skipped, 'no role match');
});

test('empty lead role_title returns score 0', () => {
  const lead = { id: 'l5', role_title: '', location: 'Toronto' };
  const r = scoreRecruiterForLead(lead, dana, { today: 'fri' });
  assert.equal(r.score, 0);
});

// ============================================================================
// scoreRecruiterForLead — location
// ============================================================================

test('location match adds points on top of role score', () => {
  const leadToronto = { id: 'a', role_title: 'Structural Engineer', location: 'Toronto, ON' };
  const leadAustin = { id: 'b', role_title: 'Structural Engineer', location: 'Austin, TX' };
  const rTo = scoreRecruiterForLead(leadToronto, dana, { today: 'fri' });
  const rAu = scoreRecruiterForLead(leadAustin, dana, { today: 'fri' });
  assert.ok(rTo.score > rAu.score, 'Toronto lead should outscore Austin lead');
  assert.equal(rTo.reason.location.type, 'partial');
  assert.equal(rAu.reason.location.type, 'none');
});

test('exact location match beats partial', () => {
  const leadExact = { id: 'c', role_title: 'Structural Engineer', location: 'Toronto' };
  const leadPartial = { id: 'd', role_title: 'Structural Engineer', location: 'Toronto, ON, Canada' };
  const rE = scoreRecruiterForLead(leadExact, dana, { today: 'fri' });
  const rP = scoreRecruiterForLead(leadPartial, dana, { today: 'fri' });
  assert.equal(rE.reason.location.type, 'exact');
  assert.equal(rP.reason.location.type, 'partial');
  assert.ok(rE.reason.location.points > rP.reason.location.points);
});

// ============================================================================
// scoreRecruiterForLead — schedule
// ============================================================================

test('schedule-today bonus beats off-day', () => {
  const lead = { id: 'e', role_title: 'Structural Engineer', location: 'Toronto' };
  const rFri = scoreRecruiterForLead(lead, dana, { today: 'fri' });
  const rSun = scoreRecruiterForLead(lead, dana, { today: 'sun' });
  assert.ok(rFri.score > rSun.score, 'scheduled day should outscore off day');
  assert.equal(rFri.reason.schedule.type, 'today');
  assert.equal(rSun.reason.schedule.type, 'off-day');
});

test('recruiter with empty schedule gets "no-schedule" bonus on any day', () => {
  const lead = { id: 'f', role_title: 'Structural Engineer', location: 'Vancouver' };
  const rFri = scoreRecruiterForLead(lead, jordyn, { today: 'fri' });
  const rSun = scoreRecruiterForLead(lead, jordyn, { today: 'sun' });
  assert.equal(rFri.reason.schedule.type, 'no-schedule');
  assert.equal(rSun.reason.schedule.type, 'no-schedule');
  assert.equal(rFri.score, rSun.score);
});

// ============================================================================
// scoreRecruiterForLead — load penalty
// ============================================================================

test('load penalty reduces score linearly', () => {
  const lead = { id: 'g', role_title: 'Structural Engineer', location: 'Toronto' };
  const r0 = scoreRecruiterForLead(lead, dana, { today: 'fri', load: 0 });
  const r5 = scoreRecruiterForLead(lead, dana, { today: 'fri', load: 5 });
  const diff = r0.score - r5.score;
  assert.equal(diff, 5 * DEFAULT_WEIGHTS.loadPenalty);
});

// ============================================================================
// assignLeads — end-to-end behavior
// ============================================================================

test('location-aware assignment routes leads to the right city', () => {
  const leads = [
    { id: 'to-1', role_title: 'Structural Engineer', location: 'Toronto, ON' },
    { id: 'va-1', role_title: 'Structural Engineer', location: 'Vancouver, BC' },
  ];
  const results = assignLeads(leads, [dana, jordyn], { today: 'fri' });
  assert.equal(results[0].userId, 'dana-uid');
  assert.equal(results[1].userId, 'jordyn-uid');
});

test('load balancing distributes identical leads across tied recruiters', () => {
  // Halifax is not in either recruiter's target_locations → no location bonus
  // for either. Role and schedule are both tied (Dana has Fri scheduled,
  // Jordyn has no schedule → both pick up today-ish points). Load penalty
  // should flip the winner back and forth.
  const leads = Array.from({ length: 10 }, (_, i) => ({
    id: `hx-${i}`,
    role_title: 'Structural Engineer',
    location: 'Halifax, NS',
  }));
  const results = assignLeads(leads, [dana, jordyn], { today: 'fri' });
  const counts = results.reduce((acc, r) => {
    acc[r.userId] = (acc[r.userId] || 0) + 1;
    return acc;
  }, {});
  // Both should get at least 3 — not one hoarding all 10
  assert.ok(counts['dana-uid'] >= 3, `dana got ${counts['dana-uid']}`);
  assert.ok(counts['jordyn-uid'] >= 3, `jordyn got ${counts['jordyn-uid']}`);
});

test('legacy mode would hoard all leads to first recruiter', () => {
  // This is the BAD behavior the new engine fixes. Proving it here so we
  // have a regression baseline and can point to it when explaining why the
  // weighted engine exists.
  const leads = Array.from({ length: 10 }, (_, i) => ({
    id: `l${i}`,
    role_title: 'Structural Engineer',
  }));
  const results = assignLeadsLegacy(leads, [dana, jordyn]);
  const counts = results.reduce((acc, r) => {
    acc[r.userId] = (acc[r.userId] || 0) + 1;
    return acc;
  }, {});
  assert.equal(counts['dana-uid'], 10);
  assert.equal(counts['jordyn-uid'], undefined);
});

test('fallback user receives unmatched leads', () => {
  const leads = [{ id: 'mkt-1', role_title: 'Marketing Director', location: 'Toronto' }];
  const results = assignLeads(leads, [dana, jordyn], {
    fallbackUserId: 'admin-uid',
    today: 'fri',
  });
  assert.equal(results[0].userId, 'admin-uid');
  assert.equal(results[0].matched, false);
  assert.equal(results[0].reason.fallback, true);
});

test('no fallback and no match leaves lead unassigned', () => {
  const leads = [{ id: 'mkt-2', role_title: 'Marketing Director', location: 'Toronto' }];
  const results = assignLeads(leads, [dana, jordyn], { today: 'fri' });
  assert.equal(results[0].userId, null);
  assert.equal(results[0].matched, false);
  assert.equal(results[0].reason.unmatched, true);
});

test('Marketing Manager lead goes to Nicole (only matching recruiter)', () => {
  const leads = [{ id: 'mkt-3', role_title: 'Marketing Manager', location: 'Toronto' }];
  const results = assignLeads(leads, [dana, jordyn, nicole], { today: 'fri' });
  assert.equal(results[0].userId, 'nicole-uid');
  assert.equal(results[0].reason.role.type, 'exact');
});

test('Marketing Manager lead on Tuesday (not in Nicole schedule) still goes to Nicole', () => {
  // Nicole is scheduled Mon/Wed/Fri for Marketing Manager. On Tuesday she
  // loses the schedule bonus but is still the only matching recruiter, so
  // she should still win over total-miss recruiters.
  const leads = [{ id: 'mkt-4', role_title: 'Marketing Manager', location: 'Toronto' }];
  const results = assignLeads(leads, [dana, jordyn, nicole], { today: 'tue' });
  assert.equal(results[0].userId, 'nicole-uid');
  assert.equal(results[0].reason.schedule.type, 'off-day');
});

test('existingLoads seed influences the first assignment', () => {
  // If Dana already has 20 leads today, the first new identical lead
  // should skip her in favor of Jordyn (assuming the 100-point load penalty
  // exceeds any advantage Dana has).
  const leads = [{ id: 'x', role_title: 'Structural Engineer', location: 'Halifax' }];
  const results = assignLeads(leads, [dana, jordyn], {
    today: 'fri',
    existingLoads: new Map([['dana-uid', 20]]),
  });
  // Dana: role(100) + loc(0) + sched-today(20) - load(100) = 20
  // Jordyn:   role(100) + loc(0) + sched-noschedule(10) - load(0) = 110
  assert.equal(results[0].userId, 'jordyn-uid');
});

test('alternatives list contains next-best recruiters for audit trail', () => {
  const leads = [{ id: 'to-x', role_title: 'Structural Engineer', location: 'Toronto' }];
  const results = assignLeads(leads, [dana, jordyn], { today: 'fri' });
  assert.ok(Array.isArray(results[0].alternatives));
  assert.equal(results[0].alternatives.length, 1);
  assert.equal(results[0].alternatives[0].userId, 'jordyn-uid');
});
