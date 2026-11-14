import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withRecoverableFileLock } from '../../platform/fs/recoverable-file-lock.js';
import { listGitWorktrees } from '../../platform/paths/git-worktree.js';
import {
  resolveWorkspaceIdentity,
  resolveWorkspaceRuntimeLocation,
} from '../../platform/paths/workspace-runtime.js';
import { runGitCommand } from '../../platform/process/git.js';
import { isWorkspaceRuntimeMigrationFence } from '../workflow-contract/workspace-runtime.js';
import { readSdkChangeOwner } from '../workflow-contract/change-runtime-owner.js';
import {
  inspectProtectedProjectPath,
  readProtectedProjectFile,
} from '../workflow-contract/protected-project-path.js';
import { atomicWriteJson } from './native-atomic-file.js';
import { canonicalHash } from './native-canonical-hash.js';
import { nativeProjectPaths } from './native-paths.js';
import { parseNativePortableState } from './native-portable-state.js';
import { readNativeSdkRunRecord } from './native-sdk-state-store.js';
import type { NativeSdkStatusProjection } from './native-sdk-status.js';
import { listNativeWorkspaceGroupDeliveries } from './native-workspace-group-delivery.js';
import { readNativeWorkspaceGroupRecord } from './native-workspace-group.js';

interface CleanupReceipt {
  schema: 'comet.native.workspace-group-cleanup.v1';
  groupHash: string;
  workspaceId: string;
  planHash: string;
  runHash: string;
  status: NativeSdkStatusProjection;
  statusHash: string;
  entries: Record<string, { started: boolean; removed: boolean }>;
}

