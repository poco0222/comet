import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGitCommand } from '../../../platform/process/git.js';
import {
  createNativeWorkspaceGroup,
  planNativeWorkspaceGroup,
  type NativeWorkspaceGroup,
} from '../../../domains/comet-native/native-workspace-group.js';
import {
  applyNativeWorkspaceGroupDelivery,
  prepareNativeWorkspaceGroupDelivery,
  inspectNativeWorkspaceGroupDelivery,
} from '../../../domains/comet-native/native-workspace-group-delivery.js';
import type { NativeCheckPlan } from '../../../domains/comet-native/native-check-executor.js';
import { nativeProjectPaths } from '../../../domains/comet-native/native-paths.js';
import {
  initializeNativeWorkspaceGroupSpecs,
  publishNativeWorkspaceGroupSpecs,
} from '../../../domains/comet-native/native-workspace-group-specs.js';

describe('Native workspace group Git delivery', () => {
  let temporary: string, group: NativeWorkspaceGroup;
  const checks: NativeCheckPlan[] = [
    {
      id: 'combined',
      name: 'Verify all three integration repositories',
      executable: process.execPath,
      argv: [
        '-e',
        'const fs=require("node:fs"); for(const r of ["backend","frontend"]) if(fs.readFileSync(r+"/source.txt","utf8")!=="new\\n") process.exit(1); if(fs.readFileSync("mobile/source.txt","utf8")!=="old\\n") process.exit(1);',
      ],
      cwdRef: '.',
      timeoutMs: 10000,
      repeatable: true,
    },
  ];
  const prepare = (refreshDeliveryId?: string) =>
    prepareNativeWorkspaceGroupDelivery({
      group,
      candidateId: 'accepted-candidate',
      commitMessage: 'feat: multi repository task',
      checks,
      refreshDeliveryId,
    });

  beforeEach(async () => {
    temporary = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'comet-group-delivery-')),
    );
    const coordinator = path.join(temporary, 'project');
    const repositories = ['backend', 'frontend', 'mobile'].map((ref) => ({ path: ref }));
    for (const entry of repositories) {
      const root = path.join(coordinator, entry.path);
      await fs.mkdir(root, { recursive: true });
      runGitCommand(root, ['init', '-b', entry.path === 'mobile' ? 'main' : 'master']);
      runGitCommand(root, ['config', 'user.name', 'Delivery Test']);
      runGitCommand(root, ['config', 'user.email', 'delivery@example.invalid']);
      await fs.writeFile(path.join(root, 'source.txt'), 'old\n');
      runGitCommand(root, ['add', 'source.txt']);
      runGitCommand(root, ['commit', '-m', 'initial']);
    }
    group = await createNativeWorkspaceGroup(
      await planNativeWorkspaceGroup({ projectRoot: coordinator, name: 'delivery', repositories }),
    );
    for (const entry of group.plan.repositories.slice(0, 2))
      await fs.writeFile(path.join(entry.worktreeRoot, 'source.txt'), 'new\n');
  });
  afterEach(async () => {
    await fs.rm(temporary, { recursive: true, force: true });
  });

  it('checks combined merged trees before updating targets and does not commit unchanged repositories', async () => {
    const frontend = group.plan.repositories[1];
    await fs.writeFile(path.join(frontend.sourceRoot, 'upstream.txt'), 'new target work\n');
    runGitCommand(frontend.sourceRoot, ['add', 'upstream.txt']);
    runGitCommand(frontend.sourceRoot, ['commit', '-m', 'upstream']);
    const ready = await prepare();
    expect(ready.status).toBe('ready');
    expect(ready.checkAttempts.at(-1)?.result?.status).toBe('passed');
    expect(
      await fs.readFile(path.join(ready.integrationRoot, 'frontend/upstream.txt'), 'utf8'),
    ).toBe('new target work\n');
    for (const entry of group.plan.repositories)
      expect(await fs.readFile(path.join(entry.sourceRoot, 'source.txt'), 'utf8')).toBe('old\n');
    const merged = await applyNativeWorkspaceGroupDelivery(group, ready.planHash!);
    expect(merged.status).toBe('merged');
    expect(merged.repositories.every((entry) => entry.applied)).toBe(true);
    for (const entry of group.plan.repositories.slice(0, 2))
      expect(await fs.readFile(path.join(entry.sourceRoot, 'source.txt'), 'utf8')).toBe('new\n');
    const mobile = group.plan.repositories[2];
    expect(runGitCommand(mobile.sourceRoot, ['rev-parse', 'HEAD'])).toBe(mobile.baseCommit);
    expect(runGitCommand(mobile.worktreeRoot, ['rev-parse', 'HEAD'])).toBe(mobile.baseCommit);
    expect(await applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).toEqual(merged);
    expect((await prepare()).checkAttempts).toHaveLength(1);
  });

  it('rejects uncommitted integration repairs before retrying failed checks or publishing old commits', async () => {
    const mobile = group.plan.repositories[2];
    await fs.writeFile(path.join(mobile.sourceRoot, 'source.txt'), 'incompatible target\n');
    runGitCommand(mobile.sourceRoot, ['add', 'source.txt']);
    runGitCommand(mobile.sourceRoot, ['commit', '-m', 'parallel task']);
    await expect(prepare()).rejects.toThrow('Integration check failed');
    const failed = (await inspectNativeWorkspaceGroupDelivery(group))!;
    const integration = path.join(failed.integrationRoot, 'mobile');
    await fs.writeFile(path.join(integration, 'source.txt'), 'old\n');
    await expect(prepare()).rejects.toThrow('Integration inputs are not committed');
    runGitCommand(integration, ['add', 'source.txt']);
    await expect(prepare()).rejects.toThrow('Integration inputs are not committed');
    runGitCommand(integration, ['restore', '--staged', '--worktree', 'source.txt']);
    await fs.writeFile(path.join(integration, 'unpublished.ts'), 'unpublished implementation');
    await expect(prepare()).rejects.toThrow('Integration inputs are not committed');
    await fs.unlink(path.join(integration, 'unpublished.ts'));
    expect((await inspectNativeWorkspaceGroupDelivery(group))!.checkAttempts).toEqual(
      failed.checkAttempts,
    );
    await fs.writeFile(path.join(mobile.sourceRoot, 'source.txt'), 'old\n');
    runGitCommand(mobile.sourceRoot, ['add', 'source.txt']);
    runGitCommand(mobile.sourceRoot, ['commit', '-m', 'repair target contract']);
    const ready = await prepare(failed.id);
    expect(ready.checkAttempts[0].result?.status).toBe('passed');
    expect((await applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).status).toBe('merged');
    expect(await fs.readFile(path.join(mobile.sourceRoot, 'source.txt'), 'utf8')).toBe('old\n');
  });

  it('preserves dirty original work and refuses all target updates until it is resolved', async () => {
    const entry = group.plan.repositories[1];
    await fs.writeFile(path.join(entry.sourceRoot, 'source.txt'), 'unrelated original work\n');
    const ready = await prepare();
    await expect(applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).rejects.toThrow(
      'target is dirty',
    );
    expect(await fs.readFile(path.join(entry.sourceRoot, 'source.txt'), 'utf8')).toBe(
      'unrelated original work\n',
    );
    expect(runGitCommand(group.plan.repositories[0].sourceRoot, ['rev-parse', 'HEAD'])).toBe(
      group.plan.repositories[0].baseCommit,
    );
    await fs.writeFile(path.join(entry.sourceRoot, 'source.txt'), 'old\n');
    expect((await applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).status).toBe('merged');
  });

  it('rejects candidate drift during preparation before storing a plan or committing task files', async () => {
    await expect(
      prepareNativeWorkspaceGroupDelivery({
        group,
        candidateId: 'accepted-candidate',
        commitMessage: 'feat: multi repository task',
        checks,
        validateCandidate: async () => {
          throw new Error('SDK candidate drift');
        },
      }),
    ).rejects.toThrow('SDK candidate drift');
    for (const entry of group.plan.repositories)
      expect(runGitCommand(entry.worktreeRoot, ['rev-parse', 'HEAD'])).toBe(entry.baseCommit);
    const paths = await nativeProjectPaths(group.plan.projectRoot, 'docs');
    await expect(
      fs.stat(path.join(paths.runtimeDir, 'group-delivery/journal.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await prepare()).status).toBe('ready');
  });

  it('refuses changed integration logs before updating any target', async () => {
    const ready = await prepare();
    const paths = await nativeProjectPaths(group.plan.projectRoot, 'docs');
    const log = ready.checkAttempts[0].result!.logRef;
    await fs.appendFile(path.join(paths.runtimeDir, log), 'modified evidence\n');
    await expect(applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).rejects.toThrow(
      'Integration check log changed',
    );
    for (const entry of group.plan.repositories)
      expect(runGitCommand(entry.sourceRoot, ['rev-parse', 'HEAD'])).toBe(entry.baseCommit);
  });

  it('copies accepted task-root check inputs and binds both source and integration bytes', async () => {
    const helper = path.join(group.plan.projectRoot, 'check.cjs');
    const bytes = '#!/usr/bin/env node\n' + checks[0].argv![1];
    await fs.writeFile(helper, bytes, { mode: 0o755 });
    const prepareWithHelper = () =>
      prepareNativeWorkspaceGroupDelivery({
        group,
        candidateId: 'accepted-root-inputs',
        commitMessage: 'feat: root check',
        checks: [{ ...checks[0], argv: ['check.cjs'] }],
      });
    const ready = await prepareWithHelper();
    const copied = path.join(ready.integrationRoot, 'check.cjs');
    expect(await fs.readFile(copied, 'utf8')).toBe(bytes);
    if (process.platform !== 'win32') {
      expect((await fs.stat(copied)).mode & 0o111).not.toBe(0);
      expect((await fs.stat(ready.integrationRoot)).mode & 0o077).toBe(0);
    }
    expect(ready.checkAttempts[0].result?.status).toBe('passed');
    await fs.writeFile(helper, bytes + '\n// changed candidate');
    await expect(applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).rejects.toThrow(
      'Delivery root inputs changed',
    );
    await fs.writeFile(helper, bytes);
    await fs.writeFile(copied, bytes + '\n// changed integration');
    await expect(applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).rejects.toThrow(
      'Delivery root inputs changed',
    );
    await fs.writeFile(copied, bytes);
    expect((await applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).status).toBe('merged');
  });

  it('recovers partial target publication without repeating successful merges or deleting a foreign Git lock', async () => {
    const ready = await prepare();
    const entry = group.plan.repositories[1];
    const lock = path.join(entry.commonDir, 'refs/heads', `${entry.targetBranch}.lock`);
    await fs.writeFile(lock, 'foreign writer');
    await expect(applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).rejects.toThrow();
    const backendHead = runGitCommand(group.plan.repositories[0].sourceRoot, ['rev-parse', 'HEAD']);
    expect(backendHead).toBe(ready.repositories[0].integrationCommit);
    expect(await fs.readFile(lock, 'utf8')).toBe('foreign writer');
    await fs.unlink(lock);
    const recovered = await applyNativeWorkspaceGroupDelivery(group, ready.planHash!);
    expect(recovered.status).toBe('merged');
    expect(runGitCommand(group.plan.repositories[0].sourceRoot, ['rev-parse', 'HEAD'])).toBe(
      backendHead,
    );
    expect(runGitCommand(entry.sourceRoot, ['status', '--porcelain'])).toBe('');
  });

  it('rejects changed targets, task bytes and prepared integration bytes', async () => {
    const ready = await prepare();
    const entry = group.plan.repositories[0];
    await expect(applyNativeWorkspaceGroupDelivery(group, 'wrong')).rejects.toThrow(
      'exact delivery plan',
    );
    await fs.writeFile(path.join(entry.worktreeRoot, 'source.txt'), 'candidate drift\n');
    await expect(applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).rejects.toThrow(
      'candidate changed',
    );
    await fs.writeFile(path.join(entry.worktreeRoot, 'source.txt'), 'new\n');
    await fs.writeFile(
      path.join(ready.integrationRoot, 'backend/source.txt'),
      'integration drift\n',
    );
    await expect(applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).rejects.toThrow(
      'Integration inputs are not committed',
    );
    await fs.writeFile(path.join(ready.integrationRoot, 'backend/source.txt'), 'new\n');
    runGitCommand(entry.sourceRoot, ['commit', '--allow-empty', '-m', 'target moved']);
    await expect(applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).rejects.toThrow(
      'target moved',
    );
    expect(runGitCommand(group.plan.repositories[1].sourceRoot, ['rev-parse', 'HEAD'])).toBe(
      group.plan.repositories[1].baseCommit,
    );
  });

  it('preserves the task Specs baseline and publishes create, modify and removal without overwriting concurrent shared changes', async () => {
    const shared = path.join(group.plan.coordinatorRoot, 'docs/comet/specs');
    const task = path.join(group.plan.projectRoot, 'docs/comet/specs');
    for (const capability of ['modified', 'removed', 'unrelated']) {
      await fs.mkdir(path.join(shared, capability), { recursive: true });
      await fs.writeFile(path.join(shared, capability, 'spec.md'), 'original\n');
    }
    await initializeNativeWorkspaceGroupSpecs(group, 'docs');
    await fs.writeFile(path.join(shared, 'modified/spec.md'), 'concurrent\n');
    await initializeNativeWorkspaceGroupSpecs(group, 'docs');
    expect(await fs.readFile(path.join(task, 'modified/spec.md'), 'utf8')).toBe('original\n');
    await fs.writeFile(path.join(task, 'modified/spec.md'), 'accepted\n');
    await fs.unlink(path.join(task, 'removed/spec.md'));
    await fs.mkdir(path.join(task, 'created'));
    await fs.writeFile(path.join(task, 'created/spec.md'), 'new capability\n');
    const publish = () =>
      publishNativeWorkspaceGroupSpecs({
        group,
        artifactRootRef: 'docs',
        deliveryId: 'fixture-delivery',
        specChanges: [
          { capability: 'created', operation: 'create', source: 'specs/created/spec.md' },
          { capability: 'modified', operation: 'modify', source: 'specs/modified/spec.md' },
          { capability: 'removed', operation: 'remove', source: null },
        ],
      });
    await expect(publish()).rejects.toThrow('Shared Spec changed');
    await expect(fs.stat(path.join(shared, 'created/spec.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readFile(path.join(shared, 'removed/spec.md'), 'utf8')).toBe('original\n');
    await fs.writeFile(path.join(shared, 'modified/spec.md'), 'original\n');
    const unlink = fs.unlink;
    const interrupted = vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
      if (String(file) === path.join(shared, 'removed/spec.md'))
        throw new Error('fixture interrupted Specs publication');
      return unlink(file);
    });
    try {
      await expect(publish()).rejects.toThrow('fixture interrupted Specs publication');
      expect(await fs.readFile(path.join(shared, 'created/spec.md'), 'utf8')).toBe(
        'new capability\n',
      );
      expect(await fs.readFile(path.join(shared, 'removed/spec.md'), 'utf8')).toBe('original\n');
    } finally {
      interrupted.mockRestore();
    }
    await publish();
    expect(await fs.readFile(path.join(shared, 'modified/spec.md'), 'utf8')).toBe('accepted\n');
    expect(await fs.readFile(path.join(shared, 'created/spec.md'), 'utf8')).toBe(
      'new capability\n',
    );
    expect(await fs.readFile(path.join(shared, 'unrelated/spec.md'), 'utf8')).toBe('original\n');
    await expect(fs.stat(path.join(shared, 'removed/spec.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await fs.writeFile(path.join(shared, 'modified/spec.md'), 'later task\n');
    await publish();
    expect(await fs.readFile(path.join(shared, 'modified/spec.md'), 'utf8')).toBe('later task\n');
  });

  it('refreshes moved targets with fresh combined checks and retains the previous evidence', async () => {
    const ready = await prepare();
    const entry = group.plan.repositories[1];
    await fs.writeFile(path.join(entry.sourceRoot, 'later.txt'), 'later target work\n');
    runGitCommand(entry.sourceRoot, ['add', 'later.txt']);
    runGitCommand(entry.sourceRoot, ['commit', '-m', 'later']);
    await expect(prepare('wrong')).rejects.toThrow('exact unfinished delivery');
    const refreshed = await prepare(ready.id);
    expect(refreshed.id).not.toBe(ready.id);
    expect(refreshed.supersedes).toBe(ready.id);
    expect(refreshed.checkAttempts[0].operationId).not.toBe(ready.checkAttempts[0].operationId);
    expect(refreshed.repositories.map((r) => r.sourceCommit)).toEqual(
      ready.repositories.map((r) => r.sourceCommit),
    );
    expect(await fs.readFile(path.join(ready.integrationRoot, 'frontend/source.txt'), 'utf8')).toBe(
      'new\n',
    );
    expect(
      await fs.readFile(path.join(refreshed.integrationRoot, 'frontend/later.txt'), 'utf8'),
    ).toBe('later target work\n');
    expect((await prepare(ready.id)).id).toBe(refreshed.id);
    await expect(applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).rejects.toThrow(
      'exact delivery plan',
    );
    expect((await applyNativeWorkspaceGroupDelivery(group, refreshed.planHash!)).status).toBe(
      'merged',
    );
    expect(await fs.readFile(path.join(entry.sourceRoot, 'later.txt'), 'utf8')).toBe(
      'later target work\n',
    );
  });

  it('refreshes after partial publication without rolling back or duplicating the published repository', async () => {
    const ready = await prepare();
    const frontend = group.plan.repositories[1];
    const lock = path.join(frontend.commonDir, 'refs/heads', `${frontend.targetBranch}.lock`);
    await fs.writeFile(lock, 'foreign writer');
    await expect(applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).rejects.toThrow();
    await expect(prepare(ready.id)).rejects.toThrow('target is dirty');
    await fs.unlink(lock);
    // Finish the interrupted checkout without publishing the remaining repositories.
    runGitCommand(frontend.sourceRoot, [
      'update-ref',
      `refs/heads/${frontend.targetBranch}`,
      ready.repositories[1].integrationCommit!,
      ready.repositories[1].targetCommit,
    ]);
    runGitCommand(frontend.sourceRoot, ['commit', '--allow-empty', '-m', 'later unrecorded work']);
    const frontendAdvanced = runGitCommand(frontend.sourceRoot, ['rev-parse', 'HEAD']);
    const backend = group.plan.repositories[0];
    const published = runGitCommand(backend.sourceRoot, ['rev-parse', 'HEAD']);
    runGitCommand(backend.sourceRoot, ['commit', '--allow-empty', '-m', 'later work']);
    const advanced = runGitCommand(backend.sourceRoot, ['rev-parse', 'HEAD']);
    const refreshed = await prepare(ready.id);
    expect(refreshed.repositories[0].integrationCommit).toBe(advanced);
    expect(refreshed.repositories[1].integrationCommit).toBe(frontendAdvanced);
    expect((await applyNativeWorkspaceGroupDelivery(group, refreshed.planHash!)).status).toBe(
      'merged',
    );
    expect(runGitCommand(backend.sourceRoot, ['rev-parse', 'HEAD'])).toBe(advanced);
    expect(runGitCommand(backend.sourceRoot, ['rev-list', '--count', `${published}..HEAD`])).toBe(
      '1',
    );
  });

  it('refuses refresh when an interrupted publication may have been removed from the target', async () => {
    const ready = await prepare();
    const frontend = group.plan.repositories[1];
    const lock = path.join(frontend.commonDir, 'refs/heads', `${frontend.targetBranch}.lock`);
    await fs.writeFile(lock, 'foreign writer');
    await expect(applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).rejects.toThrow();
    await fs.unlink(lock);
    // 模拟发布后收据尚未写入，目标又被外部操作改到不包含该提交的历史。
    runGitCommand(frontend.sourceRoot, [
      'update-ref',
      `refs/heads/${frontend.targetBranch}`,
      ready.repositories[1].integrationCommit!,
      ready.repositories[1].targetCommit,
    ]);
    runGitCommand(frontend.sourceRoot, ['reset', '--hard', ready.repositories[1].targetCommit]);
    runGitCommand(frontend.sourceRoot, [
      'commit',
      '--allow-empty',
      '-m',
      'divergent external work',
    ]);
    const moved = runGitCommand(frontend.sourceRoot, ['rev-parse', 'HEAD']);
    await expect(prepare(ready.id)).rejects.toThrow(
      'no longer contains the possibly published commit',
    );
    expect(runGitCommand(frontend.sourceRoot, ['rev-parse', 'HEAD'])).toBe(moved);
    expect(await fs.readFile(path.join(frontend.sourceRoot, 'source.txt'), 'utf8')).toBe('old\n');
    // 夹具恢复原发布提交后，同一刷新请求仍可继续，保留所有旧证据。
    runGitCommand(frontend.sourceRoot, [
      'merge',
      '--no-edit',
      ready.repositories[1].integrationCommit!,
    ]);
    const refreshed = await prepare(ready.id);
    expect(refreshed.supersedes).toBe(ready.id);
    expect((await applyNativeWorkspaceGroupDelivery(group, refreshed.planHash!)).status).toBe(
      'merged',
    );
  });

  it('requires fresh combined checks when an already published target advances before retry', async () => {
    const ready = await prepare();
    const frontend = group.plan.repositories[1],
      backend = group.plan.repositories[0];
    const lock = path.join(frontend.commonDir, `refs/heads/${frontend.targetBranch}.lock`);
    await fs.writeFile(lock, 'fixture foreign lock');
    await expect(applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).rejects.toThrow();
    await fs.unlink(lock);
    const partial = (await inspectNativeWorkspaceGroupDelivery(group))!;
    expect(partial.repositories[0].applied).toBe(true);
    runGitCommand(frontend.sourceRoot, [
      'update-ref',
      `refs/heads/${frontend.targetBranch}`,
      ready.repositories[1].integrationCommit!,
      ready.repositories[1].targetCommit,
    ]);
    await fs.writeFile(
      path.join(backend.sourceRoot, 'source.txt'),
      'another task breaks the contract\n',
    );
    runGitCommand(backend.sourceRoot, ['add', 'source.txt']);
    runGitCommand(backend.sourceRoot, ['commit', '-m', 'later task']);
    const advanced = runGitCommand(backend.sourceRoot, ['rev-parse', 'HEAD']);
    await expect(applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).rejects.toThrow(
      'moved after partial publication',
    );
    expect((await inspectNativeWorkspaceGroupDelivery(group))!.checkAttempts).toEqual(
      partial.checkAttempts,
    );
    await expect(prepare(ready.id)).rejects.toThrow('Integration check failed');
    const failed = (await inspectNativeWorkspaceGroupDelivery(group))!;
    expect(failed.checkAttempts.at(-1)?.result?.status).toBe('failed');
    expect(runGitCommand(backend.sourceRoot, ['rev-parse', 'HEAD'])).toBe(advanced);
    await fs.writeFile(path.join(backend.sourceRoot, 'source.txt'), 'new\n');
    runGitCommand(backend.sourceRoot, ['add', 'source.txt']);
    runGitCommand(backend.sourceRoot, ['commit', '-m', 'repair later task']);
    const refreshed = await prepare(failed.id);
    expect(refreshed.checkAttempts[0].operationId).not.toBe(ready.checkAttempts[0].operationId);
    const merged = await applyNativeWorkspaceGroupDelivery(group, refreshed.planHash!);
    expect(merged.status).toBe('merged');
    runGitCommand(backend.sourceRoot, ['commit', '--allow-empty', '-m', 'later completed task']);
    const later = runGitCommand(backend.sourceRoot, ['rev-parse', 'HEAD']);
    expect(await applyNativeWorkspaceGroupDelivery(group, refreshed.planHash!)).toEqual(merged);
    expect(runGitCommand(backend.sourceRoot, ['rev-parse', 'HEAD'])).toBe(later);
  });
});
