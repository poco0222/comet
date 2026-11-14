import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
  nativeWorkspaceDeliveryReportTemplate,
  reportNativeWorkspaceGroupDelivery,
  type NativeWorkspaceGroupDelivery,
} from '../../../domains/comet-native/native-workspace-group-delivery.js';
import { nativeProjectPaths } from '../../../domains/comet-native/native-paths.js';
import { canonicalHash } from '../../../domains/comet-native/native-canonical-hash.js';
import { captureNativeWorkspaceDeliveryTrees } from '../../../domains/comet-native/native-workspace-delivery-binding.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/comet-native/native-config.js';
import {
  assertNativeWorkspaceGroupSpecPublication,
  captureNativeWorkspaceGroupSpecPublication,
  initializeNativeWorkspaceGroupSpecs,
  publishNativeWorkspaceGroupSpecs,
} from '../../../domains/comet-native/native-workspace-group-specs.js';

describe('Native workspace group Git delivery', () => {
  let temporary: string, group: NativeWorkspaceGroup;
  const checks = [
    {
      id: 'combined',
      name: 'Verify all three integration repositories',
      executable: process.execPath,
      argv: [
        '-e',
        'const fs=require("node:fs"); for(const r of ["backend","frontend"]) if(fs.readFileSync(r+"/source.txt","utf8")!=="new\\n") process.exit(1); if(fs.readFileSync("mobile/source.txt","utf8")!=="old\\n") process.exit(1);',
      ],
      cwdRef: '.',
    },
  ];
  const prepareUnchecked = (refreshDeliveryId?: string) =>
    prepareNativeWorkspaceGroupDelivery({
      group,
      candidateId: 'accepted-candidate',
      commitMessage: 'feat: multi repository task',
      checks,
      refreshDeliveryId,
    });

  async function report(delivery: NativeWorkspaceGroupDelivery) {
    const template = nativeWorkspaceDeliveryReportTemplate(delivery);
    if (!template || delivery.status === 'ready') return delivery;
    const checks = template.checks.map((check) => {
      let result: 'passed' | 'failed' = 'passed';
      try {
        execFileSync(check.executable!, check.argv!, {
          cwd: check.cwd,
          stdio: 'pipe',
          timeout: 10000,
        });
      } catch {
        result = 'failed';
      }
      return {
        ...check,
        actualCommand: { executable: check.executable!, argv: check.argv! },
        result,
      };
    });
    return reportNativeWorkspaceGroupDelivery(group, { ...template, checks });
  }

  async function prepare(refreshDeliveryId?: string) {
    const delivery = await report(await prepareUnchecked(refreshDeliveryId));
    if (delivery.status === 'awaiting-checks') throw new Error('Integration check failed');
    return delivery;
  }

  const reports = (journal: NativeWorkspaceGroupDelivery) => {
    if (journal.schema !== 'comet.native.workspace-group-delivery.v2')
      throw new Error('Expected Agent delivery reports');
    return journal.reports;
  };

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
      runGitCommand(root, ['config', 'core.autocrlf', 'false']);
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

  it('blocks changes to excluded tracked inputs before creating any delivery commit', async () => {
    const mobile = group.plan.repositories[2];
    const config = defaultProjectConfig();
    config.native.legacyDeliveryExcludes = ['mobile/source.txt', 'mobile/ private.yml'];
    await writeProjectConfig(group.plan.projectRoot, config);
    const before = group.plan.repositories.map((entry) =>
      runGitCommand(entry.worktreeRoot, ['rev-parse', 'HEAD']),
    );
    const target = path.join(mobile.worktreeRoot, 'source.txt');
    await fs.writeFile(target, 'unverified\n');
    runGitCommand(mobile.worktreeRoot, ['add', 'source.txt']);
    const prepareScoped = () =>
      prepareNativeWorkspaceGroupDelivery({
        group,
        candidateId: 'accepted-candidate',
        commitMessage: 'feat: scoped delivery',
        checks: [{ ...checks[0], argv: ['--version'] }],
      });
    await expect(prepareScoped()).rejects.toThrow(
      'Changed file is excluded from accepted delivery inputs: mobile/source.txt',
    );
    for (const [i, entry] of group.plan.repositories.entries())
      expect(runGitCommand(entry.worktreeRoot, ['rev-parse', 'HEAD'])).toBe(before[i]);
    expect(runGitCommand(mobile.worktreeRoot, ['diff', '--cached', '--name-only'])).toBe(
      'source.txt',
    );

    await fs.writeFile(target, 'old\n');
    runGitCommand(mobile.worktreeRoot, ['add', 'source.txt']);
    await fs.writeFile(path.join(mobile.worktreeRoot, ' private.yml'), 'synthetic local config\n');
    runGitCommand(mobile.worktreeRoot, ['add', ' private.yml']);
    await expect(prepareScoped()).rejects.toThrow(
      'Changed file is excluded from accepted delivery inputs: mobile/ private.yml',
    );
    runGitCommand(mobile.worktreeRoot, ['rm', '--force', '--', ' private.yml']);
    await fs.writeFile(target, 'local-only\n');
    const ready = await report(await prepareScoped());
    expect(ready.status).toBe('ready');
    const merged = await applyNativeWorkspaceGroupDelivery(group, ready.planHash!);
    expect(merged.status).toBe('merged');
    expect(runGitCommand(mobile.sourceRoot, ['rev-parse', 'HEAD'])).toBe(before[2]);
    expect(await fs.readFile(target, 'utf8')).toBe('local-only\n');
  });

  it('checks combined merged trees before updating targets and does not commit unchanged repositories', async () => {
    const frontend = group.plan.repositories[1];
    await fs.writeFile(path.join(frontend.sourceRoot, 'upstream.txt'), 'new target work\n');
    runGitCommand(frontend.sourceRoot, ['add', 'upstream.txt']);
    runGitCommand(frontend.sourceRoot, ['commit', '-m', 'upstream']);
    const ready = await prepare();
    expect(ready.status).toBe('ready');
    expect(reports(ready).at(-1)?.checks[0].result).toBe('passed');
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
    expect(reports(await prepare())).toHaveLength(1);
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
    expect(reports((await inspectNativeWorkspaceGroupDelivery(group))!)).toEqual(reports(failed));
    await fs.writeFile(path.join(mobile.sourceRoot, 'source.txt'), 'old\n');
    runGitCommand(mobile.sourceRoot, ['add', 'source.txt']);
    runGitCommand(mobile.sourceRoot, ['commit', '-m', 'repair target contract']);
    const ready = await prepare(failed.id);
    expect(reports(ready)[0].checks[0].result).toBe('passed');
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

  it('rejects missing, failed, stale or wrong-directory integration reports before updating targets', async () => {
    const prepared = await prepareUnchecked();
    const template = nativeWorkspaceDeliveryReportTemplate(prepared)!;
    await expect(applyNativeWorkspaceGroupDelivery(group, template.planHash)).rejects.toThrow(
      'exact delivery plan',
    );
    await expect(
      reportNativeWorkspaceGroupDelivery(group, { ...template, checks: [] }),
    ).rejects.toThrow('missing required checks');
    const plan = template.checks[0];
    const check = {
      ...plan,
      actualCommand: { executable: plan.executable!, argv: plan.argv! },
    };
    await expect(
      reportNativeWorkspaceGroupDelivery(group, {
        ...template,
        checks: [{ ...check, cwd: group.plan.projectRoot, result: 'passed' }],
      }),
    ).rejects.toThrow('outside its prepared workspace');
    for (const invalid of [
      { ...plan, actualCommand: undefined, command: 'true' },
      {
        ...check,
        actualCommand: { executable: 'wrong-executable', argv: check.actualCommand.argv },
      },
      {
        ...check,
        actualCommand: { executable: check.actualCommand.executable, argv: ['--wrong-argument'] },
      },
    ]) {
      await expect(
        reportNativeWorkspaceGroupDelivery(group, {
          ...template,
          checks: [{ ...invalid, result: 'passed' }],
        }),
      ).rejects.toThrow('required executable and arguments');
    }
    const ready = await report(prepared);
    const latest = { ...template, planHash: ready.planHash! };
    await reportNativeWorkspaceGroupDelivery(group, {
      ...latest,
      checks: [{ ...check, result: 'failed' }],
    });
    await expect(applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).rejects.toThrow(
      'exact delivery plan',
    );
    await expect(
      reportNativeWorkspaceGroupDelivery(group, {
        ...template,
        checks: [{ ...check, result: 'passed' }],
      }),
    ).rejects.toThrow('current delivery plan');
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
    const ready = await report(await prepareWithHelper());
    const copied = path.join(ready.integrationRoot, 'check.cjs');
    expect(await fs.readFile(copied, 'utf8')).toBe(bytes);
    if (process.platform !== 'win32') {
      expect((await fs.stat(copied)).mode & 0o111).not.toBe(0);
      expect((await fs.stat(ready.integrationRoot)).mode & 0o077).toBe(0);
    }
    expect(reports(ready)[0].checks[0].result).toBe('passed');
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

  async function seedPreparingV1(treesAreRecorded: boolean) {
    const id = '00000000-0000-4000-8000-000000000001';
    const trees = await captureNativeWorkspaceDeliveryTrees(group);
    const journal = {
      schema: 'comet.native.workspace-group-delivery.v1',
      id,
      supersedes: null,
      groupHash: group.plan.hash,
      candidateId: 'accepted-candidate',
      commitMessage: 'feat: multi repository task',
      checks,
      artifactRootRef: 'docs',
      rootFiles: [],
      localFiles: [],
      integrationRoot: path.join(path.dirname(group.plan.projectRoot), `.comet-integration-${id}`),
      integrationRootId: null,
      checkAttempts: [],
      integrationHash: null,
      planHash: null,
      status: 'preparing',
      repositories: group.plan.repositories.map((entry, index) => ({
        path: entry.path,
        sourceHash: 'a'.repeat(64),
        sourceParent: entry.baseCommit,
        sourceTree: treesAreRecorded ? trees[index].tree : null,
        sourceCommit: null,
        targetCommit: entry.baseCommit,
        targetRoot: entry.sourceRoot,
        targetWorkspaceId: null,
        integrationWorkspaceId: null,
        integrationCommit: null,
        applied: false,
        applyStarted: false,
      })),
    };
    const paths = await nativeProjectPaths(group.plan.projectRoot, 'docs');
    const file = path.join(paths.runtimeDir, 'group-delivery/journal.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(journal));
    return { file, journal, trees };
  }

  it('recovers an exact v1 source commit written before its receipt and refreshes remaining repositories', async () => {
    const { file, journal } = await seedPreparingV1(true);
    const first = group.plan.repositories[0];
    runGitCommand(first.worktreeRoot, ['add', 'source.txt']);
    runGitCommand(first.worktreeRoot, ['commit', '-m', journal.commitMessage]);
    await expect(prepareUnchecked()).rejects.toThrow('Unrecorded task commit differs');
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(journal);
    expect(runGitCommand(group.plan.repositories[1].worktreeRoot, ['rev-parse', 'HEAD'])).toBe(
      group.plan.repositories[1].baseCommit,
    );
    runGitCommand(first.worktreeRoot, [
      'commit',
      '--amend',
      '-m',
      journal.commitMessage,
      '-m',
      `Comet-Delivery: ${journal.id}\nComet-Candidate: ${journal.candidateId}`,
    ]);
    const recorded = runGitCommand(first.worktreeRoot, ['rev-parse', 'HEAD']);
    const ready = await prepare(journal.id);
    expect(ready.supersedes).toBe(journal.id);
    expect(ready.repositories[0].sourceCommit).toBe(recorded);
    expect(runGitCommand(first.worktreeRoot, ['rev-parse', 'HEAD'])).toBe(recorded);
    expect(runGitCommand(first.sourceRoot, ['rev-parse', 'HEAD'])).toBe(first.baseCommit);
    expect((await applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).status).toBe('merged');
  });

  it('requires original candidate proof for v1 preparation without recorded source trees', async () => {
    const { file, journal, trees } = await seedPreparingV1(false);
    await expect(prepareUnchecked()).rejects.toThrow(
      'Original delivery has no recorded source tree',
    );
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(journal);
    const validateCandidate = vi.fn(async () => ({ trees, rootFiles: [], localFiles: [] }));
    const prepareBound = () =>
      prepareNativeWorkspaceGroupDelivery({
        group,
        candidateId: journal.candidateId,
        commitMessage: journal.commitMessage,
        checks,
        validateCandidate,
      });
    const first = group.plan.repositories[0];
    runGitCommand(first.worktreeRoot, ['commit', '--allow-empty', '-m', 'other history']);
    await expect(prepareBound()).rejects.toThrow('Original delivery has no recorded source tree');
    expect(validateCandidate).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(journal);
    runGitCommand(first.worktreeRoot, ['reset', '--soft', first.baseCommit]);
    const ready = await report(await prepareBound());
    expect(validateCandidate).toHaveBeenCalledOnce();
    expect(ready.status).toBe('ready');
    expect(ready.repositories.map((entry) => entry.sourceTree)).toEqual(
      trees.map((entry) => entry.tree),
    );
  });

  it('migrates a partially applied v1 delivery without replaying Git writes or unknown checks', async () => {
    const ready = await prepare();
    const frontend = group.plan.repositories[1];
    const lock = path.join(frontend.commonDir, 'refs/heads', `${frontend.targetBranch}.lock`);
    await fs.writeFile(lock, 'foreign writer');
    await expect(applyNativeWorkspaceGroupDelivery(group, ready.planHash!)).rejects.toThrow();
    const backend = group.plan.repositories[0];
    const published = runGitCommand(backend.sourceRoot, ['rev-parse', 'HEAD']);
    expect(published).toBe(ready.repositories[0].integrationCommit);
    const partial = (await inspectNativeWorkspaceGroupDelivery(group))!;
    if (partial.schema !== 'comet.native.workspace-group-delivery.v2')
      throw new Error('Expected a prepared test delivery');
    const { reports: _reports, ...base } = partial;
    const legacy = {
      ...base,
      schema: 'comet.native.workspace-group-delivery.v1',
      repositories: base.repositories.map((entry) => ({ ...entry, sourceHash: 'a'.repeat(64) })),
      checks,
      checkAttempts: [
        {
          id: 'combined',
          operationId: 'original-unknown-check',
          inputHash: 'b'.repeat(64),
          process: { pid: process.pid },
          result: null,
        },
      ],
      integrationHash: 'b'.repeat(64),
    };
    legacy.planHash = canonicalHash('comet.native.workspace-group-delivery-plan.v1', {
      id: legacy.id,
      groupHash: legacy.groupHash,
      candidateId: legacy.candidateId,
      repositories: legacy.repositories.map(
        ({ applied: _applied, applyStarted: _started, ...entry }) => entry,
      ),
      checks: legacy.checks,
      artifactRootRef: legacy.artifactRootRef,
      rootFiles: legacy.rootFiles,
      localFiles: legacy.localFiles,
      checkAttempts: legacy.checkAttempts,
      integrationRoot: legacy.integrationRoot,
      integrationRootId: legacy.integrationRootId,
      integrationHash: legacy.integrationHash,
    });
    const paths = await nativeProjectPaths(group.plan.projectRoot, 'docs');
    await fs.writeFile(
      path.join(paths.runtimeDir, 'group-delivery/journal.json'),
      JSON.stringify(legacy),
    );
    await expect(applyNativeWorkspaceGroupDelivery(group, legacy.planHash)).rejects.toThrow(
      'submit a current integration report',
    );
    await fs.unlink(lock);
    const migrating = await prepareUnchecked();
    const template = nativeWorkspaceDeliveryReportTemplate(migrating)!;
    expect(template.legacyUnconfirmed).toEqual(['original-unknown-check']);
    expect(migrating.repositories[0].applied).toBe(true);
    const plan = template.checks[0];
    const check = {
      ...plan,
      actualCommand: { executable: plan.executable!, argv: plan.argv! },
      result: 'passed',
    };
    const { legacyReconciliation: _legacyReconciliation, ...report } = template;
    await expect(
      reportNativeWorkspaceGroupDelivery(group, { ...report, checks: [check] }),
    ).rejects.toThrow('Reconcile the original integration execution');
    const migrated = await reportNativeWorkspaceGroupDelivery(group, {
      ...report,
      checks: [check],
      legacyReconciliation: 'Fixture old command was accounted for and produced no write',
    });
    const merged = await applyNativeWorkspaceGroupDelivery(group, migrated.planHash!);
    expect(merged.status).toBe('merged');
    expect(runGitCommand(backend.sourceRoot, ['rev-parse', 'HEAD'])).toBe(published);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(paths.runtimeDir, 'group-delivery/legacy', `${legacy.id}.json`),
          'utf8',
        ),
      ),
    ).toEqual(legacy);
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

  it('blocks a Spec edited after acceptance and keeps completed publication recoverable', async () => {
    const shared = path.join(group.plan.coordinatorRoot, 'docs/comet/specs');
    const task = path.join(group.plan.projectRoot, 'docs/comet');
    const source = 'specs/delivery/spec.md';
    const changeSource = path.join(task, 'changes', group.plan.name, source);
    const canonical = path.join(task, source);
    await initializeNativeWorkspaceGroupSpecs(group, 'docs');
    await fs.mkdir(path.dirname(changeSource), { recursive: true });
    await fs.writeFile(changeSource, 'verified Spec\n');
    const specChanges = [{ capability: 'delivery', operation: 'create' as const, source }];
    const expectedSpecs = await captureNativeWorkspaceGroupSpecPublication(
      group,
      'docs',
      specChanges,
      group.plan.name,
    );
    const publish = () =>
      publishNativeWorkspaceGroupSpecs({
        group,
        artifactRootRef: 'docs',
        specChanges,
        deliveryId: 'fixture-delivery',
        expectedSpecs,
      });
    await fs.mkdir(path.dirname(canonical), { recursive: true });
    await fs.writeFile(canonical, 'changed after verification\n');
    await expect(
      assertNativeWorkspaceGroupSpecPublication(group, 'docs', expectedSpecs),
    ).rejects.toThrow('Archived task Spec differs from the accepted delivery');
    await expect(publish()).rejects.toThrow(
      'Archived task Specs differ from the accepted delivery',
    );
    await expect(fs.stat(path.join(shared, 'delivery/spec.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await fs.writeFile(canonical, 'verified Spec\r\n');
    await assertNativeWorkspaceGroupSpecPublication(group, 'docs', expectedSpecs);
    await publish();
    await fs.unlink(canonical);
    await publish();
    expect(await fs.readFile(path.join(shared, 'delivery/spec.md'), 'utf8')).toBe(
      'verified Spec\r\n',
    );
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
    expect(reports(refreshed)[0].planHash).not.toBe(reports(ready)[0].planHash);
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
    expect(reports((await inspectNativeWorkspaceGroupDelivery(group))!)).toEqual(reports(partial));
    await expect(prepare(ready.id)).rejects.toThrow('Integration check failed');
    const failed = (await inspectNativeWorkspaceGroupDelivery(group))!;
    expect(reports(failed).at(-1)?.checks[0].result).toBe('failed');
    expect(runGitCommand(backend.sourceRoot, ['rev-parse', 'HEAD'])).toBe(advanced);
    await fs.writeFile(path.join(backend.sourceRoot, 'source.txt'), 'new\n');
    runGitCommand(backend.sourceRoot, ['add', 'source.txt']);
    runGitCommand(backend.sourceRoot, ['commit', '-m', 'repair later task']);
    const refreshed = await prepare(failed.id);
    expect(reports(refreshed)[0].planHash).not.toBe(reports(ready)[0].planHash);
    const merged = await applyNativeWorkspaceGroupDelivery(group, refreshed.planHash!);
    expect(merged.status).toBe('merged');
    runGitCommand(backend.sourceRoot, ['commit', '--allow-empty', '-m', 'later completed task']);
    const later = runGitCommand(backend.sourceRoot, ['rev-parse', 'HEAD']);
    expect(await applyNativeWorkspaceGroupDelivery(group, refreshed.planHash!)).toEqual(merged);
    expect(runGitCommand(backend.sourceRoot, ['rev-parse', 'HEAD'])).toBe(later);
  });
});
