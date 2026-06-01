const { jiraApi, openProjectApi } = require("./apis.js");

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
