const { JIRA_ID_CUSTOM_FIELD } = require("./openproject-client");
const { openProjectApi } = require("./apis.js");

async function getAllWorkPackages(projectId) {
  try {
    console.log("\n=== Fetching All Work Packages ===");
    console.log("Fetching work packages from OpenProject...");

    let allWorkPackages = [];
    let page = 1;
    const pageSize = 100;
    let total = null;

    while (true) {
      console.log(`Fetching page ${page}...`);

      const response = await openProjectApi.get("/work_packages", {
        params: {
          filters: JSON.stringify([
            {
              project: {
                operator: "=",
                values: [projectId.toString()],
              },
            },
          ]),
          pageSize: pageSize,
          offset: page,
        },
      });

      if (total === null) {
        total = parseInt(response.data.total);
        console.log(`Total work packages to fetch: ${total}`);
      }

      const workPackages = response.data._embedded.elements;
      if (!workPackages || workPackages.length === 0) {
        break;
      }

      allWorkPackages = allWorkPackages.concat(workPackages);
      console.log(
        `Retrieved ${
          allWorkPackages.length
        } of ${total} work packages (${Math.round(
          (allWorkPackages.length / total) * 100
        )}%)`
      );

      if (allWorkPackages.length >= total) {
        break;
      }

      page++;

      // Add a small delay to prevent rate limiting
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return allWorkPackages;
  } catch (error) {
    console.error("Error fetching work packages:", error.message);
    if (error.response?.data) {
      console.error(
        "Error details:",
        JSON.stringify(error.response.data, null, 2)
      );
    }
    throw error;
  }
}

async function findDuplicates(workPackages) {
  console.log("\n=== Analyzing Work Packages ===");

  // Group work packages by Jira ID
  const groupedByJiraId = new Map();
  let workPackagesWithJiraId = 0;
  let workPackagesWithoutJiraId = 0;

  const jiraIdField = JIRA_ID_CUSTOM_FIELD;
  workPackages.forEach((wp) => {
    const jiraId = jiraIdField ? wp[`customField${jiraIdField}`] : null;
    if (jiraId) {
      workPackagesWithJiraId++;
      if (!groupedByJiraId.has(jiraId)) {
        groupedByJiraId.set(jiraId, []);
      }
      groupedByJiraId.get(jiraId).push(wp);
    } else {
      workPackagesWithoutJiraId++;
    }
  });

  console.log("\nAnalysis Summary:");
  console.log(`- Total work packages: ${workPackages.length}`);
  console.log(`- Work packages with Jira ID: ${workPackagesWithJiraId}`);
  console.log(`- Work packages without Jira ID: ${workPackagesWithoutJiraId}`);

  // Find duplicates
  const duplicates = new Map();
  for (const [jiraId, wps] of groupedByJiraId.entries()) {
    if (wps.length > 1) {
      // Sort by creation date (newest first)
      wps.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      duplicates.set(jiraId, wps);
    }
  }

  console.log(
    `\nFound ${duplicates.size} Jira IDs with duplicate work packages`
  );

  return duplicates;
}

async function deleteWorkPackage(workPackageId) {
  try {
    await openProjectApi.delete(`/work_packages/${workPackageId}`);
    return true;
  } catch (error) {
    console.error(
      `Error deleting work package ${workPackageId}:`,
      error.message
    );
    if (error.response?.data) {
      console.error(
        "Error details:",
        JSON.stringify(error.response.data, null, 2)
      );
    }
    return false;
  }
}

async function removeDuplicates(projectId) {
  try {
    // Get all work packages
    const workPackages = await getAllWorkPackages(projectId);

    // Find duplicates
    const duplicates = await findDuplicates(workPackages);

    if (duplicates.size === 0) {
      console.log("\nNo duplicates found. Nothing to do.");
      return;
    }

    console.log("\n=== Duplicate Work Packages ===");
    for (const [jiraId, wps] of duplicates.entries()) {
      console.log(`\nJira ID: ${jiraId}`);
      console.log(`Found ${wps.length} duplicates:`);
      wps.forEach((wp, index) => {
        console.log(
          `${index === 0 ? "  [KEEP]" : "  [DELETE]"} ID: ${wp.id}, Created: ${
            wp.createdAt
          }, Subject: ${wp.subject}`
        );
      });
    }

    // Confirm before deletion
    console.log("\n=== WARNING ===");
    console.log(
      "This will delete duplicate work packages, keeping only the newest one for each Jira ID."
    );
    console.log("Please review the list above carefully.");
    console.log("To proceed, call removeDuplicates with the --confirm flag.");

    // Check if --confirm flag is present
    if (process.argv.includes("--confirm")) {
      console.log("\n=== Removing Duplicates ===");
      let deletedCount = 0;
      let errorCount = 0;

      for (const wps of duplicates.values()) {
        // Skip the first one (newest)
        for (let i = 1; i < wps.length; i++) {
          console.log(`Deleting work package ${wps[i].id}...`);
          const success = await deleteWorkPackage(wps[i].id);
          if (success) {
            deletedCount++;
          } else {
            errorCount++;
          }
        }
      }

      console.log("\n=== Cleanup Complete ===");
      console.log(`Successfully deleted: ${deletedCount}`);
      console.log(`Failed to delete: ${errorCount}`);
    }
  } catch (error) {
    console.error("Error removing duplicates:", error.message);
  }
}

// Parse command line arguments
const projectId = process.argv[2];

if (!projectId) {
  console.error("Please provide a project ID");
  console.log("Usage: node remove-duplicates.js PROJECT_ID [--confirm]");
  process.exit(1);
}

// Run the script
removeDuplicates(projectId);
