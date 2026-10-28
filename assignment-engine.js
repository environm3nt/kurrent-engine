/**
 * Kurrent Assignment Engine
 *
 * Replaces the original Step 8c first-match-wins logic with a weighted
 * scoring function that considers role fit, location, schedule, and current
 * load. Designed to be pure (no DB access) so it can be unit tested and
 * dropped into the pipeline behind a feature flag.
 *
 * Scoring model (see DEFAULT_WEIGHTS):
 *
 *   score = roleScore + locationScore + scheduleScore − loadPenalty
 *
 * Role match is a HARD GATE — if the lead's role_title doesn't match any of
 * the recruiter's target_roles (exact, substring, or token overlap), the
 * total score is 0 and the recruiter is skipped entirely. This prevents a
 * Marketing Director lead from going to a Structural Engineer recruiter
 * just because they happen to share a city.
 *
 * Usage:
 *
 *   const { assignLeads } = require('./assignment-engine');
 *   const results = assignLeads(unassignedLeads, recruiterConfigs, {
 *     today: 'fri',
 *     fallbackUserId: 'admin-uid',
 *     existingLoads: new Map([['uid-1', 3]]),  // for mid-day re-runs
 *   });
 *
 *   // results = [{ leadId, userId, score, reason, matched, alternatives }]
 */

const DEFAULT_WEIGHTS = {
  roleExact: 100,         // exact title match
  roleSubstring: 60,      // title contains configRole or vice versa
  roleTokenOverlap: 30,   // ≥50% of config title's tokens appear in lead title
  locationExact: 40,      // city strings identical
  locationPartial: 24,    // one contains the other (e.g. "Toronto, ON" ⊃ "Toronto")
  scheduleToday: 20,      // recruiter has this role scheduled for today
  scheduleAllDays: 10,    // no schedule set = active every day
  loadPenalty: 5,         // subtracted per lead already assigned to this recruiter today
};

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function normalize(s) {
  return (s || '').toString().toLowerCase().trim();
}

function tokenize(s) {
  return normalize(s)
    .split(/[\s\-\/,()]+/)
    .filter(t => t.length > 2);
}

/**
 * Score how well a single recruiter matches a single lead.
 * Returns { score, reason } where reason is a structured object explaining
 * which component contributed what — useful for audit logging and debugging.
 */
function scoreRecruiterForLead(lead, recruiter, options = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(options.weights || {}) };
  const load = options.load || 0;
  const today = options.today || DAY_KEYS[new Date().getDay()];

  const leadRole = normalize(lead.role_title);
  const leadLoc = normalize(lead.location);
  const leadTokens = tokenize(lead.role_title);

  if (!leadRole) {
    return { score: 0, reason: { skipped: 'lead has no role_title' } };
  }

  // ===== ROLE MATCH (hard gate) =====
  let roleScore = 0;
  let matchedRoleLower = null;
  let matchedRoleOriginal = null;
  let matchType = null;

  for (const role of recruiter.target_roles || []) {
    const originalTitle = typeof role === 'string' ? role : role.title;
    const configTitle = normalize(originalTitle);
    if (!configTitle) continue;

    let thisRoleScore = 0;
    let thisMatchType = null;

    if (leadRole === configTitle) {
      thisRoleScore = weights.roleExact;
      thisMatchType = 'exact';
    } else if (leadRole.includes(configTitle) || configTitle.includes(leadRole)) {
      thisRoleScore = weights.roleSubstring;
      thisMatchType = 'substring';
    } else {
      const configTokens = tokenize(configTitle);
      if (configTokens.length > 0) {
        const overlap = configTokens.filter(t => leadTokens.includes(t)).length;
        const ratio = overlap / configTokens.length;
        if (ratio >= 0.5) {
          thisRoleScore = Math.round(weights.roleTokenOverlap * ratio);
          thisMatchType = 'token_overlap';
        }
      }
    }

    if (thisRoleScore > roleScore) {
      roleScore = thisRoleScore;
      matchedRoleLower = configTitle;
      matchedRoleOriginal = originalTitle;
      matchType = thisMatchType;
    }
  }

  if (roleScore === 0) {
    return { score: 0, reason: { skipped: 'no role match' } };
  }

  // ===== LOCATION MATCH (additive) =====
  let locationScore = 0;
  let matchedLocation = null;
  let locationType = 'none';

  if (leadLoc && recruiter.target_locations) {
    for (const loc of recruiter.target_locations) {
      const configLoc = normalize(loc);
      if (!configLoc) continue;

      let thisLocScore = 0;
      let thisLocType = null;

      if (leadLoc === configLoc) {
        thisLocScore = weights.locationExact;
        thisLocType = 'exact';
      } else if (leadLoc.includes(configLoc) || configLoc.includes(leadLoc)) {
        thisLocScore = weights.locationPartial;
        thisLocType = 'partial';
      }

      if (thisLocScore > locationScore) {
        locationScore = thisLocScore;
        matchedLocation = configLoc;
        locationType = thisLocType;
      }
    }
  }

  // ===== SCHEDULE MATCH (additive) =====
  let scheduleScore = 0;
  let scheduleType = 'none';

  const schedule = recruiter.schedule || {};
  const scheduleDays = schedule[matchedRoleOriginal];

  if (!scheduleDays || scheduleDays.length === 0) {
    // No schedule entry for this role → active every day
    scheduleScore = weights.scheduleAllDays;
    scheduleType = 'no-schedule';
  } else if (scheduleDays.includes(today)) {
    scheduleScore = weights.scheduleToday;
    scheduleType = 'today';
  } else {
    scheduleScore = 0;
    scheduleType = 'off-day';
  }

  // ===== LOAD PENALTY =====
  const loadPenalty = load * weights.loadPenalty;

  const total = roleScore + locationScore + scheduleScore - loadPenalty;

  return {
    score: total,
    reason: {
      role: { type: matchType, matched: matchedRoleOriginal, points: roleScore },
      location: { type: locationType, matched: matchedLocation, points: locationScore },
      schedule: { type: scheduleType, points: scheduleScore },
      load: { current: load, penalty: loadPenalty },
      total,
    },
  };
}

