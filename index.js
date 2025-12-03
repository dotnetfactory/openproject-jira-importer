require("dotenv").config();
const fs = require("fs");
const path = require("path");
const inquirer = require("inquirer");
const {
  getAllJiraIssues,
  getSpecificJiraIssues,
  downloadAttachment,
  listProjects,
  getIssueWatchers,
} = require("./jira-client");
const { generateMapping } = require("./generate-user-mapping");
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
} = require("./openproject-client");

// Create temp directory for attachments if it doesn't exist
const tempDir = path.join(__dirname, "temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

let userMapping = null;

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
    userMapping = require("./user-mapping");
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

  // List available projects
  await listProjects();

  // Get work package types and statuses
  await getWorkPackageTypes();
  await getWorkPackageStatuses();
  await getWorkPackagePriorities();
  await getOpenProjectUsers();

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

  // Get Jira issues
  const jiraIssues = specificIssues
    ? await getSpecificJiraIssues(jiraProjectKey, specificIssues)
    : await getAllJiraIssues(jiraProjectKey);

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
            convertAtlassianDocumentToText(
              // #22: prefer HTML rendered content if available
              issue.renderedFields?.description ?? issue.fields.description
            )
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
        [`customField${JIRA_ID_CUSTOM_FIELD}`]: issue.key,
      };

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
        workPackage = await updateWorkPackage(existingWorkPackage.id, payload);
      } else {
        console.log("Creating new work package");
        workPackage = await createWorkPackage(openProjectId, payload);
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
          const sanitizedFileName = sanitizeFileName(attachment.filename);
          if (existingAttachmentNames.includes(sanitizedFileName)) {
            console.log(`Skipping existing attachment: ${sanitizedFileName}`);
            continue;
          }

          console.log(
            `Processing attachment: ${attachment.filename}${
              attachment.filename !== sanitizedFileName
                ? ` (sanitized to: ${sanitizedFileName})`
                : ""
            }`
          );
          const tempFilePath = path.join(tempDir, attachment.filename);
          await downloadAttachment(attachment.content, tempFilePath);
          await uploadAttachment(
            workPackage.id,
            tempFilePath,
            attachment.filename
          );
          fs.unlinkSync(tempFilePath);
        }
      }

      // Process comments
      // #22: prefer HTML rendered content if available
      const fieldsCommentsData = issue.fields.comment;
      const renderedCommentsData = issue.renderedFields?.comment;
      const commentsData = renderedCommentsData ?? fieldsCommentsData;

      // #26: in case using renderedFields, overwrite dates to maintain original format
      if (commentsData === renderedCommentsData) {
        // Optimize lookup by creating a map of comment IDs to original comments
        const fieldsCommentsById = {};
        for (const comment of fieldsCommentsData.comments) {
          fieldsCommentsById[comment.id] = comment;
        }
        for (const comment of commentsData.comments) {
          const originalComment = fieldsCommentsById[comment.id];
          if (originalComment) {
            comment.created = originalComment.created;
            comment.updated = originalComment.updated;
          }
        }
      }

      if (commentsData && commentsData.comments.length > 0) {
        const existingComments = await getExistingComments(workPackage.id);
        const existingCommentTexts = existingComments.map((c) => c.comment.raw);

        for (const comment of commentsData.comments) {
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
            await addWatcher(workPackage.id, watcherId);
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

/**
 * #24: Sanitizes a file name by replacing invalid characters with underscores.
 * Replicates CarrierWave's sanitize_regexp behavior to match name after upload.
 *
 * @param {string} fileName - The file name to sanitize
 * @returns {string} The sanitized file name with invalid characters replaced by underscores
 * @see {@link https://github.com/carrierwaveuploader/carrierwave/blob/v3.1.2/lib/carrierwave/sanitized_file.rb#L23}
 *
 * @example
 * sanitizeFileName("my file (1).txt") // Returns: "my_file__1_.txt"
 * sanitizeFileName("document+v2.0.pdf") // Returns: "document+v2.0.pdf"
 */
function sanitizeFileName(fileName) {
  return fileName.replace(
    // `v` flag for Unicode support, `i` for case-insensitivity, `g` for global replacement
    // Unfortunately, `\w` behaves differently in JavaScript compared to Ruby, so we explicitly define allowed characters
    // https://ruby-doc.org/3.4.1/Regexp.html#class-Regexp-label-POSIX+Bracket+Expressions
    // https://unicode.org/reports/tr18/#General_Category_Property
    // https://unicode.org/reports/tr18/#alpha
    // https://unicode.org/reports/tr44/#Join_Control
    /[^\p{Mark}\p{Decimal_Number}\p{Connector_Punctuation}\p{Alpha}\p{Join_Control}\.\-\+]/giv,
    "_"
  );
}

module.exports = {
  migrateIssues,
};
