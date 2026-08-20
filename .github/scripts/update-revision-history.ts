import fs from "node:fs/promises";
import path from "node:path";

const token = process.env.GITHUB_TOKEN;
const eventPath = process.env.GITHUB_EVENT_PATH;

if (!token) {
  throw new Error("GITHUB_TOKEN is not set");
}

if (!eventPath) {
  throw new Error("GITHUB_EVENT_PATH is not set");
}

const event = JSON.parse(await fs.readFile(eventPath, "utf8"));

const pullRequest = event.pull_request;

if (!pullRequest?.merged) {
  console.log("Pull request was not merged. Nothing to do.");
  process.exit(0);
}

const owner: string = event.repository.owner.login;
const repo: string = event.repository.name;
const pullNumber: number = pullRequest.number;

console.log(`Processing merged PR #${pullNumber}`);

/**
 * Make an authenticated GitHub API request.
 */
async function github<T>(url: string): Promise<T> {
  const response = await fetch(`https://api.github.com${url}`, {
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

  return response.json() as Promise<T>;
}

type Review = {
  user?: {
    login: string;
  };
  state: string;
};

/**
 * Fetch all reviews for the PR.
 */
async function getAllReviews(): Promise<Review[]> {
  const reviews: Review[] = [];

  for (let page = 1; ; page++) {
    const pageReviews = await github<Review[]>(
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
 * Keep only the latest review from each reviewer.
 */
const latestReviewByUser = new Map<string, Review>();

for (const review of reviews) {
  if (!review.user?.login) {
    continue;
  }

  latestReviewByUser.set(review.user.login, review);
}

const approvers = [...latestReviewByUser.values()]
  .filter((review) => review.state === "APPROVED")
  .map((review) => review.user!.login)
  .sort((a, b) => a.localeCompare(b));

console.log(`Approvers: ${approvers.join(", ") || "(none)"}`);

const approverText = approvers.length
  ? approvers.map((username) => `\`${username}\``).join(", ")
  : "None";

const prLink = `[PR #${pullNumber}](${pullRequest.html_url})`;

const signoff = `${approverText} (${prLink})`;

const date = new Date(pullRequest.merged_at ?? new Date().toISOString())
  .toISOString()
  .slice(0, 10);

const description = String(pullRequest.title)
  .replaceAll("|", "\\|")
  .replaceAll("\n", " ");

/**
 * Recursively find Markdown files under docs/.
 */
async function findMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, {
    withFileTypes: true,
  });

  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await findMarkdownFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
}

const markdownFiles = await findMarkdownFiles("docs");

console.log(`Found ${markdownFiles.length} Markdown files under docs/.`);

/**
 * Update one Markdown document.
 */
async function updateDocument(filePath: string): Promise<boolean> {
  let markdown: string = await fs.readFile(filePath, "utf8");

  const heading = /^## Revision history\s*$/m;
  const headingMatch = heading.exec(markdown);

  if (!headingMatch) {
    console.log(`Skipping ${filePath}: no "## Revision history" section.`);

    return false;
  }

  /**
   * Don't add the same PR twice.
   */
  if (markdown.includes(`PR #${pullNumber}](${pullRequest.html_url})`)) {
    console.log(`Skipping ${filePath}: PR #${pullNumber} already recorded.`);

    return false;
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;

  const afterHeading = markdown.slice(sectionStart);

  /**
   * Find the Markdown table immediately after the heading.
   */
  const tableMatch = afterHeading.match(/^\s*\|[^\n]+\|\s*\n\|[-:| ]+\|\s*\n/);

  if (!tableMatch) {
    console.log(`Skipping ${filePath}: no revision history table.`);

    return false;
  }

  const tableStart = sectionStart + tableMatch.index!;

  const tableHeaderEnd = tableStart + tableMatch[0].length;

  /**
   * Find the highest MAJOR.MINOR version.
   *
   * Examples:
   *
   * 0.1 → 0.2
   * 0.9 → 0.10
   * 1.0 → 1.1
   */
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

  /**
   * A document with no valid version is skipped rather
   * than silently starting at 0.1.
   */
  if (highestMinor === -1) {
    console.log(`Skipping ${filePath}: no valid MAJOR.MINOR version.`);

    return false;
  }

  const revision = `${highestMajor}.${highestMinor + 1}`;

  const newRow = `| ${date} | ${revision} | ${description} | ${signoff} |\n`;

  /**
   * Insert newest revision directly below the table header.
   */
  markdown =
    markdown.slice(0, tableHeaderEnd) + newRow + markdown.slice(tableHeaderEnd);

  await fs.writeFile(filePath, markdown);

  console.log(`Updated ${filePath} → revision ${revision}`);

  return true;
}

/**
 * Update every document that has a revision history table.
 */
let updatedCount = 0;

for (const filePath of markdownFiles) {
  if (await updateDocument(filePath)) {
    updatedCount++;
  }
}

console.log(`Updated ${updatedCount} document(s).`);
