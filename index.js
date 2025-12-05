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
const { default: parse } = require("node-html-parser");

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
      const rawDescription = Buffer.from(
        convertAtlassianDocumentToText(
          // #22: prefer HTML rendered content if available
          issue.renderedFields?.description ?? issue.fields.description
        )
      ).toString("utf8");
      const payload = {
        _type: "WorkPackage",
        subject: issue.fields.summary,
        description: {
          raw: rawDescription,
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
      const hasAttachments =
        issue.fields.attachment && issue.fields.attachment.length > 0;
      if (existingWorkPackage) {
        console.log(`Updating existing work package ${existingWorkPackage.id}`);
        // In case there are attachments, do not update description yet, as it will be reworked later
        if (hasAttachments) {
          delete payload.description;
        }
        workPackage = await updateWorkPackage(existingWorkPackage.id, payload);
      } else {
        console.log("Creating new work package");
        workPackage = await createWorkPackage(openProjectId, payload);
      }

      issueToWorkPackageMap.set(issue.key, workPackage.id);

      // Process attachments
      /** Keep reference of attachments to be able to rework description and comments */
      let attachmentsByJiraId = {};
      if (hasAttachments) {
        const existingAttachments = await getExistingAttachments(
          workPackage.id
        );
        const existingAttachmentsByFileName = {};
        for (const attachment of existingAttachments) {
          existingAttachmentsByFileName[attachment.fileName] = attachment;
        }

        for (const jiraAttachment of issue.fields.attachment) {
          const sanitizedFileName = sanitizeFileName(jiraAttachment.filename);
          let opAttachment;
          if (existingAttachmentsByFileName[sanitizedFileName]) {
            console.log(`Skipping existing attachment: ${sanitizedFileName}`);
            opAttachment = existingAttachmentsByFileName[sanitizedFileName];
          } else {
            console.log(
              `Processing attachment: ${jiraAttachment.filename}${
                jiraAttachment.filename !== sanitizedFileName
                  ? ` (sanitized to: ${sanitizedFileName})`
                  : ""
              }`
            );
            const tempFilePath = path.join(tempDir, jiraAttachment.filename);
            await downloadAttachment(jiraAttachment.content, tempFilePath);
            opAttachment = await uploadAttachment(
              workPackage.id,
              tempFilePath,
              jiraAttachment.filename
            );
            fs.unlinkSync(tempFilePath);
          }

          // #14: keep track of uploaded attachment by Jira ID
          attachmentsByJiraId[jiraAttachment.id] = {
            jiraAttachment,
            opAttachment,
          };
        }

        // #14: Update work package description with fixed attachment links
        const updatedDescription = fixAttachmentsInHTML(
          rawDescription,
          attachmentsByJiraId
        );
        if (
          updatedDescription !==
          (existingWorkPackage?.description?.raw ?? rawDescription)
        ) {
          console.log(
            "Updating work package description with attachment links"
          );
          await updateWorkPackage(workPackage.id, {
            description: { raw: updatedDescription },
          });
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
            const preambledComment = `${
              comment.author.displayName
            } wrote on ${new Date(
              comment.created
            ).toLocaleString()}:\n${commentText}`;

            // #14: rework attachment links in comments
            const formattedComment = fixAttachmentsInHTML(
              preambledComment,
              attachmentsByJiraId
            );

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
 * #14: Fixes attachment references in HTML content by updating image sources and link hrefs
 * based on a mapping of Jira attachment IDs. For images, it also sets or overwrites the alt attribute
 * with the attachment filename and optionally returns a note about the original alt text.
 *
 * @param {string} html - The HTML string containing attachment references to be fixed.
 * @param {Object<string, Object>} attachmentsByJiraId - An object mapping Jira attachment IDs to attachment objects,
 *   where each attachment object has at least a 'filename' property.
 * @returns {string} The modified HTML string with updated attachment references.
 */
function fixAttachmentsInHTML(html, attachmentsByJiraId) {
  const root = parse(html);
  root.querySelectorAll("img").forEach((img) => {
    reworkElement(
      img,
      "src",
      fixAttachmentsInHTML.regex,
      attachmentsByJiraId,
      (img, jiraAttachment) => {
        const originalAlt = img.getAttribute("alt");
        // #29: set alt attribute (in case it is missing, but we can always overwrite)
        img.setAttribute("alt", jiraAttachment.filename);
        if (originalAlt) return `Original alt: ${originalAlt}\n`;
      }
    );
  });
  // Also fix links to attachments that are not images
  root.querySelectorAll("a").forEach((a) => {
    reworkElement(a, "href", fixAttachmentsInHTML.regex, attachmentsByJiraId);
  });
  return root.toString();
}
fixAttachmentsInHTML.regex = /\/attachment\/content\/(\d+)$/;

/**
 * Reworks a DOM element by updating a specified attribute with an OpenProject attachment link
 * based on a regex match against the attribute's original value. If a match is found and a corresponding
 * attachment pair exists, the attribute is set to the OpenProject download link, and the element's
 * title is updated to include original information and optionally custom content from a callback.
 *
 * @param {Element} element - The DOM element to modify.
 * @param {string} attribute - The name of the attribute to update (e.g., 'href' or 'src').
 * @param {RegExp} regex - The regular expression to match against the attribute's original value,
 *                         expected to capture the Jira attachment ID in the first group.
 * @param {Object.<string, {jiraAttachment: Object, opAttachment: Object}>} attachmentsByJiraId -
 *                        A map of Jira attachment IDs to objects containing Jira and OpenProject attachment details.
 * @param {Function|null} [buildTitleCb=null] - An optional callback function to build additional title content.
 *                        It receives the element and jiraAttachment as arguments and should return a string.
 */
function reworkElement(
  element,
  attribute,
  regex,
  attachmentsByJiraId,
  buildTitleCb = null
) {
  const originalValue = element.getAttribute(attribute);
  const match = originalValue?.match(regex);
  if (!match) return;

  const jiraAttachmentId = match[1];
  const attachmentPair = attachmentsByJiraId[jiraAttachmentId];
  if (!attachmentPair) return;

  const { jiraAttachment, opAttachment } = attachmentPair;
  // #14: update attribute with OpenProject attachment link
  element.setAttribute(
    attribute,
    opAttachment._links.staticDownloadLocation.href
  );
  // Also archive the original value just in case
  const originalTitle = element.getAttribute("title");
  element.setAttribute(
    "title",
    `${originalTitle ? `Original title: ${originalTitle}\n` : ""}${
      buildTitleCb?.(element, jiraAttachment) ?? ""
    }Original file name: ${
      jiraAttachment.filename
    }\nOriginal ${attribute}: ${originalValue}`
  );
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
