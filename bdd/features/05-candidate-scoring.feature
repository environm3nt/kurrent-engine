@pipeline @step5
Feature: Candidate Scoring (Step 5)
  As Kurrent pipeline
  I need to find and score candidates from PDL
  So that agencies can identify warm leads for outreach

  # --- Tier Gating ---

  Scenario: Starter tier skips candidate scoring entirely
    Given the client config has tier "starter"
    When the pipeline reaches Step 5
    Then candidate scoring should be skipped
    And a message "SKIPPED (Starter tier)" should be logged

  Scenario: Growth tier includes candidate scoring
    Given the client config has tier "growth"
    When the pipeline reaches Step 5
    Then PDL candidate search should execute for each job

  # --- PDL Search ---

  Scenario: PDL finds candidates for IC seniority
    Given a job with seniority "IC"
    When findCandidates is called
    Then the PDL query should search for seniority levels "entry", "mid", "senior"

  Scenario: PDL finds candidates for Manager seniority
    Given a job with seniority "Manager"
    When findCandidates is called
    Then the PDL query should search for seniority levels "manager", "director"

  Scenario: PDL finds candidates for VP/C-Suite seniority
    Given a job with seniority "VP/C-Suite"
    When findCandidates is called
    Then the PDL query should search for seniority levels "vp", "executive"

  Scenario: Unknown seniority defaults to mid
    Given a job with seniority "Unknown"
    When findCandidates is called
    Then a warning should be logged
    And the PDL query should default to seniority level "mid"

  Scenario: PDL location uses LIKE query
    Given a location "Toronto Ontario Canada"
    When the PDL SQL query is built
    Then it should use LIKE operator for location matching

  # --- Candidate Cache ---

  Scenario: Cache hit returns stored candidates
    Given candidates for "Legal Assistant|Toronto|IC" are cached and not expired
    When the pipeline looks up candidates for that combination
    Then the cached data should be returned
    And no PDL API call should be made

  Scenario: Cache miss triggers PDL API call
    Given no cache entry exists for "Paralegal|Toronto|IC"
    When the pipeline looks up candidates
    Then a PDL API call should be made
    And the results should be stored in cache with 14-day TTL

  Scenario: Expired cache entry triggers fresh API call
    Given candidates for "Bookkeeper|Toronto|IC" are cached but expired (>14 days)
    When the pipeline looks up candidates
    Then the expired entry should be ignored
    And a fresh PDL API call should be made

  Scenario: Empty results from credit exhaustion are NOT cached
    When PDL returns 402 (payment required)
    Then an empty array should be returned
    And the empty result should NOT be stored in cache

  Scenario: Empty results from network errors are NOT cached
    When PDL returns 403 (forbidden)
    Then an empty array should be returned
    And the empty result should NOT be stored in cache

  Scenario: Cache auto-prunes expired entries on write
    Given the cache has 5 entries, 2 of which are expired
    When a new candidate set is cached
    Then the 2 expired entries should be pruned
    And 4 total entries should remain (3 old valid + 1 new)

  # --- Candidate Scoring & Labels ---

  Scenario: Candidate marked WARM when open to work
    Given a PDL candidate with linkedinOpenToWork = true
    When scoreCandidates merges PDL and LinkedIn data
    Then the candidate should receive matchLabel "WARM"

  Scenario: Candidate marked WARM when recently changed jobs
    Given a PDL candidate with jobChangeRecency < 6 months
    When scoring runs
    Then the candidate should receive matchLabel "WARM"

  Scenario: Candidate marked POSSIBLE for mid-tenure
    Given a PDL candidate with jobChangeRecency between 6-18 months
    When scoring runs
    Then the candidate should receive matchLabel "POSSIBLE"

  Scenario: Candidate marked STRETCH for long tenure
    Given a PDL candidate with jobChangeRecency > 18 months
    When scoring runs
    Then the candidate should receive matchLabel "STRETCH"

  Scenario: Candidates sorted by priority
    Given candidates with labels STRETCH, WARM, POSSIBLE
    When scoring completes
    Then the sorted order should be WARM, POSSIBLE, STRETCH

  # --- LinkedIn Merge ---

  Scenario: PDL and LinkedIn candidates merged by name similarity
    Given PDL returns "Jordan Lee" at "Northgate Financial"
    And LinkedIn returns "Jordan J Lee" at "Northgate Financial"
    When candidate merging runs
    Then these should be matched as the same person
    And LinkedIn signals should be added to the PDL record
