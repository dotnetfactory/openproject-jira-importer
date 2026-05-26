require("dotenv").config();
const axios = require("axios");

// Jira API configuration
const jiraConfig = {
  baseURL: `https://${process.env.JIRA_HOST}/rest/api/2`,
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
    const response = await jiraApi.get("/users/search", {
      params: {
        maxResults: 1000,
      },
    });
    console.log("\nJira Users:");
    console.log("===========");
    response.data.forEach((user) => {
      console.log(`${user.displayName} (AccountId: ${user.accountId})`);
    });
  } catch (error) {
    console.error("Error fetching Jira users:", error.message);
  }
}

async function getOpenProjectUsers() {
  try {
    const response = await openProjectApi.get("/users");
    console.log("\nOpenProject Users:");
    console.log("=================");
    response.data._embedded.elements.forEach((user) => {
      console.log(`${user.name} (ID: ${user.id}, Email: ${user.email})`);
    });
  } catch (error) {
    console.error("Error fetching OpenProject users:", error.message);
  }
}

async function main() {
  await getJiraUsers();
  await getOpenProjectUsers();
}

main();
