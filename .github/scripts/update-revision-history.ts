import fs from "node:fs/promises";

const token = process.env.GITHUB_TOKEN;
const eventPath = process.env.GITHUB_EVENT_PATH;
const filePath = process.env.REVISION_HISTORY_FILE;

if (!token) {
  throw new Error("GITHUB_TOKEN is not set");
}

if (!eventPath) {
  throw new Error("GITHUB_EVENT_PATH is not set");
}

if (!filePath) {
  throw new Error("REVISION_HISTORY_FILE is not set");
}

const event = JSON.parse(await fs.readFile(eventPath, "utf8"));

const pullRequest = event.pull_request;

if (!pullRequest?.merged) {
  console.log("Pull request was not merged. Nothing to do.");
  process.exit(0);
}

const owner = event.repository.owner.login;
const repo = event.repository.name;
const pullNumber = pullRequest.number;

console.log(`Processing merged PR #${pullNumber}`);

/**
 * Make an authenticated GitHub API request.
 */
async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(`GitHub API request failed (${response.status}): ${body}`);
  }

  return response.json();
}

/**
 * Fetch all reviews for the PR.
 *
 * GitHub returns at most 100 per page, so paginate until
 * there are no more results.
 */
async function getAllReviews() {
  const reviews = [];

  for (let page = 1; ; page++) {
    const pageReviews = await github(
      `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews?per_page=100&page=${page}`,
    );

    reviews.push(...pageReviews);

    if (pageReviews.length < 100) {
      break;
    }
  }

  return reviews;
}

const reviews = await getAllReviews();

console.log(`Found ${reviews.length} reviews.`);

/**
 * Keep only the latest review from each user.
 *
 * For example:
 *
 * Alice: APPROVED
 * Bob:   CHANGES_REQUESTED
 * Alice: COMMENTED
 *
 * means Alice is currently COMMENTED, so neither Alice nor Bob
 * is considered an approver.
 */
const latestReviewByUser = new Map();

for (const review of reviews) {
  if (!review.user?.login) {
    continue;
  }

  latestReviewByUser.set(review.user.login, review);
}

const approvers = [...latestReviewByUser.values()]
  .filter((review) => review.state === "APPROVED")
  .map((review) => review.user.login)
  .sort((a, b) => a.localeCompare(b));

console.log(`Approvers: ${approvers.join(", ") || "(none)"}`);

/**
 * Create the approval text.
 *
 * Example:
 *
 * `alice`, `bob` ([PR #123](https://github.com/acme/project/pull/123))
 */
const approverText = approvers.length
  ? approvers.map((username) => `\`${username}\``).join(", ")
  : "None";

const prLink = `[PR #${pullNumber}](${pullRequest.html_url})`;

const signoff = `${approverText} (${prLink})`;

/**
 * Use the merge date rather than the workflow execution date.
 */
const date = new Date(pullRequest.merged_at ?? new Date().toISOString())
  .toISOString()
  .slice(0, 10);

/**
 * Use the PR title as the revision description.
 *
 * Escape pipes so a PR title cannot break the Markdown table.
 */
const description = pullRequest.title
  .replaceAll("|", "\\|")
  .replaceAll("\n", " ");

/**
 * Read the document.
 */
let markdown = await fs.readFile(filePath, "utf8");

/**
 * Avoid adding the same PR twice.
 *
 * This also makes the script safe to run manually.
 */
if (markdown.includes(`PR #${pullNumber}](${pullRequest.html_url})`)) {
  console.log(`PR #${pullNumber} is already present in revision history.`);

  process.exit(0);
}

/**
 * Find the revision history section.
 */
const heading = /^## Revision history\s*$/m;
const headingMatch = heading.exec(markdown);

if (!headingMatch) {
  throw new Error(`Could not find "## Revision history" in ${filePath}`);
}

const sectionStart = headingMatch.index + headingMatch[0].length;

/**
 * Find the first Markdown table after the heading.
 *
 * Expected format:
 *
 * | Date | Revision | Description | Approved by |
 * |------|----------|-------------|-------------|
 */
const afterHeading = markdown.slice(sectionStart);

const tableMatch = afterHeading.match(/^\s*\|[^\n]+\|\s*\n\|[-:| ]+\|\s*\n/);

if (!tableMatch) {
  throw new Error(
    `Could not find a revision history Markdown table after "## Revision history".`,
  );
}

/**
 * Determine the next revision number.
 *
 * Versions use MAJOR.MINOR.
 *
 * Examples:
 *
 * 0.1 → 0.2
 * 0.9 → 0.10
 * 1.0 → 1.1
 * 2.7 → 2.8
 *
 * Major versions are bumped manually.
 */
const tableStart = sectionStart + tableMatch.index;
const tableHeaderEnd = tableStart + tableMatch[0].length;

const restOfDocument = markdown.slice(tableHeaderEnd);

const rows = restOfDocument.split("\n");

let highestMajor = 0;
let highestMinor = -1;

for (const row of rows) {
  if (!row.trim().startsWith("|")) {
    break;
  }

  const columns = row
    .split("|")
    .slice(1, -1)
    .map((column) => column.trim());

  if (columns.length < 2) {
    continue;
  }

  const match = columns[1].match(/^(\d+)\.(\d+)$/);

  if (!match) {
    continue;
  }

  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);

  if (
    major > highestMajor ||
    (major === highestMajor && minor > highestMinor)
  ) {
    highestMajor = major;
    highestMinor = minor;
  }
}

if (highestMinor === -1) {
  throw new Error(
    "Could not find a valid MAJOR.MINOR version in the revision history.",
  );
}

const revision = `${highestMajor}.${highestMinor + 1}`;

/**
 * Insert the newest revision immediately after the table header.
 */
const newRow = `| ${date} | ${revision} | ${description} | ${signoff} |\n`;

markdown =
  markdown.slice(0, tableHeaderEnd) + newRow + markdown.slice(tableHeaderEnd);

await fs.writeFile(filePath, markdown);

console.log(`Added revision ${revision}:`);
console.log(newRow);
