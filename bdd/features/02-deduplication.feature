@pipeline @step2
Feature: Job Deduplication (Step 2)
  As Kurrent pipeline
  I need to remove duplicate job postings
  So that each company/role combination appears only once

  Scenario: Duplicate jobs from different sources are deduplicated
    Given the following jobs were discovered:
      | companyName | roleTitle       | source   |
      | Northgate Financial  | Legal Assistant | LinkedIn |
      | Northgate Financial  | Legal Assistant | Indeed   |
      | Halcyon Build | Paralegal       | LinkedIn |
    When deduplication runs using companyName|roleTitle as key
    Then 2 unique jobs should remain
    And the first occurrence (LinkedIn) of "Northgate Financial|Legal Assistant" should be kept

  Scenario: Different roles at same company are preserved
    Given the following jobs were discovered:
      | companyName | roleTitle       | source   |
      | Northgate Financial  | Legal Assistant | LinkedIn |
      | Northgate Financial  | Paralegal       | LinkedIn |
    When deduplication runs
    Then both jobs should be preserved (different role titles)

  Scenario: Deduplication count is tracked in metrics
    Given 5 jobs discovered with 2 duplicates
    When deduplication runs
    Then metrics.deduplicatedCount should equal 2
    And 3 unique jobs should proceed to Step 3

  Scenario: Empty job array passes through cleanly
    Given no jobs were discovered (empty array)
    When deduplication runs
    Then the result should be an empty array
    And the pipeline should continue without error
