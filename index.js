require("dotenv").config();
const fs = require("fs");
const path = require("path");
const inquirer = require("inquirer");
const {
  getAllJiraIssues,
  getSpecificJiraIssues,
  getJiraCustomFields,
  downloadAttachment,
  listProjects,
  getIssueWatchers,
  DEFAULT_FIELDS,
} = require("./jira-client");
const { generateMapping, saveMapping } = require("./generate-user-mapping");
const {
  getOpenProjectWorkPackages,
  createWorkPackage,
  updateWorkPackage,
  addComment,
  uploadAttachment,
  getWorkPackageTypes,
  getWorkPackageStatuses,
  getWorkPackageTypeId,
  getWorkPackageStatusId,
  getExistingAttachments,
  getExistingComments,
  getOpenProjectUsers,
  findExistingWorkPackage,
  JIRA_ID_CUSTOM_FIELD,
  getWorkPackagePriorityId,
  getWorkPackagePriorities,
  addWatcher,
  getCustomFieldOptionsMap,
  createOpenProjectUser,
  getRoleList,
} = require("./openproject-client");

// Load custom field mapping (graceful fallback if not configured)
let customFieldMapping = [];
try {
  customFieldMapping = require("./custom-field-mapping");
  if (!Array.isArray(customFieldMapping)) customFieldMapping = [];
  if (customFieldMapping.length > 0) {
    console.log(`Loaded ${customFieldMapping.length} custom field mapping(s)`);
  }
} catch (e) {
  // No custom field mapping configured
}

