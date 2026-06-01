require("dotenv").config();
const fs = require("fs");
const FormData = require("form-data");
const { openProjectApi } = require("./apis.js");

// Get the custom field ID from environment variable
// Required: the OpenProject custom field ID that stores the Jira issue key.
// Set JIRA_ID_CUSTOM_FIELD in your .env file.
const JIRA_ID_CUSTOM_FIELD = process.env.JIRA_ID_CUSTOM_FIELD
  ? parseInt(process.env.JIRA_ID_CUSTOM_FIELD, 10)
  : null;

function requireJiraIdField() {
  if (JIRA_ID_CUSTOM_FIELD === null) {
    console.error(
      "\nERROR: JIRA_ID_CUSTOM_FIELD is not configured.\n" +
      "Set it in your .env file to the OpenProject custom field ID\n" +
      "that stores the Jira issue key.\n"
    );
    throw new Error("JIRA_ID_CUSTOM_FIELD not configured");
  }
  return JIRA_ID_CUSTOM_FIELD;
}

// Store work package types and statuses
let workPackageTypes = null;
let workPackageStatuses = null;
let openProjectUsers = null;
let workPackagePriorities = null;

// Map Jira issue types to OpenProject types
const typeMapping = {
  Task: "Task",
  Story: "User story",
  Bug: "Bug",
  Epic: "Epic",
  Feature: "Feature",
  Milestone: "Milestone",
};    

// Map Jira statuses to OpenProject statuses
const statusMapping = {
  "To Do": "New",
  "In Progress": "In progress",
  Done: "Closed",
  Closed: "Closed",
  Resolved: "Closed",
};

// Map Jira priorities to OpenProject priorities
const priorityMapping = {
  Highest: "Immediate",
  High: "High",
  Medium: "Normal",
  Low: "Low",
  Lowest: "Low",
};

async function getOpenProjectWorkPackages(projectId) {
  console.log("\n=== Caching OpenProject Work Packages ===");
  console.log("Fetching work packages from OpenProject...");

  let allWorkPackages = [];
  let page = 1;
  const pageSize = 100;
  let total = null;
  const workPackageMap = new Map();

  while (true) {
    console.log(`Fetching page ${page}...`);

    try {
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
          offset: page,
          pageSize: pageSize,
          sortBy: JSON.stringify([["id", "asc"]]),
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

      // Log the first work package to see its structure
      if (page === 1) {
        console.log("\nExample work package structure:");
        console.log(JSON.stringify(workPackages[0], null, 2));
      }

      allWorkPackages = allWorkPackages.concat(workPackages);
      console.log(
        `Retrieved ${
          allWorkPackages.length
        } of ${total} work packages (${Math.round(
          (allWorkPackages.length / total) * 100
        )}%)`
      );

        // Map work packages by their Jira ID (skip if not configured)
      const jiraIdField = JIRA_ID_CUSTOM_FIELD;
      for (const wp of workPackages) {
        const jiraId = jiraIdField ? wp[`customField${jiraIdField}`] : null;
        if (jiraId) {
          workPackageMap.set(jiraId, wp);
        }
      }

      if (allWorkPackages.length >= total) {
        break;
      }

      page++;
      // Add a small delay between requests
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      console.error("Error fetching work packages:", error.message);
      throw error;
    }
  }

  console.log(
    `\nTotal work packages found in OpenProject: ${allWorkPackages.length}`
  );

  // Log cache summary
  const withJiraId = Array.from(workPackageMap.keys()).length;
  const withoutJiraId = allWorkPackages.length - withJiraId;
  console.log("\nCache Summary:");
  console.log(`- Total work packages: ${allWorkPackages.length}`);
  console.log(`- Work packages with Jira ID: ${withJiraId}`);
  console.log(`- Work packages without Jira ID: ${withoutJiraId}`);
  console.log(`- Cached ${withJiraId} work packages for quick lookup`);
  console.log("=======================================\n");

  return workPackageMap;
}

async function setParentWorkPackage(childId, parentId) {
  try {
    // Get current work package to get its lock version
    const currentWP = await openProjectApi.get(`/work_packages/${childId}`);

    await openProjectApi.patch(`/work_packages/${childId}`, {
      lockVersion: currentWP.data.lockVersion,
      _links: {
        parent: {
          href: `/api/v3/work_packages/${parentId}`,
        },
      },
    });
  } catch (error) {
    console.error(
      `Error setting parent for work package ${childId}:`,
      error.message
    );
    if (error.response?.data) {
      console.error(
        "Error details:",
        JSON.stringify(error.response.data, null, 2)
      );
    }
    throw error;
  }
}

