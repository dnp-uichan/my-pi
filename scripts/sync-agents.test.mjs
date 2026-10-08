import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const worker = "---\nname: worker\nthinking: high\n---\nUpdated worker instructions.\n";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "my-pi-agent-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repo, "agents"));
  fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
  fs.copyFileSync(new URL("./sync-agents.mjs", import.meta.url), path.join(repo, "scripts/sync-agents.mjs"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ version: "1.0.0" }));
  fs.writeFileSync(path.join(repo, "agents/worker.md"), worker);
  fs.writeFileSync(path.join(repo, "agents/simplifier.md"), worker.replace("worker", "simplifier"));
  return {
    root,
    repo,
    agentDir,
    target: path.join(agentDir, "agents/worker.md"),
    run() {
      const result = spawnSync(process.execPath, [path.join(repo, "scripts/sync-agents.mjs"), "--force"], {
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    },
  };
}

test("신규 에이전트는 모델을 강제하지 않고 지정한 설치 경로에 복사된다", (t) => {
  /* Given */
  const f = fixture(t);
  /* When */
  f.run();
  /* Then */
  assert.equal(fs.readFileSync(f.target, "utf8"), worker);
  assert.ok(fs.existsSync(path.join(f.agentDir, "state/sync-agents.json")));
});

test("강제 동기화해도 사용자가 지정한 모델은 유지된다", (t) => {
  /* Given */
  const f = fixture(t);
  fs.writeFileSync(f.target, "---\nname: worker\nmodel: custom/user-selected\n---\nOld instructions.\n");
  /* When */
  f.run();
  /* Then */
  const result = fs.readFileSync(f.target, "utf8");
  assert.match(result, /^model: custom\/user-selected$/m);
  assert.match(result, /Updated worker instructions/);
  assert.doesNotMatch(result, /Old instructions/);
});

test("기존 심볼릭 링크의 원본 파일은 변경하지 않는다", (t) => {
  /* Given */
  const f = fixture(t);
  const original = path.join(f.root, "original.md");
  const content = "---\nname: worker\nmodel: custom/user-selected\n---\nOriginal instructions.\n";
  fs.writeFileSync(original, content);
  fs.symlinkSync(original, f.target);
  /* When */
  f.run();
  /* Then */
  assert.equal(fs.readFileSync(original, "utf8"), content);
  assert.equal(fs.lstatSync(f.target).isSymbolicLink(), false);
  assert.match(fs.readFileSync(f.target, "utf8"), /^model: custom\/user-selected$/m);
});

test("퇴역 에이전트만 제거하고 simplifier와 개인 에이전트는 유지한다", (t) => {
  /* Given */
  const f = fixture(t);
  const dir = path.dirname(f.target);
  for (const name of ["finder", "planner", "deepseek-worker", "personal-worker"]) {
    fs.writeFileSync(path.join(dir, `${name}.md`), name);
  }
  /* When */
  f.run();
  /* Then */
  for (const name of ["finder", "planner", "deepseek-worker"]) {
    assert.equal(fs.existsSync(path.join(dir, `${name}.md`)), false);
  }
  assert.ok(fs.existsSync(path.join(dir, "simplifier.md")));
  assert.equal(fs.readFileSync(path.join(dir, "personal-worker.md"), "utf8"), "personal-worker");
});

test("설치 경로가 원본을 가리켜도 원본을 덮어쓰지 않는다", (t) => {
  /* Given */
  const f = fixture(t);
  fs.symlinkSync(path.join(f.repo, "agents/worker.md"), f.target);
  /* When */
  f.run();
  /* Then */
  assert.equal(fs.lstatSync(f.target).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(f.target, "utf8"), worker);
});
