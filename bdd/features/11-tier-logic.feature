@pipeline @tiers
Feature: Tier-Based Feature Gating
  As Kurrent platform
  I need to enable/disable features based on client tier
  So that Starter, Growth, and Scale clients get the right capabilities

  Scenario Outline: Tier determines candidate scoring availability
    Given the client config has tier "<tier>"
    When the pipeline reaches Step 5
    Then candidate scoring should be "<step5_status>"

    Examples:
      | tier    | step5_status |
      | starter | skipped      |
      | growth  | executed     |
      | scale   | executed     |

  Scenario: Default tier is Starter when not specified
    Given the client config has no tier field
    When the pipeline reads the tier
    Then it should default to "starter"

  Scenario: Tier comparison is case-insensitive
    Given the client config has tier "Growth"
    When the pipeline checks the tier
    Then it should match as "growth" (lowercased)

  Scenario: Starter tier still runs enrichment and synthesis
    Given the client config has tier "starter"
    When the pipeline runs
    Then Steps 1-4 and 6-9 should all execute
    And only Step 5 should be skipped

  Scenario: PDF generation controlled by separate flag
    Given the client config has tier "starter" and generatePdfs is false
    When the pipeline runs
    Then Step 5 should be skipped (tier)
    And Step 7 should be skipped (generatePdfs flag)
    And both skips should be logged with reasons
