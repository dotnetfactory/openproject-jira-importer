require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const inquirer = require("inquirer");

// Jira API configuration
const jiraConfig = {
  baseURL: `https://${process.env.JIRA_HOST}/rest/api/3`,
  auth: {
    username: process.env.JIRA_EMAIL,
    password: process.env.JIRA_API_TOKEN,
  },
};

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

const jiraApi = axios.create(jiraConfig);
const openProjectApi = axios.create(openProjectConfig);

async function getJiraUsers() {
  try {
    console.log("\nFetching Jira users...");
    const response = await jiraApi.get("/users/search", {
      params: {
        maxResults: 1000,
      },
    });
    return response.data.map((user) => ({
      accountId: user.accountId,
      displayName: user.displayName,
      emailAddress: user.emailAddress,
      active: user.active,
    }));
  } catch (error) {
    console.error("Error fetching Jira users:", error.message);
    throw error;
  }
}

async function getOpenProjectUsers() {
  try {
    console.log("\nFetching OpenProject users...");
    const response = await openProjectApi.get("/users");
    return response.data._embedded.elements.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      status: user.status,
    }));
  } catch (error) {
    console.error("Error fetching OpenProject users:", error.message);
    throw error;
  }
}

async function generateMapping() {
  try {
    // Fetch users from both systems
    const jiraUsers = await getJiraUsers();
    const openProjectUsers = await getOpenProjectUsers();

    console.log("\nJira Users:");
    jiraUsers.forEach((user) => {
      console.log(`- ${user.displayName} (${user.emailAddress || "No email"})`);
    });

    console.log("\nOpenProject Users:");
    openProjectUsers.forEach((user) => {
      console.log(`- ${user.name} (${user.email || "No email"})`);
    });

    // Create mapping through interactive prompts
    const mapping = {};
    const choices = [
      ...openProjectUsers.map((user) => ({
        name: `${user.name} (${user.email || "No email"})`,
        value: user.id,
      })),
      { name: "Skip this user", value: null },
    ];
    for (const jiraUser of jiraUsers) {
      if (!jiraUser.active) continue;

      const answer = await inquirer.prompt([
        {
          type: "list",
          name: "openProjectId",
          message: `Select OpenProject user for Jira user: ${
            jiraUser.displayName
          } (${jiraUser.emailAddress || "No email"})`,
          choices,
        },
      ]);

      if (answer.openProjectId !== null) {
        mapping[jiraUser.accountId] = answer.openProjectId;
      }
    }

    // Save mapping to file
    const mappingContent = `// Generated user mapping - ${new Date().toISOString()}
const userMapping = ${JSON.stringify(mapping, null, 2)};

module.exports = userMapping;
`;

    fs.writeFileSync(path.join(__dirname, "user-mapping.js"), mappingContent);
    console.log("\nUser mapping has been saved to user-mapping.js");

    return mapping;
  } catch (error) {
    console.error("Error generating mapping:", error.message);
    throw error;
  }
}

// If running directly (not imported)
if (require.main === module) {
  generateMapping().catch(console.error);
}

module.exports = { generateMapping };
