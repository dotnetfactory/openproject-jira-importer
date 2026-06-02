const fs = require("fs");
const path = require("path");
const inquirer = require("inquirer");
const { jiraApi, openProjectApi } = require("./apis.js");

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
    const openProjectUsersByMail = {};
    for (const openProjectUser of openProjectUsers) {
      if (!openProjectUser.email) continue; 
      openProjectUsersByMail[openProjectUser.email.toLowerCase()] = openProjectUser;
    }

    console.log("\nJira Users:");
    jiraUsers.forEach((user) => {
      console.log(`- ${user.displayName} (${user.emailAddress || "No email"})`);
    });

    console.log("\nOpenProject Users:");
    openProjectUsers.forEach((user) => {
      console.log(`- ${user.name} (${user.email || "No email"})`);
    });

    // #31: Read existing mapping if available
    const mappingPath = path.join(__dirname, "user-mapping.generated.js");
    if (fs.existsSync(mappingPath)) {
      /** `var` to keep existingMapping in function scope */
      var existingMapping = require(mappingPath);
      console.log(
        "\nExisting user mapping found, pre-filling answers where possible."
      );
    } else {
      console.log("\nNo existing user mapping found.");
    }

    // Create mapping through interactive prompts
    const mapping = {};
    const openProjectChoices = [
      // Skip option first, so that it appears at the top and can be selected easily
      // for the many system users that may not have a corresponding user in OpenProject
      { name: "Skip this user", value: null },
      ...openProjectUsers.map((user) => ({
        name: `${user.name} (${user.email || "No email"})`,
        value: user.id,
      })),
    ];
    for (const jiraUser of jiraUsers) {
      if (!jiraUser.active) continue;

      let choices = openProjectChoices;
      // #31: Pre-fill existing mapping if available
      let existingAnswer = null;
      if (existingMapping) {
        existingAnswer = openProjectChoices.find(
          (choice) => choice.value === existingMapping[jiraUser.accountId]
        );
        if (existingAnswer) {
          // Add existing answer first so that it appears selected
          choices = [existingAnswer, ...openProjectChoices];
        }
      }

      // Pre Select an open project user with the same email address
      if ((!existingAnswer) && jiraUser.emailAddress && openProjectUsersByMail[jiraUser.emailAddress.toLowerCase()]) {
        const foundUser = openProjectUsersByMail[jiraUser.emailAddress.toLowerCase()];
        choices = [ { name: `${foundUser.name} (${foundUser.email})`, value: foundUser.id }, ...openProjectChoices ]
      }

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

    saveMapping(mapping);

    return mapping;
  } catch (error) {
    console.error("Error generating mapping:", error.message);
    throw error;
  }
}

function saveMapping(mapping) {
  // Save mapping to file
    const mappingContent = `// Generated user mapping - ${new Date().toISOString()}
const userMapping = ${JSON.stringify(mapping, null, 2)};

module.exports = userMapping;
`;

    fs.writeFileSync(path.join(__dirname, "user-mapping.generated.js"), mappingContent);
    console.log("\nUser mapping has been saved to user-mapping.generated.js");
}

// If running directly (not imported)
if (require.main === module) {
  generateMapping().catch(console.error);
}

module.exports = { generateMapping, saveMapping };
