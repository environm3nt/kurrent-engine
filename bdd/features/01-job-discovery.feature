@pipeline @step1
Feature: Job Discovery (Step 1)
  As Kurrent pipeline
  I need to discover job postings from LinkedIn and Indeed
  So that I can identify new hiring signals for recruitment agencies

  Background:
    Given a client config with target roles:
      | title           | function | seniority |
      | Legal Assistant  | Legal    | IC        |
      | Paralegal        | Legal    | IC        |
      | Bookkeeper       | Finance  | IC        |
      | Accountant       | Finance  | Manager   |
    And target locations include "Toronto Ontario Canada"
    And maxResultsPerRole is 3

  # --- LinkedIn Scraping ---

  Scenario: LinkedIn returns jobs for a target role
    When the pipeline scrapes LinkedIn for "Legal Assistant" in "Toronto Ontario Canada"
    Then the result should be an array of job objects
    And each job should have companyName, roleTitle, location, source, and jobPostingUrl

  Scenario: LinkedIn returns no jobs
    When LinkedIn returns an empty result for "Bookkeeper"
    Then the pipeline should log the failure
    And continue to the next role without crashing

  Scenario: LinkedIn login wall is detected
    When the LinkedIn page shows a login prompt
    Then the scraper should attempt login with configured credentials
    And use human-like typing delays between 2-3.5 seconds

  Scenario: Individual job card fails to parse
    When one job card has missing DOM elements
    Then that card should be skipped
    And remaining cards should still be extracted

  # --- Indeed Scraping ---

  Scenario: Indeed returns jobs for a target role
    When the pipeline scrapes Indeed for "Paralegal" in "Toronto Ontario Canada"
    Then the result should be an array of job objects
    And each job should include salary data when available

  Scenario: Indeed CAPTCHA blocks scraping
    When Indeed presents a CAPTCHA challenge
    Then the scraper should return an empty array
    And log a warning about CAPTCHA detection

  Scenario: Indeed pagination works correctly
    When Indeed has multiple pages of results
    Then the scraper should paginate until maxResults is reached
    And stop when the "Next Page" button is unavailable

  # --- Relevance Filtering ---

  Scenario: Blocked titles are rejected
    Given the blocklist includes "phlebotomist" and "nurse"
    When a scraped job has title "Registered Nurse"
    Then it should be filtered out
    And the stats.totalFiltered counter should increment

  Scenario: Allowed variations are accepted
    Given the allowlist for "Legal Assistant" includes "legal clerk" and "law clerk"
    When a scraped job has title "Senior Law Clerk"
    Then it should pass relevance filtering with score 1.0

  Scenario: Fuzzy matching accepts similar titles
    When a scraped job has title "Legal Administrative Assistant"
    And the similarity score is >= 0.35
    Then it should pass relevance filtering

  Scenario: Fuzzy matching rejects dissimilar titles
    When a scraped job has title "Restaurant Manager"
    And the similarity score is < 0.35
    Then it should be filtered out

  # --- Test Mode ---

  Scenario: Test mode limits discovery
    Given the pipeline runs in test mode
    Then only the first target role should be scraped
    And maxResultsPerRole should be limited to 1
    And a "TEST MODE" warning should be logged
