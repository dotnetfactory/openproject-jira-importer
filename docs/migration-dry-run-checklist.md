# OpenProject Jira Migration Dry-Run Checklist

Use this checklist before running a production Jira to OpenProject migration.

## Scope

- Confirm the source Jira project key and target OpenProject project ID.
- Decide whether the first run is a full migration or a small issue subset.
- Pick a small representative sample with comments, attachments, priorities, relationships, and parent-child hierarchy.
- Save the exact commands you plan to run for the dry run.

## Credentials And Access

- Confirm the Jira token can read the selected project, issue fields, comments, attachments, and relationships.
- Confirm the OpenProject API key can create and update work packages in the target project.
- Do not paste Jira tokens, OpenProject API keys, `.env` files, or exported project data into public issues.
- Use a staging OpenProject project for the first dry run when possible.

## Field Mapping

- Create or confirm the OpenProject custom field that stores the original Jira issue ID.
- Set `JIRA_ID_CUSTOM_FIELD` to the correct numeric custom field ID.
- Verify priority and status mapping before importing a large project.
- Document any Jira fields that will not be migrated.

## Users, Comments, Attachments, And Relationships

- Generate and review user mapping before importing comments or watchers.
- Test one issue with attachments before importing a full project.
- Run parent-child hierarchy migration before relationship migration when both are needed.
- Confirm duplicate handling before rerunning a migration.

## Rollback And Cleanup

- Back up any staging OpenProject project before destructive cleanup scripts.
- Test `remove-duplicates.js` only after confirming what counts as duplicate data.
- Test `delete-relationships.js` in staging before using it on a real project.
- Keep console output from the dry run so you can review failures without exposing secrets.

## Paid Dry-Run Review

If you want a manual review of your dry-run plan, use the `$12` checkout link:

https://buy.stripe.com/8x2aEZ9VL6918Cq0Fg8so08

Include only sanitized context such as repo links, staging project notes, redacted command output, field names, and the main blocker. Do not send API tokens, credentials, private issue descriptions, attachments, customer exports, `.env` files, or production database files.
