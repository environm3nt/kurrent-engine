@pipeline @step4
Feature: Company Enrichment & Contact Discovery (Step 4)
  As Kurrent pipeline
  I need to enrich companies with firmographic data and find hiring contacts
  So that recruitment agencies have actionable lead intelligence

  Background:
    Given a deduplicated job at "Northgate Financial" for "Legal Assistant"

  # --- Company Enrichment ---

  Scenario: Company is enriched via Apollo
    When Apollo organization search returns data for "Northgate Financial"
    Then the enrichment should include industry, headcount, foundedYear
    And the data should be attached to the job record

  Scenario: Apollo enrichment fails
    When Apollo returns a 403 error for company search
    Then the job should continue with null enrichment data
    And the pipeline should not crash

  # --- Contact Waterfall ---

  Scenario: Tier 1 finds an HR contact
    When Apollo people search matches "Talent Acquisition Manager" at Northgate Financial
    Then the waterfall should stop at Tier 1
    And return the contact with name, title, email, and LinkedIn URL

  Scenario: Tier 1 fails, Tier 2 finds a senior contact
    When Tier 1 returns no matches
    And Apollo people search matches "VP of Human Resources" in Tier 2
    Then the waterfall should stop at Tier 2

  Scenario: Apollo rate limited (403/429), falls through to PDL Tier 3
    When Apollo returns 403 on any Tier 1 request
    Then all remaining Apollo tiers should be skipped
    And Tier 3 should attempt PDL SQL search using company domain
    And PDL should score matches by HR relevance (HR keywords=3pts, recruiting=2pts, senior=1pt)

  Scenario: PDL Tier 3 finds a contact
    Given the company has domain "northgatefinancial.example"
    When PDL SQL search finds HR/recruiting contacts at that domain
    Then the highest-scored contact should be returned

  Scenario: PDL Tier 3 skipped when no domain available
    Given the company enrichment returned no domain
    When the waterfall reaches Tier 3
    Then Tier 3 should be skipped
    And the waterfall should continue to Tier 4

  Scenario: All tiers exhausted, no contact found
    When Tiers 1-4 all return no matches
    Then the contact data should be null
    And the job should continue through the pipeline without a contact

  Scenario: Apollo basic plan returns redacted names
    When Apollo returns a contact with empty name but valid title and email
    Then the contact should still be accepted
    And the title should be used as display name

  # --- Rate Limiting ---

  Scenario: Enrichment respects rate limits
    Given 3 companies need enrichment
    When batchEnrichCompanies runs
    Then there should be a 1-second delay between each Apollo API call
