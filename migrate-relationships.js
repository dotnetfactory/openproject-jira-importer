require("dotenv").config();
const { createRelationships } = require("./create-relationships");
const { getAllJiraIssues, getSpecificJiraIssues } = require("./jira-client");
const {
  getOpenProjectWorkPackages: getOpenProjectWorkPackagesFromClient,
} = require("./openproject-client");

// OpenProject API configuration
const openProjectConfig = {
  baseURL: `${process.env.OPENPROJECT_HOST}/api/v3`,
  headers: {
    Authorization: `Basic ${Buffer.from(
      `apikey:${process.env.OPENPROJECT_API_KEY}`
    ).toString("base64")}`,
    "Content-Type": "application/json",
  },
};

async function getOpenProjectWorkPackages(projectId) {
  try {
    console.log(`Fetching work packages for project ${projectId}...`);
    const workPackagesMap = await getOpenProjectWorkPackagesFromClient(
      projectId
    );

    // Convert Map to simple object format
    const mapping = {};
    for (const [jiraId, wp] of workPackagesMap.entries()) {
      mapping[jiraId] = wp.id;
    }

    return mapping;
  } catch (error) {
    console.error("Error fetching OpenProject work packages:", error.message);
    throw error;
  }
}

async function migrateRelationships(
  jiraProjectKey,
  openProjectId,
  specificIssues = null
) {
  try {
    console.log("\n=== Starting Relationship Migration ===");

    // Get the mapping of Jira keys to OpenProject IDs
    const mapping = await getOpenProjectWorkPackages(openProjectId);
    console.log(`Found ${Object.keys(mapping).length} mapped work packages`);

    // Get Jira issues with their relationships
    const issues = specificIssues
      ? await getSpecificJiraIssues(jiraProjectKey, specificIssues)
      : await getAllJiraIssues(jiraProjectKey);
    console.log(`Found ${issues.length} Jira issues to process`);

    // Create relationships
    await createRelationships(issues, mapping);
  } catch (error) {
    console.error("Migration failed:", error.message);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const jiraProjectKey = args[0];
const openProjectId = args[1];
const specificIssues = args[2] ? args[2].split(",") : null;

if (!jiraProjectKey || !openProjectId) {
  console.log(
    "Usage: node migrate-relationships.js JIRA_PROJECT_KEY OPENPROJECT_ID [ISSUE1,ISSUE2,...]"
  );
  console.log("Example: node migrate-relationships.js CLD 9");
  console.log(
    "Example with specific issues: node migrate-relationships.js CLD 9 CLD-123,CLD-124"
  );
  console.log(
    "Note: Use 'all' as OPENPROJECT_ID to include all projects (useful for cross-project links)"
  );
  process.exit(1);
}

migrateRelationships(jiraProjectKey, openProjectId, specificIssues);
