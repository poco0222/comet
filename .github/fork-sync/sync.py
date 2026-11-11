"""Queue upstream merges on GitHub; publish only after cloud and Mac checks."""
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import quote

REPO = "poco0222/comet"
UPSTREAM = "rpamis/comet"
TARGET = "feat/native-multi-repo-workspace"
STATE_BRANCH = "automation/upstream-state"
CI_WORKFLOW = "fork-ci.yml"
MAC_CONTEXT = "fork-sync/macos"
ROOT = Path(__file__).resolve().parent


def command(*args, check=True, input=None):
    return subprocess.run(args, input=input, text=True, capture_output=True, check=check)


def git(*args):
    return command("git", *args).stdout.strip()


def api(path, method="GET", body=None, missing=False):
    args = ["gh", "api", path, "--method", method]
    if body is not None:
        args += ["--input", "-"]
    result = command(*args, input=json.dumps(body) if body is not None else None, check=False)
    if result.returncode:
        if missing and "HTTP 404" in result.stderr:
            return None
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else None


def repo_api(path, **kwargs):
    return api(f"repos/{REPO}/{path}", **kwargs)


def head(branch, missing=False):
    ref = repo_api("git/ref/heads/" + branch, missing=missing)
    return ref["object"]["sha"] if ref else None


def load_state():
    result = repo_api("contents/state.json?ref=" + quote(STATE_BRANCH, safe=""), missing=True)
    return json.loads(base64.b64decode(result["content"])) if result else {}


def save_state(state):
    if head(STATE_BRANCH, missing=True) is None:
        repo_api("git/refs", method="POST", body={"ref": "refs/heads/" + STATE_BRANCH,
                                                   "sha": git("rev-parse", "HEAD")})
    current = repo_api("contents/state.json?ref=" + quote(STATE_BRANCH, safe=""), missing=True)
    content = json.dumps(state, indent=2, ensure_ascii=False) + "\n"
    if current and base64.b64decode(current["content"]).decode() == content:
        return
    body = {"branch": STATE_BRANCH, "message": "ci: 记录上游同步状态 [skip ci]",
            "content": base64.b64encode(content.encode()).decode()}
    if current:
        body["sha"] = current["sha"]
    repo_api("contents/state.json", method="PUT", body=body)


def ancestor(before, after):
    return command("git", "merge-base", "--is-ancestor", before, after, check=False).returncode == 0


def ci_supported(candidate):
    source = command("git", "show", candidate + ":.github/workflows/ci.yml").stdout
    expected = (ROOT / "ci-source.sha256").read_text().strip()
    return hashlib.sha256(source.encode()).hexdigest() == expected


def cloud_result(state):
    runs = repo_api(f"actions/workflows/{CI_WORKFLOW}/runs?event=workflow_dispatch&per_page=100")
    matches = [r for r in runs["workflow_runs"]
               if r["display_title"] == "Fork checks " + state["candidate"] + " base " + state["base"]]
    if not matches:
        queued = datetime.datetime.fromisoformat(state["queued_at"])
        if datetime.datetime.now(datetime.timezone.utc) - queued > datetime.timedelta(minutes=30):
            return "failure", None
        return "pending", None
    run = matches[0]
    if run["head_sha"] != state["controller_sha"]:
        return "failure", run
    if run["status"] != "completed":
        return "pending", run
    if run["conclusion"] != "success":
        return "failure", run
    jobs = repo_api(f"actions/runs/{run['id']}/jobs?filter=latest&per_page=100")
    expected = json.loads((ROOT / "expected-jobs.json").read_text())
    actual = [j["name"] for j in jobs["jobs"]]
    ok = (jobs["total_count"] == len(expected) and sorted(actual) == sorted(expected)
          and all(j["conclusion"] == "success" for j in jobs["jobs"]))
    return ("success" if ok else "failure"), run


def mac_result(candidate):
    statuses = repo_api(f"commits/{candidate}/statuses?per_page=100")
    result = next((s for s in statuses if s["context"] == MAC_CONTEXT), None)
    if not result:
        return "pending"
    if result["creator"]["login"] != "poco0222":
        return "error"
    return result["state"]


