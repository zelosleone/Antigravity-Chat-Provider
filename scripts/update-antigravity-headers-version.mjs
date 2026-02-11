import {readFile, writeFile} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';

const CHANGELOG_URL = 'https://antigravity.google/changelog';
const CONSTANTS_PATH = 'src/antigravity/constants.ts';

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    return;
  }
  appendFileSync(outputFile, `${name}=${value}\n`);
}

function compareSemver(a, b) {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);

  for (let i = 0; i < 3; i += 1) {
    const left = aParts[i] ?? 0;
    const right = bParts[i] ?? 0;
    if (left > right) {
      return 1;
    }
    if (left < right) {
      return -1;
    }
  }

  return 0;
}

function maxSemver(versions) {
  return versions.reduce((best, current) =>
    compareSemver(current, best) > 0 ? current : best,
  );
}

function extractMainBundlePath(html) {
  const mainMatch = html.match(
    /<script[^>]+src="([^"]*main-[^"]+\.js)"[^>]*type="module"[^>]*>/i,
  );
  if (!mainMatch) {
    throw new Error('Unable to find main bundle path in changelog HTML');
  }

  return mainMatch[1];
}

function extractVersionsFromBundle(bundle) {
  const versions = new Set();
  const stableVersionPattern = /antigravity\/stable\/(\d+\.\d+\.\d+)-\d+\//g;

  for (const match of bundle.matchAll(stableVersionPattern)) {
    versions.add(match[1]);
  }

  return Array.from(versions);
}

function extractCurrentVersion(constantsText) {
  const currentMatch = constantsText.match(
    /('User-Agent':\s*'antigravity\/)(\d+\.\d+\.\d+)(\s+windows\/amd64')/,
  );
  if (!currentMatch) {
    throw new Error(
      'Unable to find ANTIGRAVITY_HEADERS User-Agent version in constants file',
    );
  }

  return {
    prefix: currentMatch[1],
    version: currentMatch[2],
    suffix: currentMatch[3],
  };
}

function updateConstantsVersion(constantsText, prefix, nextVersion, suffix) {
  return constantsText.replace(
    /'User-Agent':\s*'antigravity\/\d+\.\d+\.\d+\s+windows\/amd64'/,
    `${prefix}${nextVersion}${suffix}`,
  );
}

async function fetchText(url) {
  const response = await fetch(url, {redirect: 'follow'});
  if (!response.ok) {
    throw new Error(`Request failed for ${url} (${response.status})`);
  }
  return response.text();
}

async function main() {
  const changelogHtml = await fetchText(CHANGELOG_URL);
  const mainBundlePath = extractMainBundlePath(changelogHtml);
  const mainBundleUrl = new URL(mainBundlePath, CHANGELOG_URL).toString();
  const mainBundleText = await fetchText(mainBundleUrl);

  const discoveredVersions = extractVersionsFromBundle(mainBundleText);
  if (discoveredVersions.length === 0) {
    throw new Error('Unable to extract stable versions from changelog bundle');
  }

  const latestVersion = maxSemver(discoveredVersions);
  const constantsText = await readFile(CONSTANTS_PATH, 'utf8');
  const {prefix, version: currentVersion, suffix} =
    extractCurrentVersion(constantsText);

  setOutput('current_version', currentVersion);
  setOutput('latest_version', latestVersion);

  if (compareSemver(latestVersion, currentVersion) <= 0) {
    setOutput('changed', 'false');
    console.log(
      `No update required. Current version (${currentVersion}) is up to date.`,
    );
    return;
  }

  const nextConstantsText = updateConstantsVersion(
    constantsText,
    prefix,
    latestVersion,
    suffix,
  );
  await writeFile(CONSTANTS_PATH, nextConstantsText, 'utf8');

  setOutput('changed', 'true');
  console.log(
    `Updated ANTIGRAVITY_HEADERS User-Agent version: ${currentVersion} -> ${latestVersion}`,
  );
}

main().catch(error => {
  setOutput('changed', 'false');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