/**
 * Create an OpenProject user with name and email based on the given Jira user
 * @param {object} jiraUser The Jira user from the Jira API
 * @returns The response of the OpenProject API
 */
async function createOpenProjectUser(jiraUser) {
  const nameParts = (jiraUser.displayName || "").trim().split(/\s+/).filter(Boolean);
  const firstName = nameParts.shift() || jiraUser.emailAddress;
  const lastName = nameParts.join(" ") || "-";

  const response = await openProjectApi.post("/users", {
    login: jiraUser.emailAddress,
    firstName,
    lastName,
    email: jiraUser.emailAddress,
    status: "invited",
  });
  return response.data;
}

async function createWorkPackage(projectId, payload, missingMembers = { add: false }) {
  const newPayload = { ...payload };
  newPayload._links.project = { href: `/api/v3/projects/${projectId}` };

  try {
    const response = await openProjectApi.post("/work_packages", newPayload);
    return response.data;
  } catch (error) {
    console.error("Error creating work package:", error.message);
    if (error?.response?.data && missingMembers.add) {
      if (await addMissingMembers(error.response.data, newPayload, missingMembers.role, newPayload._links.project.href)) {
        console.log("retrying...");
        return (await openProjectApi.post("/work_packages", newPayload)).data;
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }
}

/**
 * Reads the problem Details of an OpenProject Response. If the Cause of the Problem is "user is not a member of this project", it returns a list of _link-Properties that contain the offending user.
 * @param {object} errorDetails The error details from the OpenProject-API
 * @returns {string[]} The offending properties in the `_links` object.
 */
function getMissingMembers(errorDetails) {
  const missingMembers = [];
  if (isMemberError(errorDetails)) {
    missingMembers.push(errorDetails._embedded.details.attribute);
  } else if (
    errorDetails.errorIdentifier ===
    "urn:openproject-org:api:v3:errors:MultipleErrors"
  ) {
    errorDetails._embedded.errors
      .filter((embeddedError) => isMemberError(embeddedError))
      .forEach((missingMember) => {
        missingMembers.push(missingMember._embedded.details.attribute);
      });
  }

  return missingMembers;
}

/**
 * Reads the problem details of an OpenProject response and determines if the cause of the problem is, that a user is not Member of a project.
 * @param {object} errorDetails 
 * @returns {boolean} Whether the error was caused by non-membership of a project or not.
 */
function isMemberError(errorDetails) {
  const attribute = errorDetails?._embedded?.details?.attribute;

  return (
    errorDetails?.errorIdentifier ===
      "urn:openproject-org:api:v3:errors:PropertyConstraintViolation" &&
    ["assignee", "responsible", "user"].includes(attribute)
  );
}

/**
 * Adds the Principal to the Project with the given Role
 * @param {string} project The href to the Project
 * @param {string} principal The href to the User
 * @param {string} role The href to the Role
 */
async function addMember(project, principal, role) {
  console.log(
    "Adding " + principal + " to project " + project + " with role " + role,
  );

  try {
    await openProjectApi.post("/memberships", {
      _links: {
        principal: { href: principal },
        roles: [{ href: role }],
        project: { href: project },
      },
    });
  } catch (error) {
    console.error("Could not add user: " + error.message);
    throw error;
  }
}

/**
 * Determines if the error was caused by non-membership and adds the missing members, if required.
 * @param {object} errorDetails The error details from OpenProject
 * @param {object} payload The Payload that should have been sent. Will not be modified.
 * @param {string} role The href to the role with which to add new members
 * @param {string} project The href to the project to which missing members shall be added.
 * @returns {boolean} Whether new members have been added or not.
 */
async function addMissingMembers(errorDetails, payload, role, project) {
  const missingMembers = getMissingMembers(errorDetails);
  if (missingMembers.length != 0) {
    console.log("Operation failed because Users were not members of project. Adding...");
    const addedHrefs = [];
    for (const member of missingMembers) {
      const memberHref = payload._links[member].href;
      if (addedHrefs.includes(memberHref)) {
        continue;
      }

      await addMember(
        project,
        memberHref,
        role,
      );
      addedHrefs.push(memberHref);
    }
    return true;
  }
  return false;
}

async function updateWorkPackage(workPackageId, payload, missingMembers = { add: false }) {
  // Remove _type from update payload 
  const { _type, ...updatePayload } = payload;
  let project = null;

  try {
    // Get current work package to get its lock version and add it to the update payload
    const currentWP = await openProjectApi.get(
      `/work_packages/${workPackageId}`
    );
    updatePayload.lockVersion = currentWP.data.lockVersion;
    project = currentWP.data._links.project.href;

    const response = await openProjectApi.patch(
      `/work_packages/${workPackageId}`,
      updatePayload
    );
    return response.data;
  } catch (error) {
    console.error(
      `Error updating work package ${workPackageId}:`,
      error.message
    );
    if (error.response?.data) {
      if (missingMembers.add && project !== null) {
        if (await addMissingMembers(error.response.data, updatePayload, missingMembers.role, project)) {
          console.log("Retrying...");
          return (await openProjectApi.patch(`/work_packages/${workPackageId}`, updatePayload)).data;
        } else {
          console.error(
            "Error details:",
            JSON.stringify(error.response.data, null, 2)
          );
          throw error;
        }
      } else {
        console.error(
          "Error details:",
          JSON.stringify(error.response.data, null, 2)
        );
        throw error;
      }
    } else {
      throw error;
    }
  }
}

async function addComment(workPackageId, comment) {
  try {
    await openProjectApi.post(`/work_packages/${workPackageId}/activities`, {
      comment: {
        raw: Buffer.from(comment).toString("utf8"),
      },
    });
  } catch (error) {
    console.error(
      `Error adding comment to work package ${workPackageId}:`,
      error.message
    );
    throw error;
  }
}

async function uploadAttachment(workPackageId, filePath, fileName, mimeType) {
  try {
    const formData = new FormData();
    formData.append("metadata", JSON.stringify({ fileName }));
    formData.append("file", fs.createReadStream(filePath));

    const response = await openProjectApi.post(
      `/work_packages/${workPackageId}/attachments`,
      formData
    );
    return response.data;
  } catch (error) {
    console.error(
      `Error uploading attachment to work package ${workPackageId}:`,
      error.message
    );
    throw error;
  }
}

async function addWatcher(workPackageId, userId, missingMembers = { add: false }, projectId = null) {
  try {
    console.log(
      `Adding watcher (userId: ${userId}) to work package ${workPackageId}...`
    );
    await openProjectApi.post(`/work_packages/${workPackageId}/watchers`, {
      user: { href: `/api/v3/users/${userId}` },
    });
    console.log(
      `Successfully added watcher ${userId} to work package ${workPackageId}`
    );
  } catch (error) {
    // Ignore if watcher already exists (409 Conflict)
    if (error.response?.status === 409) {
      console.log(
        `Watcher ${userId} is already watching work package ${workPackageId}`
      );
    } else {
      console.error(
        `Error adding watcher ${userId} to work package ${workPackageId}:`,
        error.message
      );
      if (error.response?.data) {
        if (missingMembers.add && isMemberError(error.response.data)) {
          console.log("Creation failed because watcher is no member. Adding to project...");
          await addMember(`/api/v3/projects/${projectId}`, `/api/v3/users/${userId}`, missingMembers.role);
          console.log("retrying...");
          await openProjectApi.post(`/work_packages/${workPackageId}/watchers`, {
            user: { href: `/api/v3/users/${userId}` },
          });
        } else {
          console.error(
            "Error details:",
            JSON.stringify(error.response.data, null, 2),
          );
        }
      }
      if (error.response?.status === 404) {
        console.error(
          "This could mean either the work package or user doesn't exist"
        );
      } else if (error.response?.status === 403) {
        console.error(
          "This could mean insufficient permissions to add watchers"
        );
      }
    }
  }
}

async function listProjects() {
  try {
    const response = await openProjectApi.get("/projects");
    console.log("\nAvailable OpenProject Projects:");
    response.data._embedded.elements.forEach((project) => {
      console.log(`- ID: ${project.id}, Name: ${project.name}`);
    });
    return response.data._embedded.elements;
  } catch (error) {
    console.error("Error listing projects:", error.message);
    throw error;
  }
}

async function getRoleList() {
  try {
    const response = await openProjectApi.get("/roles");
    return response.data._embedded.elements;
  } catch (error) {
    console.error("Error getting Roles:", error.message);
    throw error;
  }
}

async function getWorkPackageTypes(projectId) {
  try {
    const endpoint = projectId
      ? `/projects/${projectId}/types`
      : "/types";
    const response = await openProjectApi.get(endpoint);
    workPackageTypes = response.data._embedded.elements;
    console.log("\nAvailable work package types:");
    workPackageTypes.forEach((type) => {
      console.log(`- ${type.name} (ID: ${type.id})`);
    });
    return workPackageTypes;
  } catch (error) {
    console.error("Error fetching work package types:", error.message);
    throw error;
  }
}

async function getWorkPackageStatuses() {
  try {
    const response = await openProjectApi.get("/statuses");
    workPackageStatuses = response.data._embedded.elements;
    console.log("\nAvailable work package statuses:");
    workPackageStatuses.forEach((status) => {
      console.log(`- ${status.name} (ID: ${status.id})`);
    });
    return workPackageStatuses;
  } catch (error) {
    console.error("Error fetching work package statuses:", error.message);
    throw error;
  }
}

async function getWorkPackagePriorities() {
  try {
    const response = await openProjectApi.get("/priorities");
    workPackagePriorities = response.data._embedded.elements;
    console.log("\nAvailable work package priorities:");
    workPackagePriorities.forEach((priority) => {
      console.log(`- ${priority.name} (ID: ${priority.id})`);
    });
    return workPackagePriorities;
  } catch (error) {
    console.error("Error fetching work package priorities:", error.message);
    throw error;
  }
}

function getWorkPackageTypeId(jiraIssueType) {
  console.log(`Mapping Jira type: ${jiraIssueType}`);
  const mappedType = typeMapping[jiraIssueType] || "Task"; // Default to Task if no mapping found 
  const typeObj = workPackageTypes.find(
    (t) => t.name.toLowerCase() === mappedType.toLowerCase()
  );
  if (!typeObj) {
    console.warn(
      `Could not find OpenProject type for ${jiraIssueType} (mapped to ${mappedType})`
    );
    return workPackageTypes[0].id;
  }
  console.log(
    `Mapped to OpenProject type: ${typeObj.name} (ID: ${typeObj.id})`
  );
  return typeObj.id;
}

function getWorkPackageStatusId(jiraStatus) {
  console.log(`Mapping Jira status: ${jiraStatus}`);
  const mappedStatus = statusMapping[jiraStatus] || "New"; // Default to New if no mapping found
  const statusObj = workPackageStatuses.find(
    (s) => s.name.toLowerCase() === mappedStatus.toLowerCase()
  );
  if (!statusObj) {
    console.warn(
      `Could not find OpenProject status for ${jiraStatus} (mapped to ${mappedStatus})`
    );
    return workPackageStatuses[0].id; // Default to first status
  }
  console.log(
    `Mapped to OpenProject status: ${statusObj.name} (ID: ${statusObj.id})`
  );
  return statusObj.id;
}

function getWorkPackagePriorityId(jiraPriority) {
  if (!jiraPriority) return null;

  console.log(`Mapping Jira priority: ${jiraPriority.name}`);
  const mappedPriority = priorityMapping[jiraPriority.name] || "Normal"; // Default to Normal if no mapping found
  const priorityObj = workPackagePriorities.find(
    (p) => p.name.toLowerCase() === mappedPriority.toLowerCase()
  );
  if (!priorityObj) {
    console.warn(
      `Could not find OpenProject priority for ${jiraPriority.name} (mapped to ${mappedPriority})`
    );
    return workPackagePriorities.find((p) => p.isDefault)?.id; // Default to the default priority
  }
  console.log(
    `Mapped to OpenProject priority: ${priorityObj.name} (ID: ${priorityObj.id})`
  );
  return priorityObj.id;
}

async function getExistingAttachments(workPackageId) {
  try {
    const response = await openProjectApi.get(
      `/work_packages/${workPackageId}/attachments`
    );
    return response.data._embedded.elements;
  } catch (error) {
    console.error(`Error getting existing attachments: ${error.message}`);
    return [];
  }
}

async function getExistingComments(workPackageId) {
  try {
    const response = await openProjectApi.get(
      `/work_packages/${workPackageId}/activities`
    );
    return response.data._embedded.elements.filter((e) => e.comment?.raw);
  } catch (error) {
    console.error(`Error getting existing comments: ${error.message}`);
    return [];
  }
}

async function getOpenProjectUsers() {
  try {
    const response = await openProjectApi.get("/users");
    openProjectUsers = response.data._embedded.elements;
    console.log("\nAvailable OpenProject users:");
    openProjectUsers.forEach((user) => {
      console.log(`- ${user.name} (ID: ${user.id}, Email: ${user.email})`);
    });
    return openProjectUsers;
  } catch (error) {
    console.error("Error fetching OpenProject users:", error.message);
    throw error;
  }
}

async function findExistingWorkPackage(jiraKey, projectId) {
  const fieldId = JIRA_ID_CUSTOM_FIELD;
  if (!fieldId) return null;

  try {
    const response = await openProjectApi.get("/work_packages", {
      params: {
        filters: JSON.stringify([
          { project: { operator: "=", values: [projectId.toString()] } },
          {
            [`customField${fieldId}`]: {
              operator: "=",
              values: [jiraKey],
            },
          },
        ]),
      },
    });

    const workPackages = response.data._embedded.elements;
    return workPackages.length > 0 ? workPackages[0] : null;
  } catch (error) {
    console.error(`Error finding existing work package: ${error.message}`);
    if (error.response?.data) {
      console.error(
        "Error details:",
        JSON.stringify(error.response.data, null, 2)
      );
    }
    return null;
  }
}

function getWorkPackageTypeName(typeId) {
  const type = workPackageTypes?.find((t) => t.id === typeId);
  return type ? type.name : "Unknown";
}

function getWorkPackageStatusName(statusId) {
  const status = workPackageStatuses?.find((s) => s.id === statusId);
  return status ? status.name : "Unknown";
}

async function getCustomFieldOptionsMap(customFieldIds, projectId, typeId) {
  const optionsMap = {};
  if (customFieldIds.length === 0) return optionsMap;

  try {
    const response = await openProjectApi.post("/work_packages/form", {
      _links: {
        project: { href: `/api/v3/projects/${projectId}` },
        type: { href: `/api/v3/types/${typeId}` },
      },
    });
    const schema = response.data._embedded?.schema;
    if (!schema) {
      console.warn("Could not retrieve work package form schema");
      return optionsMap;
    }

    for (const fieldId of customFieldIds) {
      const key = `customField${fieldId}`;
      const fieldSchema = schema[key];
      if (!fieldSchema) {
        console.warn(`  Custom field ${fieldId}: not found in work package schema`);
        continue;
      }

      const allowedValues = fieldSchema._links?.allowedValues;
      if (allowedValues && allowedValues.length > 0) {
        const valueToHref = {};
        for (const av of allowedValues) {
          const value = av.title;
          if (value) {
            valueToHref[value] = av.href;
          }
        }
        optionsMap[fieldId] = valueToHref;
        console.log(
          `  Custom field ${fieldId}: found ${Object.keys(valueToHref).length} option(s)`
        );
      } else {
        console.warn(
          `  Custom field ${fieldId}: no allowedValues in schema`
        );
      }
    }
  } catch (error) {
    console.warn(
      `Could not fetch custom field options via form: ${error.message}`
    );
  }
  return optionsMap;
}

module.exports = {
  getOpenProjectWorkPackages,
  setParentWorkPackage,
  createOpenProjectUser,
  createWorkPackage,
  updateWorkPackage,
  addComment,
  uploadAttachment,
  addWatcher,
  listProjects,
  getRoleList,
  getWorkPackageTypes,
  getWorkPackageStatuses,
  getWorkPackagePriorities,
  getWorkPackageTypeId,
  getWorkPackageStatusId,
  getWorkPackagePriorityId,
  getExistingAttachments,
  getExistingComments,
  getOpenProjectUsers,
  findExistingWorkPackage,
  getWorkPackageTypeName,
  getWorkPackageStatusName,
  typeMapping,
  statusMapping,
  priorityMapping,
  JIRA_ID_CUSTOM_FIELD,
  requireJiraIdField,
  getCustomFieldOptionsMap,
};