def finish_pending(state, base):
    if base != state["base"]:
        state.update(status="stale", reason="功能分支已前进，旧检查不能用于新的合并。")
        return
    if head(state["candidate_branch"], missing=True) != state["candidate"]:
        state.update(status="blocked", reason="候选分支丢失或已变化。")
        return
    cloud, run = cloud_result(state)
    mac = mac_result(state["candidate"])
    state.update(cloud=cloud, macos=mac)
    if run:
        state.update(ci_run_id=run["id"], ci_url=run["html_url"])
    if cloud == "failure" or mac in ("failure", "error"):
        state.update(status="failed", reason="检查失败，正式分支未改动。")
        return
    if cloud != "success" or mac != "success":
        state.update(status="waiting_macos" if cloud == "success" else "checking")
        return
    git("fetch", "--no-tags", "origin", state["candidate_branch"])
    if not all(ancestor(ref, state["candidate"]) for ref in (state["base"], state["upstream"])):
        raise RuntimeError("候选未包含双方历史，拒绝合入。")
    if head(TARGET) != state["base"]:
        state.update(status="stale", reason="合入前功能分支已前进。")
        return
    repo_api("git/refs/heads/" + TARGET, method="PATCH",
             body={"sha": state["candidate"], "force": False})
    if head(TARGET) != state["candidate"]:
        raise RuntimeError("合入后远端提交与已验收候选不一致。")
    state.update(status="merged", reason="云端与本机 macOS 检查通过，已自动合入。")
    save_state(state)
    if head(state["candidate_branch"], missing=True) == state["candidate"]:
        repo_api("git/refs/heads/" + state["candidate_branch"], method="DELETE")


def queue_candidate(base, upstream):
    state = {"base": base, "upstream": upstream, "target_branch": TARGET,
             "controller_sha": git("rev-parse", "HEAD")}
    merged = command("git", "merge-tree", "--write-tree", "--name-only", base, upstream, check=False)
    if merged.returncode == 1:
        state.update(status="conflict", reason="上游合并冲突，正式分支未改动。",
                     conflict_details=merged.stdout[:12000])
        return state
    if merged.returncode:
        raise RuntimeError(merged.stderr)
    tree = merged.stdout.splitlines()[0]
    branch = "automation/upstream-" + base[:12] + "-" + upstream[:12]
    candidate = head(branch, missing=True)
    if candidate:
        git("fetch", "--no-tags", "origin", branch)
        if git("show", "-s", "--format=%T %P", candidate) != f"{tree} {base} {upstream}":
            raise RuntimeError("已有同名分支不属于本次候选，拒绝覆盖。")
    else:
        candidate = git("commit-tree", tree, "-p", base, "-p", upstream,
                        "-m", "chore: 合并官方上游更新 " + upstream[:12])
    state.update(candidate=candidate, candidate_branch=branch)
    if not ci_supported(candidate):
        state.update(status="blocked", reason="上游 CI 清单已变化，需更新云端与本机验证映射。")
        return state
    git("push", "origin", candidate + ":refs/heads/" + branch)
    state.update(status="dispatching", cloud="pending", macos="pending",
                 queued_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
    save_state(state)
    repo_api(f"actions/workflows/{CI_WORKFLOW}/dispatches", method="POST",
             body={"ref": "master", "inputs": {"candidate": candidate, "base": base}})
    state["status"] = "checking"
    return state


def main():
    if os.environ.get("GITHUB_REPOSITORY") != REPO:
        raise RuntimeError("该工作流仅允许在指定 fork 运行。")
    old = load_state()
    base = head(TARGET)
    upstream = api(f"repos/{UPSTREAM}/git/ref/heads/master")["object"]["sha"]
    if not all(re.fullmatch(r"[0-9a-f]{40}", value) for value in (base, upstream)):
        raise RuntimeError("远端返回了无效的提交 SHA。")
    git("fetch", "--no-tags", "origin", TARGET)
    git("fetch", "--no-tags", "https://github.com/" + UPSTREAM + ".git", "master")
    if old.get("status") in ("dispatching", "checking", "waiting_macos", "failed"):
        state = dict(old)
        if base == state["candidate"]:
            cloud, _ = cloud_result(state)
            mac = mac_result(state["candidate"])
            if cloud == "success" and mac == "success":
                state.update(status="merged", reason="远端已是已验证候选；恢复合入回执。")
            else:
                state.update(status="externally_advanced", reason="分支已被外部更新到候选，但检查尚未全部通过。")
        else:
            finish_pending(state, base)
    elif ancestor(upstream, base):
        state = old if old.get("status") == "merged" and old.get("candidate") == base else {
            "status": "up_to_date", "base": base, "upstream": upstream, "target_branch": TARGET}
    elif old.get("base") == base and old.get("upstream") == upstream and (
            old.get("status") == "conflict" or old.get("status") == "blocked"
            and old.get("controller_sha") == git("rev-parse", "HEAD")):
        state = old
    else:
        state = queue_candidate(base, upstream)
    save_state(state)
    summary = "```json\n" + json.dumps(state, indent=2, ensure_ascii=False) + "\n```\n"
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
            output.write(summary)
    print(summary)
    if state.get("status") in ("conflict", "failed", "blocked") and state != old:
        sys.exit(1)


if __name__ == "__main__":
    main()
