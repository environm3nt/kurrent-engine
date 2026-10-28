@pipeline @step6
Feature: Intelligence Synthesis (Step 6)
  As Kurrent pipeline
  I need to synthesize market intelligence via Claude AI
  So that lead records include salary estimates, talking points, and market signals

  # --- Synthesis Input ---

  Scenario: Synthesis receives complete data
    Given a job with enrichment, contact, candidates, and market context
    When synthesizeIntelligence is called
    Then the input should include companyName, roleTitle, location, seniorityTier
    And include jobDescription, companyData, contactData, candidates array
    And include marketContext string

  Scenario: Synthesis handles missing enrichment
    Given a job with null enrichment data and no contact
    When synthesizeIntelligence is called
    Then it should still generate intelligence with available data
    And not crash on null companyData or contactData

  # --- Synthesis Output ---

  Scenario: Synthesis returns all required fields
    When Claude returns a valid JSON response
    Then the output should include:
      | field                 | type    |
      | marketNarrative       | string  |
      | salaryRange           | string  |
      | timeToFill            | string  |
      | activeCandidates      | number  |
      | passiveCandidates     | number  |
      | supplyDemandSignal    | string  |
      | salesTalkingPoints    | array   |
      | candidatePitchPoints  | array   |
      | roleChangeDrivers     | string  |
      | hiringRiskFlag        | string  |
      | marketTrend           | string  |
      | ctaCopy               | string  |
      | digestBullets         | array   |

  Scenario: Supply demand signal uses correct vocabulary
    When synthesis completes
    Then supplyDemandSignal should start with "Tight", "Moderate", or "Abundant"

  # --- Synthesis Error Handling ---

  Scenario: Claude returns invalid JSON
    When Claude API returns a response that isn't valid JSON
    Then the first 500 characters should be logged
    And synthesizeIntelligence should return null
    And the pipeline should continue with null synthesis

  Scenario: Claude API returns an error
    When the Claude API returns a 500 error
    Then the error status code should be logged
    And synthesizeIntelligence should return null

  Scenario: Synthesis with no candidates still works
    Given a job with no PDL candidates (Starter tier)
    When synthesizeIntelligence is called
    Then it should generate market intelligence without candidate data
    And candidate1/candidate2/candidate3 fields should be empty or omitted
