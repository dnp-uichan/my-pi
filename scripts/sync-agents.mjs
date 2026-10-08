#!/usr/bin/env node

/**
 * sync-agents.mjs
 *
 * Syncs agent definition files (*.md) from this repo's agents/ directory
 * into ~/.pi/agent/agents/ and removes explicitly retired bundled agents.
 *
 * Default behavior: run at most once per package version by writing a stamp
 * file under ~/.pi/agent/state/. Use --force to bypass the stamp and overwrite
 * existing role instructions while preserving user model assignments.
 *
 * Usage:
 *   node scripts/sync-agents.mjs          # normal run (once per version)
 *   node scripts/sync-agents.mjs --force  # overwrite existing files
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(repoRoot, "agents");
const agentRootDir = process.env.PI_CODING_AGENT_DIR
  ? path.resolve(process.env.PI_CODING_AGENT_DIR)
  : path.join(os.homedir(), ".pi", "agent");
const targetDir = path.join(agentRootDir, "agents");
const stateDir = path.join(agentRootDir, "state");
const stampFile = path.join(stateDir, "sync-agents.json");
const packageJsonPath = path.join(repoRoot, "package.json");
const forceOverwrite = process.argv.includes("--force");
const retiredAgentFiles = ["deepseek-worker.md", "finder.md", "planner.md"];

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const packageVersion = readPackageVersion();

function readStamp() {
  if (!fs.existsSync(stampFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(stampFile, "utf8"));
  } catch {
    return null;
  }
}

function shouldSkipByStamp() {
  if (forceOverwrite) return false;
  const stamp = readStamp();
  return stamp?.version === packageVersion;
}

function writeStamp() {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    stampFile,
    JSON.stringify(
      {
        version: packageVersion,
        syncedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
}

function removeRetiredAgents() {
  for (const file of retiredAgentFiles) {
    const src = path.join(sourceDir, file);
    const dst = path.join(targetDir, file);
    if (!fs.existsSync(src) && fs.existsSync(dst)) {
      fs.rmSync(dst);
      console.log(`  removed   ${file}  (retired)`);
    }
  }
}

function preserveModelAssignment(source, existing) {
  const frontmatter = existing.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const model = frontmatter?.[1].match(/^model:[^\r\n]*$/m)?.[0];
  if (!model) return source;
  return source.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_match, body) => {
    const withoutModel = body.replace(/^model:[^\r\n]*\r?\n?/gm, "").trimEnd();
    return `---\n${withoutModel}\n${model}\n---`;
  });
}

function main() {
  /* Bail out gracefully if source dir does not exist. */
  if (!fs.existsSync(sourceDir)) {
    console.log(`[sync-agents] Source directory not found: ${sourceDir}`);
    console.log("[sync-agents] Skipping agent sync.");
    return;
  }

  removeRetiredAgents();

  if (shouldSkipByStamp()) {
    console.log(
      `[sync-agents] Already synced for version ${packageVersion}. Skipping (use --force to override).`
    );
    return;
  }

  const mdFiles = fs
    .readdirSync(sourceDir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("."));

  if (mdFiles.length === 0) {
    console.log("[sync-agents] No agent .md files found in source. Skipping.");
    return;
  }

  /* Ensure target directory exists. */
  fs.mkdirSync(targetDir, { recursive: true });

  let copied = 0;
  let skipped = 0;

  for (const file of mdFiles) {
    const src = path.join(sourceDir, file);
    const dst = path.join(targetDir, file);
    const existedBefore = fs.existsSync(dst);

    if (existedBefore && fs.realpathSync(src) === fs.realpathSync(dst)) {
      console.log(`  skipped  ${file}  (source and target are identical)`);
      skipped++;
    } else if (existedBefore && !forceOverwrite) {
      console.log(`  skipped  ${file}  (already exists)`);
      skipped++;
    } else {
      const source = fs.readFileSync(src, "utf8");
      const content = existedBefore
        ? preserveModelAssignment(source, fs.readFileSync(dst, "utf8"))
        : source;
      /* Never overwrite the external source of an existing symlink. */
      if (fs.lstatSync(dst, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(dst);
      fs.writeFileSync(dst, content);
      const label = existedBefore ? "overwrote " : "copied    ";
      console.log(`  ${label}${file}`);
      copied++;
    }
  }

  writeStamp();

  console.log(
    `[sync-agents] Done — ${copied} copied, ${skipped} skipped (target: ${targetDir}, version: ${packageVersion})`
  );
}

main();
