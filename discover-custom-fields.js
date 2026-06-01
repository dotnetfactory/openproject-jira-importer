const { jiraApi, openProjectApi } = require("./apis.js");

/*
 * Discover custom fields from both Jira and OpenProject.
 *
 * Usage:
 *   node discover-custom-fields.js [--jira-only | --openproject-only]
 *
 * Outputs each system's custom fields with their IDs and option values
 * so you can build your custom-field-mapping.js configuration.
 */

const onlyJira = process.argv.includes("--jira-only");
const onlyOpenProject = process.argv.includes("--openproject-only");

async function discoverJiraFields() {
  try {
    console.log("\n========================================");
    console.log("Jira Custom Fields");
    console.log("========================================\n");

    const response = await jiraApi.get("/field");
    const fields = response.data;

    const customFields = fields.filter((f) => f.custom);

    if (customFields.length === 0) {
      console.log("(No custom fields found)");
      return {};
    }

    const map = {};
    for (const field of customFields) {
      map[field.name] = field.id;
      console.log(`  ID:   ${field.id}`);
      console.log(`  Name: ${field.name}`);
      if (field.schema) {
        console.log(`  Type: ${field.schema.type}${field.schema.items ? "[" + field.schema.items + "]" : ""}`);
      }
      console.log("");
    }

    console.log(`Total: ${customFields.length} custom fields\n`);
    return map;
  } catch (error) {
    console.error("Error fetching Jira fields:", error.message);
    if (error.response?.data) {
      console.error("Details:", JSON.stringify(error.response.data, null, 2));
    }
    return {};
  }
}

async function discoverOpenProjectFields() {
  try {
    console.log("\n========================================");
    console.log("OpenProject Custom Fields");
    console.log("========================================\n");

    const response = await openProjectApi.get("/custom_fields");
    const elements = response.data._embedded?.elements;

    if (!elements || elements.length === 0) {
      console.log("(No custom fields found)");
      return {};
    }

    const map = {};
    for (const field of elements) {
      map[field.name || field.id] = field.id;
      console.log(`  ID:        ${field.id}`);
      console.log(`  Name:      ${field.name}`);
      console.log(`  Format:    ${field.fieldFormat}`);
      if (field.possibleValues && field.possibleValues.length > 0) {
        console.log(`  Options:`);
        for (const v of field.possibleValues) {
          console.log(`    - ${v.value || v.name || v}`);
        }
      }
      console.log("");
    }

    console.log(`Total: ${elements.length} custom fields\n`);
    return map;
  } catch (error) {
    console.error("Error fetching OpenProject custom fields:", error.message);
    if (error.response?.data) {
      console.error("Details:", JSON.stringify(error.response.data, null, 2));
    }
    return {};
  }
}

async function main() {
  if (!onlyOpenProject) {
    await discoverJiraFields();
  }
  if (!onlyJira) {
    await discoverOpenProjectFields();
  }
  console.log("\nTip: Use the IDs above to build your custom-field-mapping.js");
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
