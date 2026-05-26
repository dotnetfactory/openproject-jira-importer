/*
 * User Mapping Configuration
 * ===========================
 *
 * Maps Jira user account IDs to OpenProject user IDs.
 *
 * --- How to generate ---
 *
 * Run `node generate-user-mapping.js` for an interactive prompt that lets
 * you map Jira users to OpenProject users. The result is saved to
 * `user-mapping.generated.js` and loaded automatically.
 *
 * --- Manual format ---
 *
 * {
 *   "jira-account-id-1": 5,    // Jira account ID → OpenProject user ID
 *   "jira-account-id-2": 8,
 * }
 *
 * --- How to find IDs ---
 *
 * Jira account IDs:  Run `node generate-user-mapping.js` or use
 *                    the Jira API `GET /users/search`.
 *
 * OpenProject IDs:   Run `node generate-user-mapping.js` or use
 *                    the OpenProject API `GET /api/v3/users`.
 */

module.exports = {};
