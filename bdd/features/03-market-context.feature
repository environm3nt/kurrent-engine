@pipeline @step3
Feature: Market Context (Step 3)
  As Kurrent pipeline
  I need to gather market context for each role/location
  So that Claude synthesis has background data for intelligence generation

  Scenario: Market context is fetched for each unique role
    Given deduplicated jobs include roles "Legal Assistant" and "Paralegal"
    When the pipeline requests market context
    Then getMarketContext should be called for each unique roleTitle + location
    And the result should be a string of market research text

  Scenario: Market context API fails gracefully
    When the Claude API returns an error for market context
    Then the market context should default to an empty string
    And the pipeline should continue to Step 4

  Scenario: Market context is reused for same role
    Given two jobs with roleTitle "Legal Assistant" at different companies
    When market context is fetched
    Then getMarketContext should only be called once for "Legal Assistant"
    And the same context should be shared across both jobs