/**
 * Assign a batch of leads to recruiters using the weighted scoring engine.
 * Maintains a running load counter so each assignment influences the next —
 * two identical leads in the same batch won't both go to the same recruiter
 * unless there's no one else who matches.
 *
 * @param {Array} leads - array of lead objects with at least { id, role_title, location }
 * @param {Array} recruiters - recruiter_configs rows with target_roles, target_locations, schedule, user_id
 * @param {Object} options
 * @param {Object} [options.weights] - override DEFAULT_WEIGHTS
 * @param {string} [options.fallbackUserId] - user to receive unmatched leads (omit = leave null)
 * @param {string} [options.today] - day key override for tests (defaults to today)
 * @param {Map}    [options.existingLoads] - Map<user_id, currentLoad> to seed the counter
 * @returns {Array<{leadId, userId, score, reason, matched, alternatives}>}
 */
function assignLeads(leads, recruiters, options = {}) {
  const loads = new Map(options.existingLoads || []);
  const today = options.today || DAY_KEYS[new Date().getDay()];
  const results = [];

  for (const lead of leads) {
    const scored = recruiters
      .map(r => {
        const load = loads.get(r.user_id) || 0;
        const result = scoreRecruiterForLead(lead, r, { ...options, load, today });
        return { recruiter: r, ...result };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => {
        // Primary: higher score wins
        if (b.score !== a.score) return b.score - a.score;
        // Tiebreak: lower load wins (more balanced)
        const aLoad = loads.get(a.recruiter.user_id) || 0;
        const bLoad = loads.get(b.recruiter.user_id) || 0;
        if (aLoad !== bLoad) return aLoad - bLoad;
        // Final tiebreak: stable by user_id
        return a.recruiter.user_id.localeCompare(b.recruiter.user_id);
      });

    if (scored.length > 0) {
      const winner = scored[0];
      const currentLoad = loads.get(winner.recruiter.user_id) || 0;
      loads.set(winner.recruiter.user_id, currentLoad + 1);
      results.push({
        leadId: lead.id,
        userId: winner.recruiter.user_id,
        score: winner.score,
        reason: winner.reason,
        matched: true,
        alternatives: scored.slice(1, 3).map(s => ({
          userId: s.recruiter.user_id,
          score: s.score,
        })),
      });
    } else if (options.fallbackUserId) {
      const currentLoad = loads.get(options.fallbackUserId) || 0;
      loads.set(options.fallbackUserId, currentLoad + 1);
      results.push({
        leadId: lead.id,
        userId: options.fallbackUserId,
        score: 0,
        reason: { fallback: true, note: 'no recruiter matched — routed to fallback user' },
        matched: false,
        alternatives: [],
      });
    } else {
      results.push({
        leadId: lead.id,
        userId: null,
        score: 0,
        reason: { unmatched: true, note: 'no recruiter matched and no fallback configured' },
        matched: false,
        alternatives: [],
      });
    }
  }

  return results;
}

/**
 * Legacy first-match-wins assignment. Matches the original Step 8c behavior
 * exactly, for backwards compatibility and A/B testing. Kept so clients can
 * stay on assignment_mode='legacy' until they explicitly opt into weighted.
 */
function assignLeadsLegacy(leads, recruiters) {
  const roleMap = {};
  for (const rc of recruiters) {
    for (const role of rc.target_roles || []) {
      const title = typeof role === 'string' ? role : role.title;
      if (!title) continue;
      const key = title.toLowerCase();
      if (!roleMap[key]) roleMap[key] = [];
      roleMap[key].push(rc.user_id);
    }
  }

  const results = [];
  for (const lead of leads) {
    const roleKey = (lead.role_title || '').toLowerCase();
    let matchedUserId = null;
    let matchedKey = null;
    for (const [configRole, userIds] of Object.entries(roleMap)) {
      if (roleKey && (roleKey.includes(configRole) || configRole.includes(roleKey))) {
        matchedUserId = userIds[0];
        matchedKey = configRole;
        break;
      }
    }
    results.push({
      leadId: lead.id,
      userId: matchedUserId,
      score: matchedUserId ? 1 : 0,
      reason: { mode: 'legacy', matchedKey },
      matched: !!matchedUserId,
      alternatives: [],
    });
  }
  return results;
}

module.exports = {
  scoreRecruiterForLead,
  assignLeads,
  assignLeadsLegacy,
  DEFAULT_WEIGHTS,
  DAY_KEYS,
};
