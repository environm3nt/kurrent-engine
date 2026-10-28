@pipeline @step8
Feature: Airtable Lead Persistence (Step 8)
  As Kurrent pipeline
  I need to write lead records to Airtable
  So that agencies have a CRM-style view of all discovered opportunities

  # --- Record Creation ---

  Scenario: New lead creates a new Airtable record
    Given no existing record for "Northgate Financial|Legal Assistant"
    When writeLeadRecord is called
    Then a POST request should create a new record
    And the Status field should be set to "New Lead"

  Scenario: Existing lead updates the record
    Given an existing record for "Northgate Financial|Legal Assistant"
    When writeLeadRecord is called with updated data
    Then a PATCH request should update the existing record
    And the record ID from the lookup should be used

  # --- Deduplication ---

  Scenario: Compound key dedup prevents duplicates
    When checking for existing records
    Then the filter formula should be AND({Company Name}='X', {Role Title}='Y')
    And only exact matches should be considered duplicates

  # --- Field Mapping ---

  Scenario: All lead fields are mapped correctly
    Given a lead with full enrichment, synthesis, and contact data
    When the Airtable record is built
    Then it should include fields:
      | airtable_field          | source                          |
      | Name                    | companyName - roleTitle          |
      | Company Name            | companyName                      |
      | Role Title              | roleTitle                        |
      | Location                | location                         |
      | Source                  | source (LinkedIn/Indeed)         |
      | Job Posting URL         | jobPostingUrl                    |
      | Salary Range            | synthesis.salaryRange            |
      | Date Identified         | ISO date string                  |
      | Industry                | companyData.industry             |
      | Hiring Contact Name     | contactData.name                 |
      | Hiring Contact Email    | contactData.email                |
      | Status                  | "New Lead"                       |
      | Seniority Tier          | role.seniority                   |
      | Sales Talking Points    | synthesis.salesTalkingPoints     |

  Scenario: Single-select fields are validated
    Given the Status field accepts: "New - Uncontacted", "Contacted", "Meeting Booked", "Proposal Sent", "Won", "Lost", "New Lead", "Qualified"
    When a record is built with Status "New Lead"
    Then it should pass validation
    When a record is built with Status "Invalid Status"
    Then the field should be omitted or defaulted

  Scenario: Empty values are stripped before write
    Given a lead where hiringContactEmail is null
    And hiringContactLinkedIn is an empty string
    When the clean record is built
    Then null and empty string fields should be removed
    And only fields with actual values should be sent to Airtable

  Scenario: Array fields converted to bullet strings
    Given salesTalkingPoints is ["Point 1", "Point 2", "Point 3"]
    When the record is built
    Then Sales Talking Points should be "- Point 1\n- Point 2\n- Point 3"

  # --- Rate Limiting ---

  Scenario: Batch writes respect Airtable rate limits
    Given 5 leads need to be written
    When batchWriteLeads runs
    Then there should be a 200ms delay between each write

  # --- Error Handling ---

  Scenario: Individual record failure doesn't crash batch
    Given 3 leads need to be written
    And the 2nd lead fails with an API error
    When batchWriteLeads runs
    Then lead 1 should be written successfully
    And lead 2 should log an error
    And lead 3 should still be attempted
