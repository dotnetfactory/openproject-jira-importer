require("dotenv").config();
const { getAllJiraIssues, getSpecificJiraIssues } = require("./jira-client");
const {
  getOpenProjectWorkPackages,
  setParentWorkPackage,
  listProjects,
} = require("./openproject-client");

async function migrateParents(jiraProjectKey, openProjectId, specificIssues) {
  console.log("Starting parent relationship migration...");

  // List available projects
  await listProjects();

  // Get work packages from OpenProject, already keyed by Jira issue key
  console.log(`\nFetching work packages for project ${openProjectId}...`);
  const jiraKeyToWorkPackage = await getOpenProjectWorkPackages(openProjectId);

  // Get Jira issues
  const jiraIssues = specificIssues
    ? await getSpecificJiraIssues(jiraProjectKey, specificIssues.split(","))
    : await getAllJiraIssues(jiraProjectKey);

  console.log(`Found ${jiraIssues.length} Jira issues to process`);

  // Process each issue
  let processed = 0;
  let completed = 0;
  let skipped = 0;
  let errors = 0;

  for (const issue of jiraIssues) {
    try {
      console.log(`\nProcessing ${issue.key}...`);
      console.log(`\nProcessing Content ${issue}...`);
      // Check for parent field
      const parentKey = issue.fields.parent?.key;
      if (!parentKey) {
        console.log(`No parent found for ${issue.key}`);
        skipped++;
        continue;
      }

      console.log(`Found parent ${parentKey} for ${issue.key}`);

      // Get the work package IDs
      const workPackageId = jiraKeyToWorkPackage.get(issue.key)?.id;
      const parentWorkPackageId = jiraKeyToWorkPackage.get(parentKey)?.id;

      if (!workPackageId || !parentWorkPackageId) {
        console.error(
          `Could not find work package IDs for ${issue.key} or its parent ${parentKey}`
        );
        errors++;
        continue;
      }

      try {
        await setParentWorkPackage(workPackageId, parentWorkPackageId);
        console.log(`Set parent relationship: ${issue.key} -> ${parentKey}`);
        completed++;
      } catch (error) {
        console.error(`Error setting parent for ${issue.key}:`, error.message);
        errors++;
      }
    } catch (error) {
      console.error(`Error processing ${issue.key}:`, error.message);
      if (error.response?.data) {
        console.error(
          "Error details:",
          JSON.stringify(error.response.data, null, 2)
        );
      }
      errors++;
    }
    processed++;
  }

  // Print summary
  console.log("\nMigration summary:");
  console.log(`Total issues processed: ${processed}`);
  console.log(`Completed: ${completed}`);
  console.log(`Skipped (no parent): ${skipped}`);
  console.log(`Errors: ${errors}`);
}

// Parse command line arguments
const jiraProjectKey = process.argv[2];
const openProjectId = process.argv[3];
const specificIssues = process.argv[4];

if (!jiraProjectKey || !openProjectId) {
  console.error("Please provide a Jira project key and OpenProject ID");
  console.log(
    "Usage: node migrate-parents.js PROJECT_KEY PROJECT_ID [ISSUE_KEYS]"
  );
  process.exit(1);
}

// Run the migration
migrateParents(jiraProjectKey, openProjectId, specificIssues);
