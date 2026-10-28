@pipeline @resilience
Feature: Pipeline Error Resilience
  As Kurrent pipeline
  I need to handle failures gracefully at every step
  So that partial results are still delivered even when individual steps fail

  Scenario: Step 1 failure doesn't crash pipeline
    When LinkedIn and Indeed both fail to return jobs
    Then Step 1 should be marked as "failed" in metrics
    And the pipeline should continue with an empty job array
    And the ops summary should report the failure

  Scenario: Step 4 enrichment failure for one company doesn't block others
    Given 3 companies need enrichment
    When Apollo fails for company 2
    Then company 1 and 3 should still be enriched
    And company 2 should proceed with null enrichment

  Scenario: Step 6 synthesis failure returns null
    When Claude API is unreachable
    Then synthesis should return null for that lead
    And the lead should still be written to Airtable (with empty synthesis fields)

  Scenario: Step 8 Airtable write failure doesn't stop digest
    When Airtable returns a 500 error
    Then the error should be logged
    And Step 9 (digest email) should still execute

  Scenario: Step 9 digest failure doesn't stop ops summary
    When Resend API is unreachable
    Then the digest failure should be logged
    And the ops summary (Step 10) should still be sent

  Scenario: All errors collected in metrics
    Given multiple steps encounter errors
    When the pipeline completes
    Then all errors should be in the metrics.errors array
    And each error should include the step name and error message

  Scenario: Pipeline metrics always recorded
    When the pipeline runs (even with failures)
    Then metrics should include runId, startTime, endTime, and duration
    And lead counts should reflect whatever was successfully processed

  Scenario: Partial results still produce a digest
    Given 4 roles targeted but only 2 return jobs
    When the pipeline completes
    Then the digest should include the 2 successful leads
    And not wait for or crash on the 2 failures
