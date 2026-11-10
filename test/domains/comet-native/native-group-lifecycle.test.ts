import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { runGitCommand } from '../../../platform/process/git.js';
import { runNativeCliDetailed } from '../../../domains/comet-native/native-cli.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/comet-native/native-config.js';
import { readNativeWorkspaceGroupPlan } from '../../../domains/comet-native/native-workspace-group.js';
import { loadOwnedNativeSdkRuntime as loadSourceNativeSdkRuntime } from '../../../domains/comet-native/native-runtime-ownership.js';
import { collectNativeSdkShapeProposal as collectSourceShapeProposal } from '../../../domains/comet-native/native-sdk-application.js';
import { nativeProjectPaths } from '../../../domains/comet-native/native-paths.js';
import { resolveWorkspaceRuntimeLocation } from '../../../platform/paths/workspace-runtime.js';
import { readWorkspaceGroupSession } from '../../../domains/workflow-contract/workspace-group.js';
import { parseNativePortableState } from '../../../domains/comet-native/native-portable-state.js';
import type { NativeWorkspaceGroupDelivery } from '../../../domains/comet-native/native-workspace-group-delivery.js';

let temporary: string;
afterEach(async () => {
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
});

const packageRoot = process.env.COMET_TEST_NATIVE_PACKAGE;
it.each(['source', 'bundle', ...(packageRoot ? ['package'] : [])])(
  'creates two three-repository SDK tasks and delivers only the accepted archived candidate through the public CLI (%s)',
  async (boundary) => {
    const loadOwnedNativeSdkRuntime: typeof loadSourceNativeSdkRuntime =
      boundary === 'package'
        ? (
            await import(
              pathToFileURL(
                path.join(packageRoot!, 'dist/domains/comet-native/native-runtime-ownership.js'),
              ).href
            )
          ).loadOwnedNativeSdkRuntime
        : loadSourceNativeSdkRuntime;
    const collectNativeSdkShapeProposal: typeof collectSourceShapeProposal =
      boundary === 'package'
        ? (
            await import(
              pathToFileURL(
                path.join(packageRoot!, 'dist/domains/comet-native/native-sdk-application.js'),
              ).href
            )
          ).collectNativeSdkShapeProposal
        : collectSourceShapeProposal;
    temporary = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'comet-group-lifecycle-')),
    );
    const coordinator = path.join(temporary, 'project');
    const repositories = ['backend', 'frontend', 'mobile'].map((ref) => ({ path: ref }));
    for (const entry of repositories) {
      const root = path.join(coordinator, entry.path);
      await fs.mkdir(root, { recursive: true });
      runGitCommand(root, ['init', '-b', 'main']);
      runGitCommand(root, ['config', 'user.name', 'Lifecycle Test']);
      runGitCommand(root, ['config', 'user.email', 'lifecycle@example.invalid']);
      runGitCommand(root, ['config', 'core.autocrlf', 'false']);
      await fs.writeFile(path.join(root, 'source.txt'), 'old\n');
      await fs.writeFile(path.join(root, '.gitignore'), '.env\nnode_modules/\n');
      runGitCommand(root, ['add', 'source.txt', '.gitignore']);
      runGitCommand(root, ['commit', '-m', 'initial']);
      await fs.writeFile(path.join(root, '.env'), 'local-fixture-config');
    }
    await writeProjectConfig(coordinator, { ...defaultProjectConfig('docs', 'en'), repositories });
    const sharedSpecs = path.join(coordinator, 'docs/comet/specs');
    await fs.mkdir(path.join(sharedSpecs, 'existing'), { recursive: true });
    await fs.writeFile(
      path.join(sharedSpecs, 'existing/spec.md'),
      '# Existing behavior\nKeep it.\n',
    );
    const command = async (args: string[], cwd?: string) => {
      if (boundary === 'source') return runNativeCliDetailed(args, { invocationCwd: cwd });
      const result = spawnSync(
        process.execPath,
        boundary === 'package'
          ? [path.join(packageRoot!, 'bin/comet.js'), 'native', ...args]
          : args[0] === 'deliver'
            ? [
                path.resolve('assets/skills/comet-native/scripts/comet-native-deliver.mjs'),
                ...args.slice(1),
              ]
            : [
                path.resolve('assets/skills/comet-native/scripts/comet-native-runtime.mjs'),
                ...args,
              ],
        { cwd, encoding: 'utf8', timeout: 90000 },
      );
      if (result.error) throw result.error;
      return {
        output: { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr },
        dispatch: { data: JSON.parse(result.stdout).data },
      };
    };
    const invoke = (...args: string[]) =>
      command([...args, '--project-root', coordinator, '--json']);
    const ok = async (...args: string[]) => {
      const result = await invoke(...args);
      expect(result.output.exitCode, result.output.stdout + result.output.stderr).toBe(0);
      return result.dispatch.data as {
        phase?: string;
        status?: string;
        cancelled?: boolean;
        selected?: string;
        delivery: NativeWorkspaceGroupDelivery;
        next: { commandArgs: string[] };
      };
    };
    const setupFile = path.join(temporary, 'workspace-setup.json');
    await fs.writeFile(
      setupFile,
      JSON.stringify({
        copyFiles: repositories.map((entry) => `${entry.path}/.env`),
        checks: [
          {
            id: 'dependencies',
            name: 'Prepare three local environments',
            executable: process.execPath,
            argv: [
              '-e',
              'const fs=require("node:fs"); for(const r of ["backend","frontend","mobile"]){if(fs.readFileSync(r+"/.env","utf8")!=="local-fixture-config")process.exit(2);fs.mkdirSync(r+"/node_modules",{recursive:true});fs.writeFileSync(r+"/node_modules/ready","ok")}',
            ],
            cwdRef: '.',
            timeoutMs: 10000,
            repeatable: true,
          },
        ],
      }),
    );
    await ok('new', 'feature', '--isolation', 'worktree', '--setup', setupFile);
    await ok('new', 'other', '--isolation', 'worktree');
    expect(
      (await invoke('new', 'compat', '--runtime', 'compat', '--isolation', 'worktree')).output
        .exitCode,
    ).not.toBe(0);
    const plan = (await readNativeWorkspaceGroupPlan(coordinator, 'feature'))!;
    const other = (await readNativeWorkspaceGroupPlan(coordinator, 'other'))!;
    const root = plan.projectRoot;
    expect(await fs.readFile(path.join(root, 'docs/comet/specs/existing/spec.md'), 'utf8')).toBe(
      '# Existing behavior\nKeep it.\n',
    );
    const denied = await invoke('deliver', 'feature');
    expect(denied.output.exitCode).not.toBe(0);
    expect(denied.output.stderr || denied.output.stdout).toContain(
      'Complete acceptance and Archive',
    );
    const paths = await nativeProjectPaths(root, 'docs');
    const change = path.join(paths.changesDir, 'feature');
    await fs.writeFile(
      path.join(change, 'brief.md'),
      `# Outcome
Update the backend and frontend together.
# Scope
Preserve mobile behavior.
## Directory structure
### Modified
- backend/source.txt: update the backend result.
- frontend/source.txt: update the frontend result.
# Non-goals
No deployment.
# Acceptance examples
- Backend and frontend return new while mobile remains old.
# Constraints and invariants
Keep the three repositories independent.
# Decisions
Use one coordinated task.
# Open questions
None.
# Verification expectations
Read all three repositories in one check.
`,
    );
    await fs.mkdir(path.join(change, 'specs', 'feature'), { recursive: true });
    await fs.writeFile(
      path.join(change, 'specs', 'feature', 'spec.md'),
      '# Coordinated result\nBackend and frontend return new while mobile remains old.\n',
    );
    const { runtime } = await loadOwnedNativeSdkRuntime(root, 'feature');
    let run = await runtime.inspect('feature');
    await fs.writeFile(
      path.join(change, 'children.yaml'),
      'schema: comet.native.children.v2\nchildren:\n  - name: child\n    summary: Unsupported group child\n    depends_on: []\n',
    );
    await expect(
      collectNativeSdkShapeProposal({ paths, state: parseNativePortableState(run.state) }),
    ).rejects.toThrow('do not support Supervisor children');
    expect((await runtime.inspect('feature')).revision).toBe(run.revision);
    await fs.unlink(path.join(change, 'children.yaml'));
    // Deterministic host simulation uses normal SDK claims, outcomes and approval decisions.
    // It proves runtime behavior, not a real model's judgment or user acceptance of production work.
    const submitShape = async (receipt: string) => {
      const action = run.actions.at(-1)!;
      const context = { requestId: receipt, projectRoot: root };
      const claimed = await runtime.claim({
        runId: run.runId,
        actionId: action.id,
        attempt: action.attempt,
        inputHash: action.inputHash,
        executorId: 'fixture-host',
        claimToken: receipt,
        context,
      });
      run = await runtime.recordOutcome({
        runId: run.runId,
        context,
        outcome: {
          actionId: action.id,
          attempt: action.attempt,
          inputHash: action.inputHash,
          claimToken: claimed.actions.at(-1)!.claim!.token,
          outcomeId: receipt,
          status: 'succeeded',
          output: await collectNativeSdkShapeProposal({
            paths,
            state: parseNativePortableState(run.state),
          }),
        },
      });
    };
    await submitShape('proposal');
    const wait = run.waits.at(-1)!;
    run = await runtime.resolveWait({
      runId: run.runId,
      waitId: wait.id,
      proposalHash: wait.proposalHash,
      decisionId: 'fixture-shape-approved',
      choice: 'approved',
    });
    await submitShape('revalidate');
    const claimed = await ok('next', 'feature', '--session', 'fixture-builder');
    expect(claimed.phase).toBe('build');
    run = await runtime.inspect('feature');
    for (const entry of plan.repositories.slice(0, 2))
      await fs.writeFile(path.join(entry.worktreeRoot, 'source.txt'), 'new\n');
    const resultFile = path.join(temporary, 'result.json');
    await fs.writeFile(
      path.join(root, 'check.cjs'),
      'const fs=require("node:fs"); for(const r of ["backend","frontend"]) if(fs.readFileSync(r+"/source.txt","utf8")!=="new\\n") process.exit(1); if(fs.readFileSync("mobile/source.txt","utf8")!=="old\\n") process.exit(1); for(const r of ["backend","frontend","mobile"]){if(fs.readFileSync(r+"/.env","utf8")!=="local-fixture-config"||fs.readFileSync(r+"/node_modules/ready","utf8")!=="ok")process.exit(2)}',
    );
    const checks = [
      {
        id: 'combined',
        name: 'Read all three repositories',
        executable: process.execPath,
        argv: ['check.cjs'],
        cwdRef: '.',
        timeoutMs: 10000,
        repeatable: true,
      },
    ];
    await fs.writeFile(
      resultFile,
      JSON.stringify({
        status: 'succeeded',
        output: {
          summary: 'Updated backend and frontend.',
          addressedAcceptanceIds: ['A1'],
          checks: [],
          knownLimits: [],
          verificationChecks: checks,
        },
      }),
    );
    await ok(
      'next',
      'feature',
      '--result',
      resultFile,
      '--action',
      run.actions.at(-1)!.id,
      '--session',
      'fixture-builder',
      '--review',
      'independent',
    );
    run = await runtime.inspect('feature');
    await ok('next', 'feature', '--session', 'fixture-verifier');
    run = await runtime.inspect('feature');
    const state = parseNativePortableState(run.state);
    await fs.writeFile(
      resultFile,
      JSON.stringify({
        status: 'succeeded',
        output: {
          candidateId: state.builder_handoff!.candidate_id,
          verifierExecutionRef: 'fixture-verifier',
          response: {
            kind: 'final-result',
            result: {
              iteration: state.loop.iteration,
              attempt: state.loop.attempt,
              verdict: 'pass',
              acceptance: [
                {
                  id: 'A1',
                  result: 'passed',
                  reason: 'The actual combined check read all three repositories.',
                },
              ],
              risks: [],
              summary: 'Combined behavior passed.',
            },
          },
        },
      }),
    );
    const reported = await ok(
      'next',
      'feature',
      '--result',
      resultFile,
      '--action',
      run.actions.at(-1)!.id,
      '--session',
      'fixture-verifier',
    );
    expect(reported.status).toBe('await-user');
    expect((await invoke('deliver', 'feature')).output.exitCode).not.toBe(0);
    const acceptanceArgs = [...reported.next.commandArgs].slice(2);
    acceptanceArgs[acceptanceArgs.indexOf('--summary') + 1] =
      'Fixture user accepts the verified result.';
    const completed = await command(acceptanceArgs);
    expect(completed.output.exitCode, completed.output.stdout).toBe(0);
    expect((await runtime.inspect('feature')).status).toBe('completed');
    await expect(fs.stat(path.join(sharedSpecs, 'feature/spec.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const mobile = plan.repositories[2];
    await fs.writeFile(
      path.join(mobile.sourceRoot, 'source.txt'),
      'parallel incompatible target\n',
    );
    runGitCommand(mobile.sourceRoot, ['add', 'source.txt']);
    runGitCommand(mobile.sourceRoot, ['commit', '-m', 'parallel target change']);
    const failed = await invoke('deliver', 'feature');
    expect(failed.output.exitCode).toBe(73);
    const failedDelivery = (failed.dispatch.data as { delivery: NativeWorkspaceGroupDelivery })
      .delivery;
    expect(failedDelivery.checkAttempts.at(-1)?.result?.status).toBe('failed');
    await fs.writeFile(path.join(failedDelivery.integrationRoot, 'mobile/source.txt'), 'old\n');
    const uncommitted = await invoke('deliver', 'feature');
    expect(uncommitted.output.exitCode).toBe(73);
    expect(uncommitted.output.stdout + uncommitted.output.stderr).toContain(
      'Integration inputs are not committed',
    );
    expect(
      (uncommitted.dispatch.data as { delivery: NativeWorkspaceGroupDelivery }).delivery
        .checkAttempts,
    ).toEqual(failedDelivery.checkAttempts);
    await fs.writeFile(
      path.join(failedDelivery.integrationRoot, 'mobile/source.txt'),
      'parallel incompatible target\n',
    );
    await fs.writeFile(path.join(mobile.sourceRoot, 'source.txt'), 'old\n');
    runGitCommand(mobile.sourceRoot, ['add', 'source.txt']);
    runGitCommand(mobile.sourceRoot, ['commit', '-m', 'repair parallel target']);
    let ready = (await ok('deliver', 'feature', '--refresh', failedDelivery.id))
      .delivery as NativeWorkspaceGroupDelivery;
    expect(ready.status).toBe('ready');
    expect(ready.checkAttempts.at(-1)?.result?.status).toBe('passed');
    const hookScript =
      boundary === 'package'
        ? path.join(packageRoot!, 'assets/skills/comet/scripts/comet-hook-router.mjs')
        : path.resolve('assets/skills/comet/scripts/comet-hook-router.mjs');
    const integrationCwd = path.join(ready.integrationRoot, 'backend');
    const hook = (target: string) =>
      spawnSync(process.execPath, [hookScript, '--platform', 'codex'], {
        cwd: integrationCwd,
        encoding: 'utf8',
        timeout: 20000,
        input: JSON.stringify({
          cwd: integrationCwd,
          session_id: 'fixture-builder',
          tool_name: 'Edit',
          tool_input: { file_path: target },
        }),
      });
    for (const target of [
      path.join(other.projectRoot, 'frontend/source.txt'),
      path.join(coordinator, 'frontend/source.txt'),
    ]) {
      const denied = hook(target);
      expect(denied.status, denied.stderr).toBe(2);
      expect(denied.stderr).toContain('multiple task workspaces');
    }
    expect(hook(path.join(integrationCwd, 'repair.ts')).status).toBe(0);
    for (const entry of plan.repositories)
      expect(await fs.readFile(path.join(entry.sourceRoot, 'source.txt'), 'utf8')).toBe('old\n');
    await fs.writeFile(path.join(root, 'frontend/source.txt'), 'unaccepted\n');
    expect(
      (await invoke('deliver', 'feature', '--apply', ready.planHash!)).output.exitCode,
    ).not.toBe(0);
    await fs.writeFile(path.join(root, 'frontend/source.txt'), 'new\n');
    const backend = plan.repositories[0].sourceRoot;
    await fs.writeFile(path.join(backend, 'upstream.txt'), 'later target work\n');
    runGitCommand(backend, ['add', 'upstream.txt']);
    runGitCommand(backend, ['commit', '-m', 'upstream']);
    const moved = await invoke('deliver', 'feature', '--apply', ready.planHash!);
    expect(moved.output.exitCode).toBe(73);
    const recovery = moved.dispatch.data as { refresh: { commandArgs: string[] } };
    const refreshed = await command(recovery.refresh.commandArgs.slice(2));
    expect(refreshed.output.exitCode, refreshed.output.stdout).toBe(0);
    const nextDelivery = (refreshed.dispatch.data as { delivery: NativeWorkspaceGroupDelivery })
      .delivery;
    expect(nextDelivery.id).not.toBe(ready.id);
    ready = nextDelivery;
    const frontend = plan.repositories[1];
    const lock = path.join(frontend.commonDir, `refs/heads/${frontend.targetBranch}.lock`);
    await fs.writeFile(lock, 'fixture foreign lock');
    const interrupted = await invoke('deliver', 'feature', '--apply', ready.planHash!);
    expect(interrupted.output.exitCode).toBe(73);
    expect(interrupted.dispatch.data).toMatchObject({
      delivery: { repositories: [{ applied: true }, { applied: false }, { applied: false }] },
    });
    await fs.unlink(lock);
    // Finish the fixture's interrupted ref update before another task advances the target.
    runGitCommand(frontend.sourceRoot, [
      'update-ref',
      `refs/heads/${frontend.targetBranch}`,
      ready.repositories[1].integrationCommit!,
      ready.repositories[1].targetCommit,
    ]);
    runGitCommand(backend, [
      'commit',
      '--allow-empty',
      '-m',
      'another task after partial delivery',
    ]);
    const stalePartial = await invoke('deliver', 'feature', '--apply', ready.planHash!);
    expect(stalePartial.output.exitCode).toBe(73);
    expect(stalePartial.output.stdout + stalePartial.output.stderr).toContain(
      'moved after partial publication',
    );
    const partialRecovery = stalePartial.dispatch.data as { refresh: { commandArgs: string[] } };
    const freshPartial = await command(partialRecovery.refresh.commandArgs.slice(2));
    expect(freshPartial.output.exitCode, freshPartial.output.stdout).toBe(0);
    const freshDelivery = (freshPartial.dispatch.data as { delivery: NativeWorkspaceGroupDelivery })
      .delivery;
    expect(freshDelivery.checkAttempts[0].operationId).not.toBe(ready.checkAttempts[0].operationId);
    ready = freshDelivery;
    const deliveryStatus = await invoke('status', 'feature', '--details');
    expect(deliveryStatus.output.exitCode, deliveryStatus.output.stdout).toBe(0);
    expect(deliveryStatus.dispatch.data).toMatchObject({
      workspace: { delivery: { id: ready.id, status: 'ready' } },
    });
    await fs.mkdir(path.join(sharedSpecs, 'feature'), { recursive: true });
    await fs.writeFile(
      path.join(sharedSpecs, 'feature/spec.md'),
      '# Another task\nPreserve this version.\n',
    );
    const conflicted = await invoke('deliver', 'feature', '--apply', ready.planHash!);
    expect(conflicted.output.exitCode).toBe(73);
    expect(conflicted.dispatch.data).toMatchObject({
      delivery: { status: 'merged' },
      specs: { status: 'blocked' },
    });
    expect(await fs.readFile(path.join(sharedSpecs, 'feature/spec.md'), 'utf8')).toBe(
      '# Another task\nPreserve this version.\n',
    );
    const acceptedSpec = await fs.readFile(
      path.join(root, 'docs/comet/specs/feature/spec.md'),
      'utf8',
    );
    // Simulate the user resolving the shared-document conflict to the accepted text.
    await fs.writeFile(path.join(sharedSpecs, 'feature/spec.md'), acceptedSpec);
    const merged = (await ok('deliver', 'feature', '--apply', ready.planHash!))
      .delivery as NativeWorkspaceGroupDelivery;
    expect(merged.status).toBe('merged');
    expect(await fs.readFile(path.join(backend, 'upstream.txt'), 'utf8')).toBe(
      'later target work\n',
    );
    expect(await fs.readFile(path.join(sharedSpecs, 'existing/spec.md'), 'utf8')).toBe(
      '# Existing behavior\nKeep it.\n',
    );
    await fs.writeFile(
      path.join(sharedSpecs, 'feature/spec.md'),
      '# Later accepted task\nNewer specification.\n',
    );
    expect((await ok('deliver', 'feature', '--apply', ready.planHash!)).delivery).toEqual(merged);
    expect(await fs.readFile(path.join(sharedSpecs, 'feature/spec.md'), 'utf8')).toBe(
      '# Later accepted task\nNewer specification.\n',
    );
    for (const entry of plan.repositories.slice(0, 2))
      expect(await fs.readFile(path.join(entry.sourceRoot, 'source.txt'), 'utf8')).toBe('new\n');
    for (const entry of other.repositories)
      expect(await fs.readFile(path.join(entry.worktreeRoot, 'source.txt'), 'utf8')).toBe('old\n');
    expect((await ok('status', 'other')).phase).toBe('shape');
    expect((await ok('cancel', 'other')).cancelled).toBe(true);
    for (const entry of other.repositories)
      expect(await fs.readFile(path.join(entry.worktreeRoot, 'source.txt'), 'utf8')).toBe('old\n');
    const preview = await ok('deliver', 'feature', '--cleanup');
    expect(preview).toMatchObject({ cleanup: { planHash: ready.planHash } });
    const retainedCleanup = await ok('deliver', 'feature', '--cleanup', '--apply', ready.planHash!);
    expect(JSON.stringify(retainedCleanup)).toContain('Git-ignored local files remain');
    for (const entry of plan.repositories) {
      expect(await fs.readFile(path.join(entry.worktreeRoot, '.env'), 'utf8')).toBe(
        'local-fixture-config',
      );
      await fs.rm(path.join(entry.worktreeRoot, '.env'));
      await fs.rm(path.join(entry.worktreeRoot, 'node_modules'), { recursive: true });
      await fs.rm(path.join(ready.integrationRoot, entry.path, '.env'));
      await fs.rm(path.join(ready.integrationRoot, entry.path, 'node_modules'), {
        recursive: true,
      });
    }
    runGitCommand(plan.repositories[0].worktreeRoot, ['switch', '-c', 'new-unrelated-work']);
    const integrationMobile = path.join(ready.integrationRoot, 'mobile');
    runGitCommand(integrationMobile, ['switch', '-c', 'new-integration-work']);
    const changedBranchCleanup = await ok(
      'deliver',
      'feature',
      '--cleanup',
      '--apply',
      ready.planHash!,
    );
    expect(JSON.stringify(changedBranchCleanup)).toContain('Worktree branch changed');
    expect(
      runGitCommand(plan.repositories[0].worktreeRoot, ['symbolic-ref', '--short', 'HEAD']),
    ).toBe('new-unrelated-work');
    expect(runGitCommand(integrationMobile, ['symbolic-ref', '--short', 'HEAD'])).toBe(
      'new-integration-work',
    );
    runGitCommand(plan.repositories[0].worktreeRoot, ['switch', plan.repositories[0].changeBranch]);
    runGitCommand(integrationMobile, ['switch', '--detach']);
    await fs.writeFile(path.join(root, 'backend/source.txt'), 'keep dirty task\n');
    const cleaned = await ok('deliver', 'feature', '--cleanup', '--apply', ready.planHash!);
    expect(JSON.stringify(cleaned)).toContain('Uncommitted or untracked files remain');
    expect(JSON.stringify(cleaned)).toContain('"key":"task/frontend","root":');
    expect(
      (
        cleaned as unknown as {
          cleanup: { worktrees: Array<{ key: string; status: string; reason?: string }> };
        }
      ).cleanup.worktrees.find((item) => item.key === 'task/frontend'),
      JSON.stringify(cleaned),
    ).toMatchObject({ status: 'removed' });
    await expect(fs.stat(path.join(root, 'frontend'))).rejects.toMatchObject({ code: 'ENOENT' });
    const partialStatus = await command(['status', 'feature', '--details', '--json'], root);
    expect(partialStatus.output.exitCode, partialStatus.output.stdout).toBe(0);
    const partialRetry = await command(
      ['deliver', 'feature', '--cleanup', '--apply', ready.planHash!, '--json'],
      root,
    );
    expect(partialRetry.output.exitCode, partialRetry.output.stdout).toBe(0);
    expect((await command(['next', 'feature', '--json'], root)).output.exitCode).not.toBe(0);
    expect(await fs.readFile(path.join(root, 'backend/source.txt'), 'utf8')).toBe(
      'keep dirty task\n',
    );
    await fs.writeFile(path.join(root, 'backend/source.txt'), 'new\n');
    await ok('deliver', 'feature', '--cleanup', '--apply', ready.planHash!);
    const historical = await ok('status', 'feature', '--details');
    expect(historical).toMatchObject({
      run: { status: 'completed' },
      cleanup: { historical: true },
    });
    const directStatus = await command(['status', 'feature', '--project-root', root, '--json']);
    expect(directStatus.output.exitCode, directStatus.output.stdout).toBe(0);
    const implicitStatus = await command(['status', 'feature', '--details', '--json'], root);
    expect(implicitStatus.output.exitCode, implicitStatus.output.stdout).toBe(0);
    const implicitCleanup = await command(
      ['deliver', 'feature', '--cleanup', '--apply', ready.planHash!, '--json'],
      root,
    );
    expect(implicitCleanup.output.exitCode, implicitCleanup.output.stdout).toBe(0);
    const listing = await invoke('status');
    expect(listing.output.exitCode, listing.output.stdout).toBe(0);
    expect(listing.output.stdout).not.toContain('inspectionError');
    expect((await invoke('next', 'feature')).output.exitCode).not.toBe(0);
    expect(await fs.readFile(path.join(root, 'docs/comet/specs/feature/spec.md'), 'utf8')).toBe(
      acceptedSpec,
    );
    for (const entry of plan.repositories) {
      await expect(fs.stat(entry.worktreeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        runGitCommand(entry.sourceRoot, ['rev-parse', `refs/heads/${entry.changeBranch}`]),
      ).toBeTruthy();
    }
    // Simulate a crash after Git removal but before its completion receipt was written.
    const cleanupFile = path.join(
      resolveWorkspaceRuntimeLocation(root).runtimeRoot,
      'native/group-delivery/cleanup.json',
    );
    const cleanupReceipt = JSON.parse(await fs.readFile(cleanupFile, 'utf8'));
    cleanupReceipt.entries['task/frontend'].removed = false;
    await fs.writeFile(cleanupFile, JSON.stringify(cleanupReceipt));
    await ok('deliver', 'feature', '--cleanup', '--apply', ready.planHash!);
    await ok('new', 'next-task', '--isolation', 'worktree');
    await fs.mkdir(path.join(root, 'frontend'));
    const reused = await invoke('deliver', 'feature', '--cleanup', '--apply', ready.planHash!);
    expect(reused.output.exitCode).not.toBe(0);
    expect(reused.output.stdout + reused.output.stderr).toContain('path was reused');
    expect(
      (await invoke('select', 'next-task', '--session', 'fixture-builder')).output.exitCode,
    ).not.toBe(0);
    await fs.rmdir(path.join(root, 'frontend'));
    await ok('deliver', 'feature', '--cleanup', '--apply', ready.planHash!);
    const validCleanup = await fs.readFile(cleanupFile, 'utf8');
    await fs.writeFile(
      cleanupFile,
      JSON.stringify({ ...JSON.parse(validCleanup), runHash: '0'.repeat(64) }),
    );
    expect(
      (await invoke('select', 'next-task', '--session', 'fixture-builder')).output.exitCode,
    ).not.toBe(0);
    await fs.writeFile(cleanupFile, validCleanup);
    runGitCommand(frontend.sourceRoot, [
      'worktree',
      'add',
      '--no-checkout',
      frontend.worktreeRoot,
      frontend.changeBranch,
    ]);
    await fs.rm(frontend.worktreeRoot, { recursive: true });
    const registered = await invoke('select', 'next-task', '--session', 'fixture-builder');
    expect(registered.output.exitCode).not.toBe(0);
    expect(registered.output.stdout + registered.output.stderr).toContain('was reused');
    runGitCommand(frontend.sourceRoot, ['worktree', 'prune', '--expire', 'now']);
    const switched = await ok('select', 'next-task', '--session', 'fixture-builder');
    expect(switched.selected).toBe('next-task');
    expect((await readWorkspaceGroupSession(coordinator, 'fixture-builder'))?.name).toBe(
      'next-task',
    );
    const unapproved = await invoke('next', 'next-task', '--session', 'fixture-builder');
    expect(unapproved.output.exitCode).toBe(64);
    expect(unapproved.output.stdout + unapproved.output.stderr).toContain('Shape');
  },
  // Windows CI 的完整三仓流程已超过 180 秒，保留全部交付与恢复断言。
  process.platform === 'win32' ? 600_000 : 180_000,
);
