# OpenProject Jira Migration Tool

A tool to migrate issues from Jira to OpenProject, including attachments, comments, relationships, and priorities.

## Features

- Migrates issues with their descriptions, priorities, and statuses
- Preserves issue relationships and hierarchies
- Migrates attachments and comments
- Migrates watchers
- Maps Jira users to OpenProject users
- Tracks original Jira issue IDs
- Handles incremental migrations

## Prerequisites

1. Node.js installed
2. Access to both Jira and OpenProject instances
3. API tokens/keys for both systems
4. Custom field in OpenProject to store Jira issue IDs

## Setup

1. Clone this repository
2. Run `npm install` to install dependencies
3. Copy `.env.example` to `.env`
4. Configure your environment variables in `.env`

### Environment Variables

#### Jira Configuration

- `JIRA_HOST`: Your Jira instance hostname (e.g., your-domain.atlassian.net)
- `JIRA_EMAIL`: Your Jira email address
- `JIRA_API_TOKEN`: Your Jira API token (generate at https://id.atlassian.com/manage-profile/security/api-tokens)

#### OpenProject Configuration

- `OPENPROJECT_HOST`: Your OpenProject instance URL
- `OPENPROJECT_API_KEY`: Your OpenProject API key (generate in Settings > My account > Access token)

#### Custom Field Configuration

- `JIRA_ID_CUSTOM_FIELD`: The ID of the custom field in OpenProject that stores the Jira issue ID
  - This must be a text custom field
  - Find the ID in OpenProject: Administration > Custom fields > Work packages
  - Default value is 1 if not specified

### OpenProject Custom Field Setup

1. In OpenProject, go to Administration > Custom fields > Work packages
2. Create a new text custom field (if not already exists)
3. Note the ID of the custom field
4. Set this ID in your `.env` file as `JIRA_ID_CUSTOM_FIELD`

## Usage

Run the migration tool:

```bash
node migrate.js
```

Follow the interactive prompts to:

1. Select source Jira project
2. Select target OpenProject project
3. Choose migration type (full or specific issues)
4. Confirm existing issue handling

For non-interactive usage or specific issues:

```bash
# Migrate specific issues
node migrate.js JIRA_PROJECT_KEY OPENPROJECT_ID ISSUE1,ISSUE2

# Migrate relationships only
node migrate-relationships.js JIRA_PROJECT_KEY OPENPROJECT_ID

# Migrate parent-child hierarchies only
node migrate-parents.js JIRA_PROJECT_KEY OPENPROJECT_ID [ISSUE1,ISSUE2]
```

The `migrate-parents.js` script specifically handles parent-child hierarchies from Jira to OpenProject. While `migrate-relationships.js` handles all types of relationships (blocks, relates, etc.), this script focuses only on the hierarchical structure.

Key features:

- Migrates Jira's parent-child relationships to OpenProject's hierarchical structure
- Can process specific issues or entire project
- Preserves existing work package data
- Shows detailed progress and results

Use this when:

- You need to fix hierarchy issues
- You want to migrate parent-child relationships separately
- You're troubleshooting hierarchy-specific problems

Note: Run this script before `migrate-relationships.js` as OpenProject doesn't allow both parent-child hierarchies and "partof"/"includes" relationships between the same work packages.

```bash
# Remove duplicate work packages
node remove-duplicates.js OPENPROJECT_ID

# Delete all relationships
node delete-relationships.js OPENPROJECT_ID
```

This will delete all relationships (including parent-child hierarchies) between work packages in the specified project.
Useful for:

- Testing relationship migration
- Cleaning up before re-running relationship migration
- Removing problematic relationships

The script preserves all work packages and their data, only removing the relationships between them.

## Troubleshooting

If you encounter issues:

1. Check your API tokens and permissions
2. Verify the custom field ID is correct
3. Ensure users are properly mapped
4. Check the console output for detailed error messages

## Paid Dry-Run Review

Before running a production migration, use the free [migration dry-run checklist](docs/migration-dry-run-checklist.md) to verify field mapping, user mapping, issue scope, attachment handling, and rollback planning.

If you want a second pass on your plan, you can buy a `$12` manual dry-run review:

[Buy the dry-run review](https://buy.stripe.com/14AeVc4fh04ogx5dvXaMU07)

The review covers sanitized migration plans, configuration alignment, custom-field readiness, and likely dry-run risks. Do not send Jira API tokens, OpenProject API keys, credentials, exported customer data, attachments, private issue descriptions, or production database files.

## Need Professional Help?

Don't want to handle the migration yourself? We offer a complete done-for-you service that includes:

- Managed OpenProject hosting
- Complete Jira migration
- 24/7 technical support
- Secure and reliable infrastructure

Visit [portfolio.elitecoders.co/openproject](https://portfolio.elitecoders.co/openproject) to learn more about our managed OpenProject migration service.

## About

This project was built by [EliteCoders](https://www.elitecoders.co), a software development company specializing in custom software solutions. If you need help with:

- Custom software development
- System integration
- Migration tools and services
- Technical consulting

Please reach out to us at hello@elitecoders.co or visit our website at [www.elitecoders.co](https://www.elitecoders.co).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

Please make sure to update tests as appropriate.

## License

[MIT](LICENSE) - see the [LICENSE](LICENSE) file for details.
