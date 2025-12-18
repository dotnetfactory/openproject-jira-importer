require("dotenv").config();
const axios = require("axios");

// OpenProject API configuration
const openProjectConfig = {
  baseURL: `${process.env.OPENPROJECT_HOST}/api/v3`,
  headers: {
    Authorization: `Basic ${Buffer.from(
      `apikey:${process.env.OPENPROJECT_API_KEY}`
    ).toString("base64")}`,
    "Content-Type": "application/json",
  },
};

const openProjectApi = axios.create(openProjectConfig);

// Store issue key to work package ID mapping
const issueToWorkPackageMap = new Map();

// Track missing relationships to retry later
const missingRelationships = new Set();

/**
 * Check if a parent relationship already exists between two work packages
 * (whatever the direction is).
 * Unfortunately, OpenProject does not expose parent relationships via the /relations endpoint,
 * so we need to fetch the work package details to check for parent links.
 * https://www.openproject.org/docs/api/endpoints/work-packages/#view-work-package
 *
 * @param {string} fromId of Work Package to check relation for
 * @param {string} toId of Work Package to check relation for
 * @returns
 */
async function checkParentRelationship(fromId, toId) {
  try {
    // We do not care about direction here, just if a parent-child relationship exists,
    // so we pick one Work Package to fetch and check if the other one is its parent
    // or one of its children.
    const response = await openProjectApi.get(`/work_packages/${fromId}`);
    const parentLink = response.data._links.parent;
    const childrenLinks = response.data._links.children;
    const toIdStr = toId.toString();

    if (
      // Check if fromId has toId as parent...
      getHrefId(parentLink?.href) === toIdStr ||
      // ...or if fromId has toId as child
      childrenLinks?.find((child) => getHrefId(child?.href) === toIdStr)
    ) {
      console.log(
        `Found existing parent relationship between ${fromId} and ${toId}`
      );
      return true;
    }
  } catch (error) {
    console.error(`Error checking parent relationship: ${error.message}`);
  }
  return false;
}

/**
 * Extracts the ID from a given href by splitting on "/" and returning the last segment.
 * @example
 * getHrefId("/api/v3/work_packages/123") // returns "123"
 * @param {string | undefined} href - The href string to extract the ID from.
 * @returns {string | undefined} The extracted ID.
 */
function getHrefId(href) {
  return href?.split("/").pop();
}

async function checkExistingRelationship(fromId, toId, type) {
  try {
    // #33: OpenProject does not allow multiple relationships of any type
    // between the same two work packages, regardless of direction,
    // so detect them before attempting creation.
    // https://github.com/opf/openproject/blob/v16.6.3/app/models/work_packages/scopes/relatable.rb#L34-L201
    console.log(
      `\nChecking for existing relationship between ${fromId} and ${toId}`
    );
    // #33: parent-child prevents any other relationships, whatever their type and direction are.
    if (await checkParentRelationship(fromId, toId)) {
      console.log(
        `Found existing parent relationship, skipping ${type} creation`
      );
      return true;
    }

    // #33: strangely, "or" operator in filters does not seem to work as expected,
    // but we can simply list both work package IDs in both "to" and "from" filters
    // (this could also match relations from A to A or from B to B, but those are not possible in our case)
    const filter = {
      operator: "=",
      values: [fromId.toString(), toId.toString()],
    };
    const filters = [
      // #36: Check both directions as 2 separate filters
      // (OpenProject combines them with AND logic),
      // OpenProject expects objects with a single property
      // https://github.com/opf/openproject/blob/v16.6.3/app/services/api/v3/parse_query_params_service.rb#L138
      {
        from: filter,
      },
      {
        to: filter,
      },
    ];

    // Use the relations endpoint with filters
    const response = await openProjectApi.get("/relations", {
      params: {
        filters: JSON.stringify(filters),
      },
    });

    // Log the API response for debugging
    console.log("API Response:", JSON.stringify(response.data, null, 2));

    // If we find any relations matching our criteria, a relationship exists
    const exists = response.data.total > 0;
    console.log(
      `Relationship exists: ${exists} (found ${response.data.total} matches)`
    );

    // Add detailed logging about any found relationships
    if (exists && response.data._embedded.elements.length > 0) {
      const relation = response.data._embedded.elements[0];
      console.log("\nFound existing relationship details:");
      console.log(`- Relation ID: ${relation.id}`);
      console.log(`- Type: ${relation.type}`);
      console.log(
        `- From: ${relation._links.from.title} (ID: ${relation._links.from.href
          .split("/")
          .pop()})`
      );
      console.log(
        `- To: ${relation._links.to.title} (ID: ${relation._links.to.href
          .split("/")
          .pop()})`
      );
      console.log(
        `- Direction: ${
          relation._links.from.href.split("/").pop() === fromId
            ? "forward"
            : "reverse"
        }`
      );
    }

    return exists;
  } catch (error) {
    console.error(`Error checking existing relationship: ${error.message}`);
    if (error.response?.data) {
      console.error(
        "Error details:",
        JSON.stringify(error.response.data, null, 2)
      );
    }
    return false;
  }
}

