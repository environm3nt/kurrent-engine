@pipeline @step9
Feature: Morning Brief Digest Email (Step 9)
  As Kurrent pipeline
  I need to send a mobile-first morning brief email
  So that agency reps start their day with actionable lead intelligence

  # --- Email Content ---

  Scenario: Digest shows stats bar with correct counts
    Given 4 leads with 3 unique companies, 2 with contacts, 1 hot lead
    When buildDigestHTML runs
    Then the stats bar should show:
      | stat       | value |
      | Roles      | 4     |
      | Companies  | 3     |
      | Contacts   | 2     |
      | Hot Leads  | 1     |

  Scenario: Top 3 leads ranked by data completeness
    Given leads with varying data:
      | company    | hasEmail | hasTalkingPoints | expectedRank |
      | Northgate Financial | true     | true             | 1            |
      | Halcyon Build | true     | false            | 2            |
      | Cascadia Steel | false    | true             | 3            |
    When the top 3 leads are selected
    Then they should be sorted by score (email=2pts, talkingPoints=1pt)

  Scenario: Hot tag shown for leads with contact email
    Given a lead with hiringContactEmail present
    When the lead card is rendered
    Then it should display a "Hot" tag in yellow

  Scenario: New tag shown for leads without contact email
    Given a lead with no hiringContactEmail
    When the lead card is rendered
    Then it should display a "New" tag in gray

  Scenario: Lead cards include hooks from salesTalkingPoints
    Given a lead with salesTalkingPoints ["Growing legal team", "15% headcount increase"]
    When the lead card is rendered
    Then the first talking point should appear as the hook text

  Scenario: Market snapshot groups by role
    Given leads for "Legal Assistant" and "Paralegal"
    When the market snapshot is built
    Then it should show one row per unique role
    And include salary range and time-to-fill for each

  # --- Email Design ---

  Scenario: Email is mobile-first
    When the HTML is generated
    Then the max-width should be 420px
    And the container should use Parchment (#FAF9F5) with Espresso (#2F2C25) accent bar

  Scenario: Single CTA drives to dashboard
    When the email is generated
    Then there should be exactly one CTA button
    And it should say "Open Dashboard"

  # --- Email Sending ---

  Scenario: Subject line includes count and client name
    Given 4 leads for client "Meridian Recruitment"
    When the email is sent
    Then the subject should be "4 new roles — Meridian Recruitment Morning Brief"

  Scenario: Email sent from kurrentlabs.com via Resend
    When sendDigest is called
    Then the from address should be "Kurrent <kurrent@kurrentlabs.com>"
    And the API should use the Resend Bearer token

  Scenario: Reply-to routes to configured email
    When the email headers are set
    Then reply-to should be the configured replyTo address
    And not the kurrent@kurrentlabs.com sender

  Scenario: No recipients configured
    Given digestRecipients.to is an empty array
    When sendDigest is called
    Then it should log an error about no recipients
    And return null without sending

  # --- Ops Summary ---

  Scenario: Ops summary sent after every run
    When the pipeline completes (success or partial failure)
    Then sendRunSummaryToOps should be called
    And the email should include run ID, duration, lead count, and any errors
    And it should be sent to the ops email address
