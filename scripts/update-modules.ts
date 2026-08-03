/**
 * Regenerates the `dependencies` block of package.json with every
 * `companion-module-*` repository in the github.com/bitfocus org, pinned to its
 * latest published release. Intended to run nightly so Aikido rescans the newest
 * versions of our open-source modules (and their transitive deps) for supply
 * chain issues.
 *
 * Usage:
 *   GITHUB_TOKEN=<token> bun run scripts/update-modules.ts [--dry-run]
 */

const ORG = "bitfocus";
const PREFIX = "companion-module-";
const CONCURRENCY = 10;
const API = "https://api.github.com";

const DRY_RUN = process.argv.includes("--dry-run");
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

if (!TOKEN) {
  console.warn(
    "⚠️  No GITHUB_TOKEN/GH_TOKEN set — falling back to unauthenticated requests, which will likely hit rate limits for an org this size.",
  );
}

type Repo = {
  name: string;
  archived: boolean;
  fork: boolean;
};

type Release = {
  tag_name: string;
};

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "bitfocus-companion-modules-nightly-scan",
  };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch wrapper that transparently waits out primary and secondary GitHub rate
 * limits and retries transient 5xx errors.
 */
async function ghFetch(url: string, attempt = 0): Promise<Response> {
  const res = await fetch(url, { headers: headers() });

  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const retryAfter = res.headers.get("retry-after");
    const reset = res.headers.get("x-ratelimit-reset");

    let waitMs = 0;
    if (retryAfter) {
      waitMs = Number(retryAfter) * 1000;
    } else if (remaining === "0" && reset) {
      waitMs = Math.max(0, Number(reset) * 1000 - Date.now()) + 1000;
    }

    if (waitMs > 0 && attempt < 5) {
      console.warn(
        `⏳ Rate limited on ${url} — waiting ${Math.ceil(waitMs / 1000)}s (attempt ${attempt + 1})`,
      );
      await sleep(waitMs);
      return ghFetch(url, attempt + 1);
    }
  }

  if (res.status >= 500 && attempt < 5) {
    const waitMs = 1000 * 2 ** attempt;
    console.warn(`⏳ ${res.status} on ${url} — retrying in ${waitMs / 1000}s`);
    await sleep(waitMs);
    return ghFetch(url, attempt + 1);
  }

  return res;
}

async function listCompanionRepos(): Promise<string[]> {
  const repos: string[] = [];
  for (let page = 1; ; page++) {
    const url = `${API}/orgs/${ORG}/repos?per_page=100&page=${page}&type=public&sort=full_name`;
    const res = await ghFetch(url);
    if (!res.ok) {
      throw new Error(`Failed to list repos (page ${page}): ${res.status} ${await res.text()}`);
    }
    const batch = (await res.json()) as Repo[];
    if (batch.length === 0) break;

    for (const repo of batch) {
      if (repo.name.startsWith(PREFIX) && !repo.archived) {
        repos.push(repo.name);
      }
    }
    if (batch.length < 100) break;
  }
  return repos.sort();
}

/** Returns the latest release tag for a repo, or null if it has no release. */
async function latestReleaseTag(repo: string): Promise<string | null> {
  const res = await ghFetch(`${API}/repos/${ORG}/${repo}/releases/latest`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Failed to fetch release for ${repo}: ${res.status} ${await res.text()}`);
  }
  const release = (await res.json()) as Release;
  return release.tag_name ?? null;
}

/** Simple promise pool so we don't fire hundreds of requests at once. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  console.log(`🔎 Listing ${PREFIX}* repos in github.com/${ORG} ...`);
  const repos = await listCompanionRepos();
  console.log(`   Found ${repos.length} matching repositories.`);

  console.log(`🏷️  Resolving latest release for each repo (concurrency ${CONCURRENCY}) ...`);
  const skipped: string[] = [];
  const dependencies: Record<string, string> = {};

  const resolved = await mapPool(repos, CONCURRENCY, async (repo) => ({
    repo,
    tag: await latestReleaseTag(repo),
  }));

  for (const { repo, tag } of resolved) {
    if (tag) {
      dependencies[repo] = `github:${ORG}/${repo}#${tag}`;
    } else {
      skipped.push(repo);
    }
  }

  const sortedDeps: Record<string, string> = {};
  for (const name of Object.keys(dependencies).sort()) {
    sortedDeps[name] = dependencies[name] as string;
  }

  const pkgPath = new URL("../package.json", import.meta.url);
  const pkg = (await Bun.file(pkgPath).json()) as Record<string, unknown> & {
    dependencies?: Record<string, string>;
  };

  // Preserve any non-companion dependencies, replace all companion-module-* ones.
  const preserved: Record<string, string> = {};
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (!name.startsWith(PREFIX)) preserved[name] = spec;
  }
  pkg.dependencies = { ...preserved, ...sortedDeps };

  const output = JSON.stringify(pkg, null, 2) + "\n";

  console.log("\n📊 Summary");
  console.log(`   Matched repos:   ${repos.length}`);
  console.log(`   Pinned (release): ${Object.keys(sortedDeps).length}`);
  console.log(`   Skipped (no release): ${skipped.length}`);
  if (skipped.length > 0) {
    console.log(`   → ${skipped.join(", ")}`);
  }

  if (DRY_RUN) {
    console.log("\n🧪 --dry-run: package.json not written.");
    return;
  }

  await Bun.write(pkgPath, output);
  console.log(`\n✅ Wrote ${Object.keys(sortedDeps).length} dependencies to package.json`);
}

main().catch((err) => {
  console.error("❌ update-modules failed:", err);
  process.exit(1);
});
