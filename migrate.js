require("dotenv").config();
const inquirer = require("inquirer");
const { migrateIssues } = require("./index.js");
const { listProjects } = require("./jira-client");
const {
  listProjects: listOpenProjectProjects,
} = require("./openproject-client");

// Force console.log to also write to stderr
console.log = (...args) => {
  process.stderr.write(args.join(" ") + "\n");
};

async function promptForMigrationOptions() {
  try {
    // Get list of Jira projects
    console.log("\nFetching Jira projects...");
    const jiraProjects = await listProjects();

    // Get list of OpenProject projects
    console.log("\nFetching OpenProject projects...");
    const openProjectProjects = await listOpenProjectProjects();

    // Prompt for Jira project
    const { jiraProject } = await inquirer.prompt([
      {
        type: "list",
        name: "jiraProject",
        message: "Select the Jira project to migrate:",
        choices: jiraProjects.map((project) => ({
          name: `${project.key} - ${project.name}`,
          value: project.key,
        })),
      },
    ]);

    // Prompt for OpenProject project
    const { openProjectId } = await inquirer.prompt([
      {
        type: "list",
        name: "openProjectId",
        message: "Select the OpenProject project to migrate to:",
        choices: openProjectProjects.map((project) => ({
          name: `${project.name} (ID: ${project.id})`,
          value: project.id,
        })),
      },
    ]);

    // Prompt for migration type
    const { migrationType } = await inquirer.prompt([
      {
        type: "list",
        name: "migrationType",
        message: "What type of migration would you like to perform?",
        choices: [
          { name: "Full migration", value: "full" },
          { name: "Test migration (no changes in production)", value: "test" },
          { name: "Specific issues", value: "specific" },
        ],
      },
    ]);

    let isProd = false;
    let skipUpdates = false;
    let specificIssues = null;

    if (migrationType === "full") {
      // Prompt for update mode
      const { updateMode } = await inquirer.prompt([
        {
          type: "list",
          name: "updateMode",
          message: "How would you like to handle existing issues?",
          choices: [
            { name: "Add new issues only (skip existing)", value: "skip" },
            {
              name: "Add new issues and update existing ones",
              value: "update",
            },
          ],
        },
      ]);

      isProd = true;
      skipUpdates = updateMode === "skip";
    } else if (migrationType === "specific") {
      // Prompt for specific issues
      const { issues } = await inquirer.prompt([
        {
          type: "input",
          name: "issues",
          message:
            "Enter the Jira issue keys (comma-separated, e.g., PROJ-123,PROJ-124):",
          validate: (input) => {
            if (!input.trim()) return "Please enter at least one issue key";
            const pattern = /^[A-Z]+-\d+(,[A-Z]+-\d+)*$/;
            if (!pattern.test(input))
              return "Please enter valid issue keys (e.g., PROJ-123,PROJ-124)";
            return true;
          },
        },
      ]);
      specificIssues = issues.split(",");
      isProd = true;
    }

    // Prompt for responsible mapping
    const { mapResponsible } = await inquirer.prompt([
      {
        type: "confirm",
        name: "mapResponsible",
        message: "Map Jira creator to OpenProject accountable?",
        default: true,
      },
    ]);

    // Confirm migration settings
    console.log("\nMigration Settings:");
    console.log(`- Jira Project: ${jiraProject}`);
    console.log(`- OpenProject ID: ${openProjectId}`);
    console.log(`- Migration Type: ${migrationType}`);
    if (migrationType === "full") {
      console.log(
        `- Update Mode: ${skipUpdates ? "Skip existing" : "Update existing"}`
      );
    } else if (migrationType === "specific") {
      console.log(`- Specific Issues: ${specificIssues.join(", ")}`);
    }
    console.log(`- Map Responsible: ${mapResponsible ? "Yes" : "No"}`);

    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: "Would you like to proceed with these settings?",
        default: true,
      },
    ]);

    if (!confirm) {
      console.log("Migration cancelled.");
      process.exit(0);
    }

    // Start migration
    console.log("\nStarting migration...");
    await migrateIssues(
      jiraProject,
      openProjectId,
      isProd,
      specificIssues,
      skipUpdates,
      mapResponsible
    );
  } catch (error) {
    console.error("Error during migration setup:", error.message);
    process.exit(1);
  }
}

// Parse command line arguments or use interactive mode
const args = process.argv.slice(2);
if (args.length > 0) {
  // Use command line arguments
  const isProd = args.includes("--prod");
  const skipUpdates = args.includes("--skip-updates");
  const specificIndex = args.indexOf("--specific");
  const specificIssues =
    specificIndex !== -1 ? args[specificIndex + 1].split(",") : null;
  const mapResponsible = !args.includes("--no-responsible"); // Default to true unless --no-responsible is specified
  const jiraProject = args[0];
  const openProjectId = parseInt(args[1]);

  if (!jiraProject || !openProjectId) {
    console.log(
      "Usage: node migrate.js JIRA_PROJECT_KEY OPENPROJECT_ID [--prod] [--skip-updates] [--specific ISSUE1,ISSUE2] [--no-responsible]"
    );
    process.exit(1);
  }

  // Start migration after a delay to allow initialization to complete
  setTimeout(() => {
    migrateIssues(
      jiraProject,
      openProjectId,
      isProd,
      specificIssues,
      skipUpdates,
      mapResponsible
    );
  }, 2000);
} else {
  // Use interactive mode
  promptForMigrationOptions();
}
