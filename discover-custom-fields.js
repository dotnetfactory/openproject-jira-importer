const { jiraApi, openProjectApi } = require("./apis.js");

/*
 * Discover custom fields from both Jira and OpenProject.
 *
 * Usage:
 *   node discover-custom-fields.js [PROJECT_ID] [--jira-only | --openproject-only]
 *
 * PROJECT_ID is only needed for the OpenProject side, and only as a fallback:
 * GET /custom_fields requires admin rights and 404s for a non-admin API key,
 * in which case this falls back to the work-package creation form for that
 * project, which only requires "add work packages" permission.
 *
 * Outputs each system's custom fields with their IDs and option values
 * so you can build your custom-field-mapping.js configuration.
 */

const onlyJira = process.argv.includes("--jira-only");
const onlyOpenProject = process.argv.includes("--openproject-only");
const projectId = process.argv.slice(2).find((a) => /^\d+$/.test(a));

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

async function discoverOpenProjectFieldsViaSchema(targetProjectId) {
  console.log(
    "(Falling back to the work-package form schema — this only lists custom " +
    `fields enabled for project ${targetProjectId}, not every field in the instance)\n`
  );

  const response = await openProjectApi.post("/work_packages/form", {
    _links: { project: { href: `/api/v3/projects/${targetProjectId}` } },
  });
  const schema = response.data._embedded?.schema;
  if (!schema) {
    console.log("(Could not retrieve work package form schema)");
    return {};
  }

  const map = {};
  let count = 0;
  for (const [key, fieldSchema] of Object.entries(schema)) {
    if (!key.startsWith("customField")) continue;
    const id = parseInt(key.replace("customField", ""), 10);
    count++;
    map[fieldSchema.name || id] = id;
    console.log(`  ID:        ${id}`);
    console.log(`  Name:      ${fieldSchema.name}`);
    console.log(`  Type:      ${fieldSchema.type}`);
    const allowedValues = fieldSchema._links?.allowedValues;
    if (allowedValues && allowedValues.length > 0) {
      console.log(`  Options:`);
      for (const av of allowedValues) {
        console.log(`    - ${av.title}`);
      }
    }
    console.log("");
  }

  console.log(`Total: ${count} custom field(s) enabled on project ${targetProjectId}\n`);
  return map;
}

async function discoverOpenProjectFields() {
  console.log("\n========================================");
  console.log("OpenProject Custom Fields");
  console.log("========================================\n");

  try {
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
    console.error("Error fetching OpenProject custom fields (requires admin rights):", error.message);
    if (error.response?.data) {
      console.error("Details:", JSON.stringify(error.response.data, null, 2));
    }
    if (!projectId) {
      console.log(
        "\nPass a project ID to fall back to a per-project lookup that doesn't need admin rights:\n" +
        "  node discover-custom-fields.js PROJECT_ID\n"
      );
      return {};
    }
    try {
      return await discoverOpenProjectFieldsViaSchema(projectId);
    } catch (fallbackError) {
      console.error("Error fetching custom fields via form schema:", fallbackError.message);
      if (fallbackError.response?.data) {
        console.error("Details:", JSON.stringify(fallbackError.response.data, null, 2));
      }
      return {};
    }
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
