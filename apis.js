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

// Jira API configuration
const jiraConfig = {
  baseURL: `https://${process.env.JIRA_HOST}/rest/api/2`,
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

module.exports = { jiraApi, downloadClient, openProjectApi };