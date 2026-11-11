import datetime
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sync", Path(__file__).with_name("sync.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.state = {"base": "a" * 40, "upstream": "b" * 40, "candidate": "c" * 40,
                      "candidate_branch": "automation/test", "controller_sha": "d" * 40,
                      "status": "checking", "queued_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}

    def finish(self, cloud, mac, base=None):
        with patch.object(sync, "head", side_effect=lambda b, **_: self.state["candidate"]
                          if b == "automation/test" else self.state["base"]), \
                patch.object(sync, "cloud_result", return_value=(cloud, None)), \
                patch.object(sync, "mac_result", return_value=mac), \
                patch.object(sync, "repo_api") as api:
            sync.finish_pending(self.state, base or self.state["base"])
            api.assert_not_called()

    def test_mac_offline_leaves_durable_pending(self):
        self.finish("success", "pending")
        self.assertEqual("waiting_macos", self.state["status"])
        self.assertEqual("c" * 40, self.state["candidate"])

    def test_failure_or_pending_never_publishes(self):
        for cloud, mac in [("failure", "success"), ("success", "failure"),
                           ("success", "error"), ("pending", "success")]:
            self.finish(cloud, mac)
            self.assertNotEqual("merged", self.state["status"])

    def test_branch_advance_invalidates_previous_checks(self):
        self.finish("success", "success", base="e" * 40)
        self.assertEqual("stale", self.state["status"])

    def test_success_only_updates_verified_sha_without_force(self):
        candidate = self.state["candidate"]
        with patch.object(sync, "head", side_effect=[candidate, self.state["base"], candidate, candidate]), \
                patch.object(sync, "cloud_result", return_value=("success", None)), \
                patch.object(sync, "mac_result", return_value="success"), \
                patch.object(sync, "ancestor", return_value=True), \
                patch.object(sync, "git"), patch.object(sync, "save_state"), \
                patch.object(sync, "repo_api") as api:
            sync.finish_pending(self.state, self.state["base"])
            api.assert_any_call("git/refs/heads/" + sync.TARGET, method="PATCH",
                                body={"sha": candidate, "force": False})
        self.assertEqual("merged", self.state["status"])

    def test_incomplete_or_skipped_cloud_jobs_do_not_pass(self):
        names = json.loads((sync.ROOT / "expected-jobs.json").read_text())
        run = {"display_title": "Fork checks " + self.state["candidate"] + " base " + self.state["base"],
               "head_sha": self.state["controller_sha"], "id": 1,
               "status": "completed", "conclusion": "success"}
        for jobs in [[{"name": n, "conclusion": "success"} for n in names[:-1]],
                     [{"name": n, "conclusion": "skipped" if i == 0 else "success"}
                      for i, n in enumerate(names)]]:
            with patch.object(sync, "repo_api", side_effect=[{"workflow_runs": [run]},
                              {"total_count": len(jobs), "jobs": jobs}]):
                self.assertEqual("failure", sync.cloud_result(self.state)[0])

    def test_cloud_run_with_wrong_baseline_cannot_pass(self):
        run = {"display_title": "Fork checks " + self.state["candidate"] + " base " + "e" * 40,
               "head_sha": self.state["controller_sha"], "id": 1,
               "status": "completed", "conclusion": "success"}
        with patch.object(sync, "repo_api", return_value={"workflow_runs": [run]}):
            self.assertEqual("pending", sync.cloud_result(self.state)[0])

    def test_all_expected_cloud_jobs_pass(self):
        names = json.loads((sync.ROOT / "expected-jobs.json").read_text())
        run = {"display_title": "Fork checks " + self.state["candidate"] + " base " + self.state["base"],
               "head_sha": self.state["controller_sha"], "id": 1,
               "status": "completed", "conclusion": "success"}
        with patch.object(sync, "repo_api", side_effect=[{"workflow_runs": [run]},
                          {"total_count": len(names), "jobs": [
                              {"name": name, "conclusion": "success"} for name in names]}]):
            self.assertEqual("success", sync.cloud_result(self.state)[0])

    def test_mac_report_must_be_from_owner(self):
        with patch.object(sync, "repo_api", return_value=[{"context": sync.MAC_CONTEXT,
                          "creator": {"login": "some-bot"}, "state": "success"}]):
            self.assertEqual("error", sync.mac_result(self.state["candidate"]))

    def test_real_git_conflict_does_not_publish(self):
        with tempfile.TemporaryDirectory() as folder:
            def git(*args):
                return subprocess.check_output(["git", "-C", folder, *args], text=True).strip()
            git("init", "-q")
            git("config", "user.name", "test")
            git("config", "user.email", "test@example.invalid")
            file = Path(folder) / "same.txt"
            file.write_text("original\n")
            git("add", "same.txt")
            git("commit", "-qm", "initial")
            start = git("rev-parse", "HEAD")
            file.write_text("fork\n")
            git("commit", "-qam", "fork")
            base = git("rev-parse", "HEAD")
            git("checkout", "-q", "--detach", start)
            file.write_text("upstream\n")
            git("commit", "-qam", "upstream")
            upstream = git("rev-parse", "HEAD")
            original = sync.command
            def command(*args, **kwargs):
                return original(args[0], "-C", folder, *args[1:], **kwargs)
            with patch.object(sync, "command", side_effect=command), \
                    patch.object(sync, "repo_api") as api:
                result = sync.queue_candidate(base, upstream)
                self.assertEqual("conflict", result["status"])
                self.assertIn("same.txt", result["conflict_details"])
                api.assert_not_called()


if __name__ == "__main__":
    unittest.main()
