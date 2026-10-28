const config = require('./security/config-loader');
const axios = require('axios');

const DEFAULT_TABLE_NAME = 'Lead Intelligence';
const BASE_URL = 'https://api.airtable.com/v0';

/**
 * Create an Airtable API client for a specific base + table.
 * Reads env vars lazily (at call time, not module load) so Railway/Doppler vars are available.
 * @param {string} [baseId] - Airtable base ID (defaults to env var)
 * @param {string} [tableName] - Table name within the base (defaults to 'Lead Intelligence')
 */
function createAirtableClient(baseId, tableName) {
  const apiKey = config.get('AIRTABLE_API_KEY');
  const defaultBaseId = config.get('AIRTABLE_BASE_ID');
  const resolvedBaseId = baseId || defaultBaseId;
  const resolvedTable = tableName || DEFAULT_TABLE_NAME;

  if (!apiKey) {
    throw new Error('[Airtable] AIRTABLE_API_KEY is not set — cannot create client');
  }
  if (!resolvedBaseId) {
    throw new Error('[Airtable] AIRTABLE_BASE_ID is not set — cannot create client');
  }

  return axios.create({
    baseURL: `${BASE_URL}/${resolvedBaseId}/${encodeURIComponent(resolvedTable)}`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });
}

/**
 * Get or create the default Airtable client (lazy singleton).
 */
let _defaultClient = null;
function getDefaultClient() {
  if (!_defaultClient) {
    _defaultClient = createAirtableClient();
  }
  return _defaultClient;
}

/**
 * Write a single lead record to Airtable
 * Checks if record exists by Company Name + Role Title
 * Updates if exists, creates if not
 * @param {Object} leadData - The lead data object with all fields
 * @returns {Promise<string>} - Record ID
 */
async function writeLeadRecord(leadData) {
  try {
    console.log(`[writeLeadRecord] Processing lead: ${leadData['Company Name']} - ${leadData['Role Title']}`);

    // Build filter formula to check for existing record
    const companyName = leadData['Company Name']?.replace(/'/g, "\\'") || '';
    const roleTitle = leadData['Role Title']?.replace(/'/g, "\\'") || '';

    const filterFormula = `AND({Company Name} = '${companyName}', {Role Title} = '${roleTitle}')`;
    console.log(`[writeLeadRecord] Checking for existing record with filter: ${filterFormula}`);

    // Check if record exists
    const existingRecords = await getDefaultClient().get('', {
      params: {
        filterByFormula: filterFormula,
        maxRecords: 1
      }
    });

    if (existingRecords.data.records && existingRecords.data.records.length > 0) {
      // Record exists - update it
      const recordId = existingRecords.data.records[0].id;
      console.log(`[writeLeadRecord] Record exists with ID: ${recordId}. Updating...`);

      const updateResponse = await getDefaultClient().patch(`/${recordId}`, {
        fields: leadData
      });

      console.log(`[writeLeadRecord] Record updated successfully: ${recordId}`);
      return recordId;
    } else {
      // Record doesn't exist - create it
      console.log(`[writeLeadRecord] No existing record found. Creating new record...`);

      const createResponse = await getDefaultClient().post('', {
        records: [{
          fields: leadData
        }]
      });

      const recordId = createResponse.data.records[0].id;
      console.log(`[writeLeadRecord] Record created successfully: ${recordId}`);
      return recordId;
    }
  } catch (error) {
    console.error(`[writeLeadRecord] Error processing record for ${leadData['Company Name']} - ${leadData['Role Title']}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Batch write multiple lead records
 * Processes each with 200ms delay between writes
 * @param {Array} leadDataArray - Array of lead data objects
 * @returns {Promise<Array>} - Array of record IDs
 */
async function batchWriteLeads(leadDataArray) {
  console.log(`[batchWriteLeads] Starting batch write of ${leadDataArray.length} records`);
  const recordIds = [];

  for (let i = 0; i < leadDataArray.length; i++) {
    try {
      console.log(`[batchWriteLeads] Writing record ${i + 1} of ${leadDataArray.length}`);
      const recordId = await writeLeadRecord(leadDataArray[i]);
      recordIds.push(recordId);

      // Add 200ms delay between writes (except after the last record)
      if (i < leadDataArray.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } catch (error) {
      console.error(`[batchWriteLeads] Error writing record ${i + 1}:`, error.message);
      // Continue processing other records instead of crashing
    }
  }

  console.log(`[batchWriteLeads] Batch write completed. ${recordIds.length} records processed.`);
  return recordIds;
}

/**
 * Update the Status field for an existing lead record
 * @param {string} recordId - The record ID to update
 * @param {string} status - The new status value
 * @returns {Promise<string>} - Updated record ID
 */
async function updateLeadStatus(recordId, status) {
  try {
    console.log(`[updateLeadStatus] Updating record ${recordId} with status: ${status}`);

    const updateResponse = await getDefaultClient().patch(`/${recordId}`, {
      fields: {
        Status: status
      }
    });

    console.log(`[updateLeadStatus] Record updated successfully: ${recordId}`);
    return recordId;
  } catch (error) {
    console.error(`[updateLeadStatus] Error updating record ${recordId}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Get all leads identified on a specific date
 * @param {string} dateString - Date in YYYY-MM-DD format
 * @returns {Promise<Array>} - Array of matching lead records
 */
async function getLeadsByDate(dateString) {
  try {
    console.log(`[getLeadsByDate] Fetching leads for date: ${dateString}`);

    const filterFormula = `{Date Identified} = '${dateString}'`;
    console.log(`[getLeadsByDate] Using filter: ${filterFormula}`);

    const response = await getDefaultClient().get('', {
      params: {
        filterByFormula: filterFormula
      }
    });

    const records = response.data.records || [];
    console.log(`[getLeadsByDate] Found ${records.length} records for ${dateString}`);

    return records;
  } catch (error) {
    console.error(`[getLeadsByDate] Error fetching leads for ${dateString}:`, error.response?.data || error.message);
    throw error;
  }
}

module.exports = {
  writeLeadRecord,
  batchWriteLeads,
  updateLeadStatus,
  getLeadsByDate,
  createAirtableClient,
};
