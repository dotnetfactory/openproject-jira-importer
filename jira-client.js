require("dotenv").config();
const axios = require("axios");
const path = require("path");
const fs = require("fs");

// Jira API configuration
const jiraConfig = {
  baseURL: `https://${process.env.JIRA_HOST}/rest/api/3`,
  auth: {
    username: process.env.JIRA_EMAIL,
    password: process.env.JIRA_API_TOKEN,
  },
};

const jiraApi = axios.create(jiraConfig);

// Create a download client without default content-type
const downloadClient = axios.create({
  ...jiraConfig,
  responseType: "arraybuffer",
});

const DEFAULT_FIELDS = [
  "summary",
  "description",
  "status",
  "priority",
  "issuetype",
  "attachment",
  "comment",
  "issuelinks",
  "assignee",
  "creator",
  "created",
  "customfield_10014", // Epic Link field
  "parent",
  "watches",
].join(",");

async function getAllJiraIssues(projectKey, fields = DEFAULT_FIELDS) {
  try {
    let allIssues = [];
    const maxResults = 100;
    let nextPageToken = undefined;

    // Validate project key
    if (!projectKey) {
      throw new Error("Project key is required");
    }

    // Validate project key format
    if (!/^[A-Z][A-Z0-9_]+$/.test(projectKey)) {
      throw new Error(
        "Invalid project key format. Project keys should be uppercase and may contain numbers."
      );
    }

    let page = 1;
    while (true) {
      console.log(`Fetching issues page ${page}...`);
      try {
        const body = {
          jql: `project = "${projectKey}" ORDER BY created ASC`,
          maxResults,
          fields: fields.split ? fields.split(",") : fields,
          expand: "renderedFields",
        };
        if (nextPageToken) body.nextPageToken = nextPageToken;
        const response = await jiraApi.post("/search/jql", body);
        const { issues, nextPageToken: newToken } = response.data;

        if (!issues || issues.length === 0) {
          if (allIssues.length === 0) {
            console.warn(
              `No issues found in project ${projectKey}. Please check:`
            );
            console.warn("1. The project key is correct");
            console.warn("2. The project contains issues");
            console.warn("3. You have permission to view issues");
          }
          break;
        }

        allIssues = allIssues.concat(issues);
        if (!newToken) {
          console.log(`Retrieved all ${allIssues.length} issues`);
          break;
        }
        nextPageToken = newToken;
        page++;
      } catch (error) {
        if (error.response?.status === 400) {
          console.error(`\nError fetching issues for project ${projectKey}:`);
          console.error("1. Verify the project key exists");
          console.error("2. Check you have access to the project");
          console.error("3. Ensure the project key is in the correct format");
          if (error.response.data) {
            console.error("\nJira API Error Details:", error.response.data);
          }
        }
        throw error;
      }
    }

    return allIssues;
  } catch (error) {
    console.error("Error fetching Jira issues:");
    if (error.response) {
      console.error(`Status code: ${error.response.status}`);
      console.error("Response data:", error.response.data);
    }
    throw error;
  }
}

async function getSpecificJiraIssues(
  projectKey,
  issueKeys,
  fields = DEFAULT_FIELDS
) {
  try {
    console.log(`Fetching specific issues: ${issueKeys.join(", ")}...`);
    const body = {
      jql: `key in ("${issueKeys.join('","')}")`,
      maxResults: issueKeys.length,
      fields: fields.split ? fields.split(",") : fields,
      expand: "renderedFields",
    };
    const response = await jiraApi.post("/search/jql", body);
    return response.data.issues;
  } catch (error) {
    console.error("Error fetching specific Jira issues:", error.message);
    throw error;
  }
}

async function getJiraUserEmail(accountId) {
  try {
    console.log(`Fetching email for Jira user with accountId: ${accountId}`);
    const response = await jiraApi.get(`/user/properties/email`, {
      params: {
        accountId: accountId,
      },
    });
    console.log("Jira API response:", response.data);
    return response.data.value;
  } catch (error) {
    console.error("Error fetching Jira user email:", error.message);
    return null;
  }
}

async function downloadAttachment(url, filePath) {
  try {
    const response = await downloadClient.get(url);
    const tempDir = path.dirname(filePath);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    fs.writeFileSync(filePath, response.data);
    return filePath;
  } catch (error) {
    console.error(`Error downloading attachment: ${error.message}`);
    return null;
  }
}

async function listProjects() {
  try {
    const response = await jiraApi.get("/project");
    if (!response.data || response.data.length === 0) {
      console.error(
        "No projects found in Jira. Please check your permissions."
      );
      console.error(
        "Make sure your Jira API token has access to view projects."
      );
      throw new Error("No projects found");
    }
    return response.data;
  } catch (error) {
    console.error("Error fetching Jira projects:");
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      console.error(`Status code: ${error.response.status}`);
      console.error("Response data:", error.response.data);
      console.error("Response headers:", error.response.headers);

      if (error.response.status === 401) {
        console.error("\nAuthentication failed. Please check:");
        console.error("1. Your JIRA_EMAIL is correct");
        console.error("2. Your JIRA_API_TOKEN is valid and not expired");
        console.error("3. Your JIRA_HOST is correct");
      } else if (error.response.status === 403) {
        console.error("\nPermission denied. Please check:");
        console.error("1. Your API token has sufficient permissions");
        console.error("2. You have access to the Jira instance");
      } else if (error.response.status === 400) {
        console.error("\nInvalid request. Please check:");
        console.error(
          "1. Your JIRA_HOST is in the correct format (e.g., your-domain.atlassian.net)"
        );
        console.error("2. The project key is valid");
      }
    } else if (error.request) {
      // The request was made but no response was received
      console.error("No response received from Jira. Please check:");
      console.error("1. Your internet connection");
      console.error("2. The Jira host is accessible");
      console.error("3. JIRA_HOST is correct in your .env file");
    } else {
      // Something happened in setting up the request that triggered an Error
      console.error("Error setting up the request:", error.message);
    }
    throw error;
  }
}

async function getIssueWatchers(issueKey) {
  try {
    console.log(`Fetching watchers for Jira issue ${issueKey}...`);
    const response = await jiraApi.get(`/issue/${issueKey}/watchers`);
    console.log(
      `Found ${response.data.watchers?.length || 0} watchers for ${issueKey}`
    );
    if (response.data.watchers?.length > 0) {
      console.log(
        "Watchers:",
        response.data.watchers.map((w) => w.displayName).join(", ")
      );
    }
    return response.data;
  } catch (error) {
    console.error(
      `Error getting watchers for issue ${issueKey}:`,
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

module.exports = {
  getAllJiraIssues,
  getSpecificJiraIssues,
  getJiraUserEmail,
  downloadAttachment,
  listProjects,
  getIssueWatchers,
  DEFAULT_FIELDS,
};