async function readJson<T>(root: string, ref: string): Promise<T | null> {
  try {
    const { bytes } = await readProtectedProjectFile(root, ref, Number.MAX_SAFE_INTEGER, {
      label: 'Native workspace cleanup record',
    });
    return JSON.parse(bytes.toString('utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function cleanupStorage(root: string, name: string) {
  const paths = await nativeProjectPaths(root, 'docs', { readOnly: true });
  const group = await readNativeWorkspaceGroupRecord(root);
  if (!group || group.plan.name !== name) throw new Error('Cleanup requires a registered task');
  const owner = await readSdkChangeOwner(root, 'native', name, { readOnly: true });
  const run = owner ? await readNativeSdkRunRecord(root, owner.runId) : null;
  if (!run) throw new Error('Cleanup requires the original SDK Run');
  const state = parseNativePortableState(run.state);
  if (
    run.status !== 'completed' ||
    state.name !== name ||
    !state.archived ||
    state.verification_result !== 'pass' ||
    state.workspace.group_hash !== group.plan.hash ||
    !run.actions.some(
      (action) => action.stepId === 'archive.finalize' && action.status === 'succeeded',
    )
  )
    throw new Error('Cleanup requires completed SDK acceptance and Archive');
  const runHash = canonicalHash('cleanup-run', run);
  const ref = 'group-delivery/cleanup.json';
  const receipt = await readJson<CleanupReceipt>(paths.runtimeDir, ref);
  if (
    receipt &&
    (receipt.schema !== 'comet.native.workspace-group-cleanup.v1' ||
      receipt.groupHash !== group.plan.hash ||
      receipt.workspaceId !== group.projectWorkspaceId ||
      receipt.runHash !== runHash ||
      !receipt.status ||
      receipt.statusHash !== canonicalHash('cleanup-status', receipt.status) ||
      receipt.status.name !== name ||
      receipt.status.run.id !== run.runId ||
      !receipt.entries ||
      typeof receipt.entries !== 'object' ||
      Array.isArray(receipt.entries) ||
      Object.values(receipt.entries).some(
        (entry) =>
          !entry ||
          typeof entry.started !== 'boolean' ||
          typeof entry.removed !== 'boolean' ||
          (entry.removed && !entry.started),
      ))
  )
    throw new Error('Native cleanup receipt or original Run changed');
  return {
    paths,
    group,
    runHash,
    receipt,
    save: (value: CleanupReceipt) =>
      atomicWriteJson(path.join(paths.runtimeDir, ref), value, {
        containedRoot: paths.runtimeDir,
      }),
  };
}

/** Read-only history is tied to the unchanged authoritative Run, never used for advancement. */
export async function readNativeWorkspaceCleanupStatus(
  root: string,
  name: string,
): Promise<NativeSdkStatusProjection | null> {
  const { runtimeRoot } = resolveWorkspaceRuntimeLocation(root);
  if (!(await readJson(runtimeRoot, 'native/group-delivery/cleanup.json'))) return null;
  const { receipt } = await cleanupStorage(root, name);
  return {
    ...receipt!.status,
    cleanup: {
      planHash: receipt!.planHash,
      removed: Object.entries(receipt!.entries)
        .filter(([, value]) => value.removed)
        .map(([key]) => key),
      historical: true,
    },
  };
}

/** Ordinary Git removal also deletes ignored files; retain any such worktree in full. */
export async function cleanupNativeWorkspaceGroup(options: {
  root: string;
  name: string;
  apply?: string;
  status?: NativeSdkStatusProjection;
}) {
  const initial = await cleanupStorage(options.root, options.name);
  return withRecoverableFileLock(
    path.join(initial.paths.runtimeDir, 'locks', 'group-delivery.lock'),
    async () => {
      const io = await cleanupStorage(options.root, options.name);
      const deliveries = await listNativeWorkspaceGroupDeliveries(io.group);
      const delivery = deliveries[0];
      if (
        !delivery ||
        delivery.status !== 'merged' ||
        !delivery.planHash ||
        delivery.repositories.some((entry) => !entry.applied)
      )
        throw new Error('Merge all repositories before cleanup');
      if (options.apply && options.apply !== delivery.planHash)
        throw new Error('Cleanup plan hash changed');
      const published = await readJson<{ groupHash: string; deliveryId: string }>(
        io.paths.runtimeDir,
        'group-delivery/specs-published.json',
      );
      if (published?.groupHash !== io.group.plan.hash || published.deliveryId !== delivery.id)
        throw new Error('Publish shared Specs before cleanup');
      let receipt = io.receipt;
      if (receipt && receipt.planHash !== delivery.planHash)
        throw new Error('Cleanup delivery changed');
      if (!receipt && options.apply) {
        if (!options.status) throw new Error('Inspect the completed SDK Run before cleanup');
        receipt = {
          schema: 'comet.native.workspace-group-cleanup.v1',
          groupHash: io.group.plan.hash,
          workspaceId: io.group.projectWorkspaceId,
          planHash: delivery.planHash,
          runHash: io.runHash,
          status: options.status,
          statusHash: canonicalHash('cleanup-status', options.status),
          entries: {},
        };
        await io.save(receipt);
      }
      const members = io.group.plan.repositories;
      const candidates = members.map((member, index) => ({
        key: `task/${member.path}`,
        root: member.worktreeRoot,
        member,
        workspaceId: io.group.repositories.find((item) => item.path === member.path)?.workspaceId,
        commit: delivery.repositories[index].sourceCommit,
        branch: member.changeBranch as string | null,
      }));
      for (const round of deliveries) {
        if (!round.integrationRootId) continue;
        if (resolveWorkspaceIdentity(round.integrationRoot).workspaceId !== round.integrationRootId)
          throw new Error(`Integration root changed: ${round.integrationRoot}`);
        for (const [index, member] of members.entries())
          candidates.push({
            key: `${round.id}/${member.path}`,
            root: path.join(round.integrationRoot, member.path),
            member,
            workspaceId: round.repositories[index].integrationWorkspaceId ?? undefined,
            commit: round.repositories[index].integrationCommit,
            branch: null,
          });
      }
      if (
        receipt &&
        Object.keys(receipt.entries).some((key) => !candidates.some((item) => item.key === key))
      )
        throw new Error('Cleanup receipt contains an unknown worktree');
      const results: Array<{
        key: string;
        root: string;
        status: 'eligible' | 'removed' | 'retained';
        reason?: string;
      }> = [];
      for (const entry of candidates) {
        const recorded = receipt?.entries[entry.key];
        const retain = (reason: string) =>
          results.push({ key: entry.key, root: entry.root, status: 'retained', reason });
        const registered = listGitWorktrees(entry.member.sourceRoot).find(
          (item) => item.root === entry.root,
        );
        let exists = true;
        try {
          await fs.lstat(entry.root);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          exists = false;
        }
        if (recorded?.started && !exists && !registered) {
          if (options.apply && !recorded.removed) {
            recorded.removed = true;
            await io.save(receipt!);
          }
          results.push({ key: entry.key, root: entry.root, status: 'removed' });
          continue;
        }
        if (recorded?.removed) throw new Error(`Removed worktree path was reused: ${entry.root}`);
        if (!exists || !registered || !entry.workspaceId || !entry.commit) {
          retain('Worktree identity or accepted commit is missing; inspect before cleanup');
          continue;
        }
        if (registered.branch !== entry.branch || (entry.branch === null && !registered.detached)) {
          retain('Worktree branch changed; preserve its current checkout');
          continue;
        }
        if (
          resolveWorkspaceIdentity(entry.root).workspaceId !== entry.workspaceId ||
          resolveWorkspaceIdentity(entry.member.sourceRoot).workspaceId !==
            entry.member.sourceWorkspaceId ||
          runGitCommand(entry.root, ['rev-parse', 'HEAD']) !== entry.commit
        ) {
          retain('Worktree identity or commit changed');
          continue;
        }
        try {
          runGitCommand(entry.member.sourceRoot, [
            'merge-base',
            '--is-ancestor',
            entry.commit,
            `refs/heads/${entry.member.targetBranch}`,
          ]);
        } catch {
          retain('Target no longer contains this worktree commit');
          continue;
        }
        const fence = path.join(entry.root, '.comet/runtime');
        const runtimeRoot = resolveWorkspaceRuntimeLocation(entry.root).runtimeRoot;
        await inspectProtectedProjectPath(entry.root, '.comet/runtime', {
          label: 'Cleanup Runtime fence',
        });
        const ownedFence = await isWorkspaceRuntimeMigrationFence(fence, runtimeRoot, {
          projectRoot: entry.root,
        });
        const fenceStat = ownedFence ? await fs.lstat(fence) : null;
        const fenceRecord =
          ownedFence && fenceStat!.isFile()
            ? await readJson<Record<string, unknown>>(entry.root, '.comet/runtime')
            : null;
        const removableFence =
          ownedFence &&
          fenceStat!.isFile() &&
          fenceRecord?.source === fence &&
          Object.keys(fenceRecord).every((key) =>
            ['schema', 'workspaceId', 'source', 'target', 'kind'].includes(key),
          ) &&
          !runGitCommand(entry.root, ['ls-files', '--', '.comet/runtime']);
        const pathspec = removableFence ? ['--', '.', ':(exclude).comet/runtime'] : [];
        if (
          runGitCommand(entry.root, [
            'ls-files',
            '--others',
            '--ignored',
            '--exclude-standard',
            '-z',
            ...pathspec,
          ])
        ) {
          retain('Git-ignored local files remain; the entire worktree is preserved');
          continue;
        }
        const dirty = runGitCommand(entry.root, [
          'status',
          '--porcelain=v1',
          '--untracked-files=all',
          ...pathspec,
        ]);
        if (dirty) {
          retain(`Uncommitted or untracked files remain: ${dirty}`);
          continue;
        }
        const cwd = path.relative(entry.root, process.cwd());
        if (
          cwd === '' ||
          (!path.isAbsolute(cwd) && cwd !== '..' && !cwd.startsWith(`..${path.sep}`))
        ) {
          retain('Run cleanup from the coordinator, outside the worktree being removed');
          continue;
        }
        if (options.apply) {
          receipt!.entries[entry.key] = { started: true, removed: false };
          await io.save(receipt!);
          if (removableFence) {
            const currentFence = await readJson(entry.root, '.comet/runtime');
            if (
              canonicalHash('cleanup-fence', currentFence) !==
              canonicalHash('cleanup-fence', fenceRecord)
            )
              throw new Error(`Runtime fence changed: ${fence}`);
            if (
              !(await isWorkspaceRuntimeMigrationFence(fence, runtimeRoot, {
                projectRoot: entry.root,
              })) ||
              !(await fs.lstat(fence)).isFile()
            )
              throw new Error(`Runtime fence changed: ${fence}`);
            await fs.unlink(fence);
          }
          runGitCommand(entry.member.sourceRoot, ['worktree', 'remove', entry.root]);
          receipt!.entries[entry.key].removed = true;
          await io.save(receipt!);
        }
        results.push({
          key: entry.key,
          root: entry.root,
          status: options.apply ? 'removed' : 'eligible',
        });
      }
      return {
        planHash: delivery.planHash,
        worktrees: results,
        retainedRoot: io.group.plan.projectRoot,
        retained:
          'Task documents, Run/check evidence, integration root files and branches are retained.',
      };
    },
  );
}
