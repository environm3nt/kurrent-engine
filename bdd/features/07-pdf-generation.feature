@pipeline @step7
Feature: PDF Report Generation (Step 7)
  As Kurrent pipeline
  I need to generate PDF market snapshot reports
  So that agencies have polished deliverables for client conversations

  Scenario: PDF generated successfully via PDFMonkey
    Given a lead with complete synthesis data
    When generateReport is called
    Then a POST should be sent to PDFMonkey with Liquid template payload
    And the pipeline should poll for document completion
    And return the download URL on success

  Scenario: PDF polling times out
    When PDFMonkey document status stays "processing" for 60+ seconds
    Then the generator should stop polling after 20 attempts
    And return null
    And the lead should continue without a PDF link

  Scenario: PDF generation is disabled
    Given the client config has generatePdfs set to false
    When the pipeline reaches Step 7
    Then PDF generation should be skipped
    And a "skipped (on-demand mode)" message should be logged

  Scenario: Missing PDFMonkey API key
    Given PDFMONKEY_API_KEY is not set in environment
    When generateReport is called
    Then it should log an error about missing API key
    And return null without making any API calls

  Scenario: Template payload uses correct format
    When the PDF payload is built
    Then candidate fields should use snake_case (for Liquid templates)
    And the report_date should be formatted as "Month Day, Year"
    And agency initials should be first 2 letters uppercase
