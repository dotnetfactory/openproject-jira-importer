const fs = require("node:fs/promises");
const path = require("path");
const inquirer = require("inquirer");
const { getWorkPackageStatuses } = require("./openproject-client.js");
const { getAllJiraStatuses } = require("./jira-client.js");

async function generateMapping() {
    // Loading statuses, initializing empty mappings and choices
    const jiraStatuses = await getAllJiraStatuses();
    const opStatuses = await getWorkPackageStatuses();
    let statusMapping = {};
    let defaultStatus = null;

    const choices = [
        { name: "Use default status", value: null },
        ...opStatuses.map((status) => { return { name: status.name, value: status._links.self.href } })
    ];

    // Directly load existing mappings into current mappings, if existing
    const mappingPath = path.join(__dirname, "status-mapping.generated.js");
    try {
        await fs.access(mappingPath);
        ({ statusMapping, defaultStatus } = require(mappingPath));
        console.log("\nExisting mapping found, pre-filling answers where possible.");
    } catch {
        console.log("\nNo existing mapping found.");
    }

    // Select default Status
    ({ defaultStatus } = await inquirer.prompt([
        {
            type: "list",
            name: "defaultStatus",
            message: `Select a default Status for all unmapped Statuses`,
            choices: choices.slice(1),
        },
    ]));

    // Map each jira Status
    for (const jiraStatus of jiraStatuses) {
        const preSelected = statusMapping[jiraStatus.id] ?? null;
        const answer = await inquirer.prompt([
            {
                type: "list",
                name: "openProjectStatus",
                message: `Select OpenProject Status for Jira Status: ${jiraStatus.name}`,
                choices: preSelect(preSelected, choices),
            },
        ]);

        if (answer.openProjectStatus !== null) {
            statusMapping[jiraStatus.id] = answer.openProjectStatus;
        } else if (statusMapping[jiraStatus.id]) {
            delete statusMapping[jiraStatus.id];
        }
    }

    // save and return mapping
    await saveMapping(statusMapping, defaultStatus);
    return { statusMapping, defaultStatus };
}

function preSelect(value, choices) {
    if (value === null) {
        return choices;
    }

    const foundAnswer = choices.find((option) => option.value == value);
    if (!foundAnswer) {
        return choices;
    }
    return [ foundAnswer, ...choices.filter((option) => option !== foundAnswer) ];
}

async function saveMapping (mapping, defaultStatus) {
    // Save mapping to file
    const mappingContent = `// Generated status mapping - ${new Date().toISOString()}
const statusMapping = ${JSON.stringify(mapping, null, 2)};
 const defaultStatus = ${JSON.stringify(defaultStatus)};

module.exports = { statusMapping, defaultStatus };
`;
    
    await fs.writeFile(path.join(__dirname, "status-mapping.generated.js"), mappingContent);
    console.log("\nStatus mapping has been saved to status-mapping.generated.js");
}

// If running directly (not imported)
if (require.main === module) {
  generateMapping().catch(console.error);
}

module.exports = { generateMapping };