async function createRelationship(fromId, toId, type) {
  try {
    console.log(
      `\nAttempting to create relationship: ${fromId} ${type} ${toId}`
    );

    // Check if relationship already exists
    const exists = await checkExistingRelationship(fromId, toId, type);
    if (exists) {
      console.log(
        `Relationship already exists: ${type} from ${fromId} to ${toId}`
      );
      return;
    }

    // Create new relationship
    const payload = {
      type: type,
      description: "Created by Jira migration",
      lag: 0,
      _links: {
        to: {
          href: `/api/v3/work_packages/${toId}`,
        },
      },
    };

    console.log(
      "Creating relationship with payload:",
      JSON.stringify(payload, null, 2)
    );

    // The correct endpoint is /api/v3/work_packages/{id}/relations
    const response = await openProjectApi.post(
      `/work_packages/${fromId}/relations`,
      payload
    );
    console.log("Creation response:", JSON.stringify(response.data, null, 2));
    console.log(`Created ${type} relationship: ${fromId} -> ${toId}`);
  } catch (error) {
    console.error(
      `Error creating relationship: ${fromId} -> ${toId} ${type} ${error.message}`
    );
    if (error.response?.data) {
      console.error(
        "Error details:",
        JSON.stringify(error.response.data, null, 2)
      );
    }
  }
}

async function handleRelationships(issue) {
  if (!issue.fields.issuelinks && !issue.fields.customfield_10014) return;

  const fromWorkPackageId = issueToWorkPackageMap.get(issue.key);
  if (!fromWorkPackageId) return;

  // Handle epic link first
  if (issue.fields.customfield_10014) {
    const epicKey = issue.fields.customfield_10014;
    const epicWorkPackageId = issueToWorkPackageMap.get(epicKey);
    if (epicWorkPackageId) {
      await createRelationship(fromWorkPackageId, epicWorkPackageId, "partof");
    } else {
      console.log(
        `Epic ${epicKey} not found in current migration batch, will retry later`
      );
      missingRelationships.add(
        JSON.stringify({
          fromKey: issue.key,
          toKey: epicKey,
          type: "partof",
        })
      );
    }
  }

  // Handle regular issue links
  if (!issue.fields.issuelinks || issue.fields.issuelinks.length === 0) return;

  for (const link of issue.fields.issuelinks) {
    let relatedIssueKey;
    let relationType;
    let shouldSkip = false;

    if (link.outwardIssue) {
      relatedIssueKey = link.outwardIssue.key;
      switch (link.type.outward) {
        case "blocks":
          relationType = "blocks";
          break;
        case "relates to":
          relationType = "relates";
          break;
        case "is parent of":
          relationType = "includes";
          break;
        case "duplicates":
          // For duplicates, only create the relationship if this is the newer issue
          relationType = "duplicates";
          // Skip if we've already processed this pair in the other direction
          shouldSkip = issue.fields.created > link.outwardIssue.fields?.created;
          break;
        default:
          relationType = "relates";
      }
    } else if (link.inwardIssue) {
      relatedIssueKey = link.inwardIssue.key;
      switch (link.type.inward) {
        case "is blocked by":
          relationType = "blocked";
          break;
        case "relates to":
          relationType = "relates";
          break;
        case "is child of":
          relationType = "partof";
          break;
        case "is duplicated by":
          // For duplicates, only create the relationship if this is the newer issue
          relationType = "duplicated";
          // Skip if we've already processed this pair in the other direction
          shouldSkip = issue.fields.created < link.inwardIssue.fields?.created;
          break;
        default:
          relationType = "relates";
      }
    }

    if (shouldSkip) {
      console.log(
        `Skipping duplicate relationship for ${issue.key} to avoid circular dependency`
      );
      continue;
    }

    const toWorkPackageId = issueToWorkPackageMap.get(relatedIssueKey);
    if (toWorkPackageId) {
      try {
        await createRelationship(
          fromWorkPackageId,
          toWorkPackageId,
          relationType
        );
      } catch (error) {
        console.error(
          `Failed to create relationship: ${issue.key} ${relationType} ${relatedIssueKey}`
        );
        // Store failed relationship to retry
        missingRelationships.add(
          JSON.stringify({
            fromKey: issue.key,
            toKey: relatedIssueKey,
            type: relationType,
          })
        );
      }
    } else {
      console.log(
        `Skipping relationship: Target issue ${relatedIssueKey} not found in current migration batch`
      );
      // Store missing relationship to retry
      missingRelationships.add(
        JSON.stringify({
          fromKey: issue.key,
          toKey: relatedIssueKey,
          type: relationType,
        })
      );
    }
  }
}

async function retryMissingRelationships() {
  if (missingRelationships.size === 0) return;

  console.log(
    `\nRetrying ${missingRelationships.size} missing relationships...`
  );
  const retryRelationships = Array.from(missingRelationships).map((r) =>
    JSON.parse(r)
  );
  missingRelationships.clear();

  for (const rel of retryRelationships) {
    const fromWorkPackageId = issueToWorkPackageMap.get(rel.fromKey);
    const toWorkPackageId = issueToWorkPackageMap.get(rel.toKey);

    if (fromWorkPackageId && toWorkPackageId) {
      try {
        await createRelationship(fromWorkPackageId, toWorkPackageId, rel.type);
        console.log(
          `Created relationship: ${rel.fromKey} ${rel.type} ${rel.toKey}`
        );
      } catch (error) {
        console.error(
          `Failed to create relationship: ${rel.fromKey} ${rel.type} ${rel.toKey}`
        );
      }
    } else {
      console.log(
        `Still missing work package for relationship: ${rel.fromKey} ${rel.type} ${rel.toKey}`
      );
    }
  }
}

async function createRelationships(issues, issueKeyToWorkPackageIdMap) {
  try {
    console.log("\n=== Creating Relationships ===");

    // Update the mapping with provided data
    for (const [key, id] of Object.entries(issueKeyToWorkPackageIdMap)) {
      issueToWorkPackageMap.set(key, id);
    }

    // First pass: Create all relationships
    for (const issue of issues) {
      await handleRelationships(issue);
    }

    // Final pass: Retry any missing relationships
    await retryMissingRelationships();

    console.log("\n=== Relationship Creation Complete ===");
  } catch (error) {
    console.error("\nRelationship creation failed:", error.message);
  }
}

module.exports = { createRelationships };