// Create temp directory for attachments if it doesn't exist
const tempDir = path.join(__dirname, "temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

let userMapping = null;
let createMissingUsers = false;
let missingMembers = { add: false, role: "" };

async function getOpenProjectUserId(jiraUser) {
  if (!jiraUser) {
    console.log("No Jira user provided");
    return null;
  }

  const openProjectUserId = userMapping[jiraUser.accountId];
  if (openProjectUserId) {
    console.log(
      `Found OpenProject user ID ${openProjectUserId} for Jira user ${jiraUser.displayName}`
    );
    return openProjectUserId;
  }

  console.log(
    `No OpenProject user mapping found for Jira user ${jiraUser.displayName}`
  );

  if (createMissingUsers && jiraUser.emailAddress) {
    console.log("Creating new user");

    const newUser = await createOpenProjectUser(jiraUser);
    userMapping[jiraUser.accountId] = newUser.id;
    saveMapping(userMapping);
    return newUser.id;
  }

  return null;
}

async function migrateIssues(
  jiraProjectKey,
  openProjectId,
  isProd,
  specificIssues,
  skipUpdates,
  mapResponsible
) {
  console.log(
    `Starting migration for project ${jiraProjectKey} to OpenProject project ${openProjectId}`
  );
  console.log("Production mode:", isProd ? "yes" : "no");
  console.log(
    "Map Jira creator to OpenProject accountable:",
    mapResponsible ? "yes" : "no"
  );

  // Generate or load user mapping
  console.log("\nChecking user mapping...");
  try {
    // Try generated mapping first, fall back to the example template
    const mappingPath = fs.existsSync(
      path.join(__dirname, "user-mapping.generated.js")
    )
      ? "./user-mapping.generated"
      : "./user-mapping";
    userMapping = require(mappingPath);
    const shouldUpdate = await inquirer.prompt([
      {
        type: "confirm",
        name: "update",
        message: "Existing user mapping found. Would you like to update it?",
        default: false,
      },
    ]);
    if (shouldUpdate.update) {
      userMapping = await generateMapping();
    }
  } catch (error) {
    console.log("No existing user mapping found. Generating new mapping...");
    userMapping = await generateMapping();
  }

  ({ confirm: createMissingUsers } = await inquirer.prompt({
        type: "confirm",
        name: "confirm",
        message: "Would you like to create / invite users from the imported work items if they don't exist in OpenProject, yet?"
      }));
  
  ({ confirm: missingMembers.add } = await inquirer.prompt({
        type: "confirm",
        name: "confirm",
        message: "Would you like to automatically add users to the project, if they are related to a work package?"
      }));

  if (missingMembers.add) {
    const availableRoles = await getRoleList();
    ({ defaultRole: missingMembers.role } = await inquirer.prompt([
            {
              type: "list",
              name: "defaultRole",
              message: "With which roles should new Users be added to a Project?",
              choices: availableRoles.map((role) => { return { name: role.name, value: role._links.self.href } }),
            },
          ]));
  }

  // List available projects
  await listProjects();

  // Resolve Jira field names to IDs for name-based custom field mapping
  const jiraFieldNameToId = await resolveJiraFieldNames(customFieldMapping);

  // Get work package types and statuses
  await getWorkPackageTypes(openProjectId);
  await getWorkPackageStatuses();
  await getWorkPackagePriorities();
  await getOpenProjectUsers();

  // Fetch custom field options for list/multi_list custom fields
  let cfOptionsMap = null;
  const listFieldIds = customFieldMapping
    .filter((m) => m.type === "list" || m.type === "multi_list")
    .map((m) => m.openProjectField);
  if (listFieldIds.length > 0) {
    console.log("Fetching custom field options from OpenProject...");
    const firstTypeId = workPackageTypes && workPackageTypes.length > 0
      ? workPackageTypes[0].id
      : null;
    cfOptionsMap = await getCustomFieldOptionsMap(
      listFieldIds,
      openProjectId,
      firstTypeId
    );
    console.log(
      `Fetched options for ${Object.keys(cfOptionsMap).length} custom field(s)`
    );
  }

  // Cache OpenProject work packages if skipUpdates is enabled
  let openProjectWorkPackagesCache = null;
  if (skipUpdates) {
    console.log("Caching OpenProject work packages...");
    openProjectWorkPackagesCache = await getOpenProjectWorkPackages(
      openProjectId
    );
    console.log(
      `Found ${openProjectWorkPackagesCache.size} work packages in OpenProject`
    );
  }

  // Build Jira fields list including custom fields from mapping
  const jiraFields = buildJiraFieldsList(customFieldMapping);

  // Get Jira issues
  const jiraIssues = specificIssues
    ? await getSpecificJiraIssues(jiraProjectKey, specificIssues, jiraFields)
    : await getAllJiraIssues(jiraProjectKey, jiraFields);

  console.log(`Found ${jiraIssues.length} Jira issues to process`);
  console.log("Issues will be processed in chronological order (oldest first)");

  // Process each issue
  let processed = 0;
  let skipped = 0;
  let errors = 0;
  const issueToWorkPackageMap = new Map();

  for (const issue of jiraIssues) {
    try {
      console.log(`\nProcessing ${issue.key}...`);

      // Check if work package already exists
      let existingWorkPackage = null;
      if (skipUpdates) {
        existingWorkPackage = openProjectWorkPackagesCache.get(issue.key);
      } else {
        existingWorkPackage = await findExistingWorkPackage(
          issue.key,
          openProjectId
        );
      }

      if (existingWorkPackage && skipUpdates) {
        console.log(
          `Skipping ${issue.key} - already exists as work package ${existingWorkPackage.id}`
        );
        issueToWorkPackageMap.set(issue.key, existingWorkPackage.id);
        skipped++;
        continue;
      }

      // Get assignee ID from mapping
      let assigneeId = null;
      let responsibleId = null;
      if (issue.fields.assignee) {
        assigneeId = await getOpenProjectUserId(issue.fields.assignee);
      }
      if (mapResponsible && issue.fields.creator) {
        responsibleId = await getOpenProjectUserId(issue.fields.creator);
      }

      // Create work package payload
      const payload = {
        _type: "WorkPackage",
        subject: issue.fields.summary,
        description: {
          raw: Buffer.from(
            convertAtlassianDocumentToText(issue.fields.description)
          ).toString("utf8"),
        },
        _links: {
          type: {
            href: `/api/v3/types/${getWorkPackageTypeId(
              issue.fields.issuetype.name
            )}`,
          },
          status: {
            href: `/api/v3/statuses/${getWorkPackageStatusId(
              issue.fields.status.name
            )}`,
          },
          priority: {
            href: `/api/v3/priorities/${getWorkPackagePriorityId(
              issue.fields.priority
            )}`,
          },
          project: {
            href: `/api/v3/projects/${openProjectId}`,
          },
        },
      };

      const jiraIdField = JIRA_ID_CUSTOM_FIELD;
      if (jiraIdField) {
        payload[`customField${jiraIdField}`] = issue.key;
      }

      // Add custom field values from mapping
      if (customFieldMapping.length > 0) {
        const customFieldsPayload = buildCustomFieldPayload(
          issue,
          customFieldMapping,
          userMapping,
          cfOptionsMap
        );
        for (const [key, value] of Object.entries(customFieldsPayload)) {
          if (key === "_links") {
            Object.assign(payload._links, value);
          } else {
            payload[key] = value;
          }
        }
      }

      // Add assignee if available
      if (assigneeId) {
        payload._links.assignee = {
          href: `/api/v3/users/${assigneeId}`,
        };
      }

      // Add responsible (accountable) if available
      if (responsibleId) {
        payload._links.responsible = {
          href: `/api/v3/users/${responsibleId}`,
        };
      }

      let workPackage;
      if (existingWorkPackage) {
        console.log(`Updating existing work package ${existingWorkPackage.id}`);
        // Remove status from update payload to avoid workflow transition errors
        if (payload._links?.status) {
          delete payload._links.status;
        }
        workPackage = await updateWorkPackage(existingWorkPackage.id, payload, missingMembers);
      } else {
        console.log("Creating new work package");
        workPackage = await createWorkPackage(openProjectId, payload, missingMembers);
      }

      issueToWorkPackageMap.set(issue.key, workPackage.id);

      // Process attachments
      if (issue.fields.attachment && issue.fields.attachment.length > 0) {
        const existingAttachments = await getExistingAttachments(
          workPackage.id
        );
        const existingAttachmentNames = existingAttachments.map(
          (a) => a.fileName
        );

        for (const attachment of issue.fields.attachment) {
          if (existingAttachmentNames.includes(attachment.filename)) {
            console.log(`Skipping existing attachment: ${attachment.filename}`);
            continue;
          }

          console.log(`Processing attachment: ${attachment.filename}`);
          const tempFilePath = path.join(tempDir, attachment.filename);
          const downloaded = await downloadAttachment(attachment.content, tempFilePath);
          if (!downloaded) {
            console.error(`Skipping upload for ${attachment.filename} due to download failure`);
            continue;
          }
          await uploadAttachment(
            workPackage.id,
            tempFilePath,
            attachment.filename
          );
          try { fs.unlinkSync(tempFilePath); } catch (e) {}
        }
      }

      // Process comments
      if (issue.fields.comment && issue.fields.comment.comments.length > 0) {
        const existingComments = await getExistingComments(workPackage.id);
        const existingCommentTexts = existingComments.map((c) => c.comment.raw);

        for (const comment of issue.fields.comment.comments) {
          const commentText = convertAtlassianDocumentToText(comment.body);
          if (commentText) {
            const formattedComment = `${
              comment.author.displayName
            } wrote on ${new Date(
              comment.created
            ).toLocaleString()}:\n${commentText}`;

            if (existingCommentTexts.includes(formattedComment)) {
              console.log("Skipping existing comment");
              continue;
            }

            console.log("Adding comment");
            await addComment(workPackage.id, formattedComment);
          }
        }
      }

      // Add watchers if any
      if (issue.fields.watches?.watchCount > 0) {
        console.log("Adding watchers");
        const watchers = await getIssueWatchers(issue.key);
        for (const watcher of watchers.watchers) {
          const watcherId = await getOpenProjectUserId(watcher);
          if (watcherId) {
            await addWatcher(workPackage.id, watcherId, missingMembers, openProjectId);
          }
        }
      }

      processed++;
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
  }

  // Clean up temp directory
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true });
  }

  console.log("\nMigration summary:");
  console.log(`Total issues processed: ${processed + skipped}`);
  console.log(`Completed: ${processed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);

  return issueToWorkPackageMap;
}

// Resolve any human-readable Jira field names (e.g. "My Custom Field") in the
// mapping to their internal customfield_XXXXX IDs.  Entries that already
// use customfield_ IDs are left untouched.
async function resolveJiraFieldNames(mappings) {
  const needsResolving = mappings.filter(
    (m) => m.jiraField && !m.jiraField.startsWith("customfield_")
  );
  if (needsResolving.length === 0) return {};

  console.log("Resolving Jira field names to IDs...");
  const jiraFields = await getJiraCustomFields();
  const nameToId = {};

  for (const field of jiraFields) {
    nameToId[field.name] = field.id;
  }

  for (const m of needsResolving) {
    const id = nameToId[m.jiraField];
    if (id) {
      console.log(`  ${m.jiraField} → ${id}`);
      m.jiraField = id;
    } else {
      console.warn(
        `  WARNING: Jira field "${m.jiraField}" not found. It will be skipped.`
      );
    }
  }
  return nameToId;
}

// Build the Jira fields list by extending DEFAULT_FIELDS with custom field IDs
function buildJiraFieldsList(customFieldsMapping) {
  const customFieldIds = customFieldsMapping
    .map((m) => m.jiraField)
    .filter((f) => f && f.startsWith("customfield_"));
  if (customFieldIds.length === 0) return DEFAULT_FIELDS;
  return [...DEFAULT_FIELDS, ...customFieldIds].join(",");
}

// Extract the actual value from Jira's nested custom field format
function extractJiraValue(value) {
  if (value === null || value === undefined) return null;
  // Some Jira custom fields return single-element arrays even for single-select
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length === 1) return extractJiraValue(value[0]);
    return value;
  }
  if (typeof value === "object") {
    if (value.value !== undefined) return value.value;
    if (value.name !== undefined) return value.name;
    return value;
  }
  return value;
}

// Extract array values from Jira multi-value custom fields
function extractJiraArrayValues(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map((v) => extractJiraValue(v)).filter((v) => v !== null);
  }
  return [extractJiraValue(value)];
}

// Build custom field payload for OpenProject work package
function buildCustomFieldPayload(issue, mappings, userMapping, cfOptionsMap) {
  const fields = {};

  for (const m of mappings) {
    const jiraValue = issue.fields[m.jiraField];
    if (jiraValue === null || jiraValue === undefined) continue;

    const key = `customField${m.openProjectField}`;
    const type = m.type || "string";
    const options = cfOptionsMap ? cfOptionsMap[m.openProjectField] : null;

    switch (type) {
      case "string":
      case "text": {
        const val = extractJiraValue(jiraValue);
        if (val !== null && val !== undefined && val !== "") {
          fields[key] = String(val);
        }
        break;
      }
      case "integer": {
        const val = parseInt(extractJiraValue(jiraValue), 10);
        if (!isNaN(val)) fields[key] = val;
        break;
      }
      case "float": {
        const val = parseFloat(extractJiraValue(jiraValue));
        if (!isNaN(val)) fields[key] = val;
        break;
      }
      case "date": {
        const val = extractJiraValue(jiraValue);
        if (val) {
          fields[key] = String(val).split("T")[0];
        }
        break;
      }
      case "boolean": {
        const val = extractJiraValue(jiraValue);
        if (val !== null && val !== undefined) {
          fields[key] =
            val === true || val === "true" || val === "Yes";
        }
        break;
      }
      case "list": {
        let val = extractJiraValue(jiraValue);
        if (val !== null && val !== undefined) {
          if (m.values && m.values[val]) val = m.values[val];
          if (options && options[val]) {
            if (!fields._links) fields._links = {};
            fields._links[key] = { href: options[val] };
          } else if (options) {
            console.warn(
              `  ${key}: value "${val}" not found among available options ` +
                `[${Object.keys(options).join(", ")}] — falling back to string`
            );
            fields[key] = String(val);
          } else {
            fields[key] = String(val);
          }
        }
        break;
      }
      case "multi_list": {
        const vals = extractJiraArrayValues(jiraValue);
        if (vals.length > 0) {
          const mapped = m.values
            ? vals.map((v) => m.values[v] || v)
            : vals;
          if (options) {
            const hrefs = mapped
              .map((v) => options[v] ? { href: options[v] } : null)
              .filter(Boolean);
            if (hrefs.length > 0) {
              if (!fields._links) fields._links = {};
              fields._links[key] = hrefs;
            }
            const unmatched = mapped.filter((v) => !options[v]);
            if (unmatched.length > 0) {
              console.warn(
                `  ${key}: values [${unmatched.join(", ")}] not found among available options ` +
                  `[${Object.keys(options).join(", ")}]`
              );
            }
          } else {
            fields[key] = mapped;
          }
        }
        break;
      }
      case "user": {
        // Jira user picker returns { accountId, displayName, ... }
        if (jiraValue && typeof jiraValue === "object") {
          let accountId = null;
          if (jiraValue.accountId) {
            accountId = jiraValue.accountId;
          } else {
            accountId = extractJiraValue(jiraValue);
          }
          if (accountId && userMapping && userMapping[accountId]) {
            if (!fields._links) fields._links = {};
            fields._links[key] = {
              href: `/api/v3/users/${userMapping[accountId]}`,
            };
          }
        }
        break;
      }
    }
  }

  return fields;
}

function convertAtlassianDocumentToText(document) {
  if (!document) return "";
  if (typeof document === "string") return document;

  try {
    if (document.content) {
      return document.content
        .map((block) => block.content?.map((c) => c.text).join("") || "")
        .join("\n")
        .trim();
    }
    return "";
  } catch (error) {
    console.error("Error converting Atlassian document:", error);
    return "";
  }
}

module.exports = {
  migrateIssues,
};
