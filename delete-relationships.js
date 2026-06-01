const {
  getOpenProjectWorkPackages,
  setParentWorkPackage,
  listProjects,
} = require("./openproject-client");
const { openProjectApi } = require("./apis.js");

async function deleteRelationship(relationId) {
  try {
    await openProjectApi.delete(`/relations/${relationId}`);
    console.log(`Deleted relationship ${relationId}`);
  } catch (error) {
    console.error(`Error deleting relationship ${relationId}:`, error.message);
    if (error.response?.data) {
      console.error(
        "Error details:",
        JSON.stringify(error.response.data, null, 2)
      );
    }
  }
}

async function clearParentRelationship(workPackageId) {
  try {
    // Use setParentWorkPackage with null parent to clear
    await setParentWorkPackage(workPackageId, null);
    console.log(
      `Cleared parent relationship for work package ${workPackageId}`
    );
  } catch (error) {
    console.error(
      `Error clearing parent for work package ${workPackageId}:`,
      error.message
    );
  }
}

async function deleteAllRelationships(projectId) {
  try {
    console.log("\n=== Starting Relationship Deletion ===");

    // List available projects
    await listProjects();

    // Get all work packages using the helper
    const workPackagesMap = await getOpenProjectWorkPackages(projectId);
    const workPackages = Array.from(workPackagesMap.values());
    console.log(`\nFound ${workPackages.length} work packages to process`);

    // Track statistics
    let relationshipsDeleted = 0;
    let parentsCleared = 0;

    // Process each work package
    for (const wp of workPackages) {
      // Clear parent relationship if it exists
      if (wp._links.parent?.href) {
        await clearParentRelationship(wp.id);
        parentsCleared++;
      }

      // Get and delete all relationships
      try {
        const relationsResponse = await openProjectApi.get(
          `/work_packages/${wp.id}/relations`
        );
        const relations = relationsResponse.data._embedded?.elements || [];

        for (const relation of relations) {
          await deleteRelationship(relation.id);
          relationshipsDeleted++;
        }
      } catch (error) {
        console.error(
          `Error processing relations for work package ${wp.id}:`,
          error.message
        );
      }
    }

    console.log("\n=== Deletion Summary ===");
    console.log(`Total work packages processed: ${workPackages.length}`);
    console.log(`Parent relationships cleared: ${parentsCleared}`);
    console.log(`Other relationships deleted: ${relationshipsDeleted}`);
    console.log("=== Deletion Complete ===\n");
  } catch (error) {
    console.error("\nDeletion failed:", error.message);
  }
}

// Parse command line arguments
const projectId = process.argv[2];

if (!projectId) {
  console.log("Usage: node delete-relationships.js PROJECT_ID");
  console.log("Example: node delete-relationships.js YOUR_OP_PROJECT_ID");
  process.exit(1);
}

// Run the deletion
deleteAllRelationships(projectId);
