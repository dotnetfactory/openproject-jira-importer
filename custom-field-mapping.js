/*
 * Custom Field Mapping Configuration
 * ====================================
 *
 * Mapping from Jira custom fields to OpenProject custom fields.
 *
 * --- How to find your field IDs ---
 *
 * Jira fields:  Run `node discover-custom-fields.js` to list all Jira custom
 *               fields and their IDs (e.g. customfield_12345).
 *
 * OpenProject:  The same script lists every OpenProject custom field with its
 *               numeric ID and possible option values.
 *
 * --- Supported field types ---
 *
 * type         | Jira format              | OpenProject behaviour
 * -------------|--------------------------|-----------------------------------
 * "string"     | Plain text               | Single-line text
 * "text"       | Plain text               | Multi-line / long text
 * "integer"    | Number                   | Integer field
 * "float"      | Number                   | Float field
 * "date"       | ISO date / datetime      | Date field (time portion stripped)
 * "boolean"    | true / false / "Yes"     | Boolean field
 * "list"       | Single-select value      | Single-select list (uses option href)
 * "multi_list" | Array of values          | Multi-select list (uses option hrefs)
 * "user"       | { accountId, ... }       | User link (uses user-mapping.json)
 *
 * --- Optional: value translation ---
 *
 * If the values in Jira differ from OpenProject's option labels, add a
 * `values` map to translate them:
 *
 *   {
 *     jiraField: "customfield_12345",
 *     openProjectField: 7,
 *     type: "list",
 *     values: {
 *       "Low": "Minor",
 *       "Medium": "Normal",
 *       "High": "Major",
 *     }
 *   }
 *
 * --- Example entries (replace with your own IDs) ---
 *
 *   {
 *     jiraField: "customfield_12345",
 *     openProjectField: 7,
 *     type: "list",
 *   },
 *   {
 *     jiraField: "customfield_12346",
 *     openProjectField: 8,
 *     type: "string",
 *   },
 */

module.exports = [
  // Remove the example above and add your own mappings here, for instance:
  //
  // {
  //   jiraField: "customfield_10000",
  //   openProjectField: 1,
  //   type: "string",
  // },
];
