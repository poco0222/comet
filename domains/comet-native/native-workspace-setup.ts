import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withRecoverableFileLock } from '../../platform/fs/recoverable-file-lock.js';
import { resolveWorkspaceRuntimeLocation } from '../../platform/paths/workspace-runtime.js';
import { runGitCommand } from '../../platform/process/git.js';
import { normalizeWorkflowRelativePath } from '../workflow-contract/project-config.js';
import {
  hashProtectedProjectFile,
  readProtectedProjectFile,
} from '../workflow-contract/protected-project-path.js';
import { atomicWriteJson } from './native-atomic-file.js';
import { canonicalHash } from './native-canonical-hash.js';
import { copyNativeProtectedFile } from './native-protected-file.js';
import {
  executeNativeCheck,
  inspectNativeCheckProcessTreeLiveness,
  preflightNativeCheckPlans,
  type NativeCheckPlan,
  type NativeExecutedCheck,
} from './native-check-executor.js';

export interface NativeWorkspaceSetup {
  files: Array<{ path: string; hash: string }>;
  checks: NativeCheckPlan[];
}

export function validateNativeWorkspaceSetup(
  setup: NativeWorkspaceSetup,
  repositories: readonly { path: string }[],
): void {
  if (
    !setup ||
    Object.keys(setup).some((key) => !['files', 'checks'].includes(key)) ||
    !Array.isArray(setup.files) ||
    !Array.isArray(setup.checks)
  )
    throw new Error('Invalid workspace setup plan');
  const files = new Set<string>();
  for (const file of setup.files) {
    if (
      !file ||
      Object.keys(file).some((key) => !['path', 'hash'].includes(key)) ||
      normalizeWorkflowRelativePath(file.path, 'setup file') !== file.path ||
      !/^[a-f0-9]{64}$/u.test(file.hash) ||
      files.has(file.path) ||
      file.path.split('/').some((part) => ['.git', '.comet'].includes(part)) ||
      !repositories.some((repo) => file.path.startsWith(`${repo.path}/`))
    )
      throw new Error('Workspace setup files must be unique files inside declared repositories');
    files.add(file.path);
  }
  for (const check of setup.checks) {
    if (
      !check ||
      Object.keys(check).some(
        (key) =>
          !['id', 'name', 'executable', 'argv', 'cwdRef', 'timeoutMs', 'repeatable'].includes(key),
      ) ||
      ![check.id, check.name, check.executable, check.cwdRef].every(
        (value) => typeof value === 'string' && value.trim(),
      ) ||
      !Array.isArray(check.argv) ||
      !check.argv.every((arg) => typeof arg === 'string') ||
      check.repeatable !== true ||
      !Number.isSafeInteger(check.timeoutMs) ||
      check.timeoutMs < 1 ||
      (check.cwdRef !== '.' &&
        !repositories.some(
          (repo) => check.cwdRef === repo.path || check.cwdRef.startsWith(`${repo.path}/`),
        ))
    )
      throw new Error(
        'Workspace setup checks must be repeatable commands in the task or a declared repository',
      );
  }
}

function assertIgnoredLocalFile(
  root: string,
  ref: string,
  repositories: readonly { path: string }[],
) {
  const repository = repositories.find((repo) => ref.startsWith(`${repo.path}/`));
  if (!repository) throw new Error(`Setup file is outside declared repositories: ${ref}`);
  const relative = ref.slice(repository.path.length + 1);
  try {
    runGitCommand(path.join(root, repository.path), ['check-ignore', '--', relative]);
  } catch (error) {
    throw new Error(`Setup file must be Git-ignored and untracked: ${ref}`, { cause: error });
  }
}

/** 只读检查文件与可执行程序；计划仅保存摘要，不把本地配置内容写入响应。 */
export async function planNativeWorkspaceSetup(
  root: string,
  file: string,
  repositories: readonly { path: string }[],
): Promise<NativeWorkspaceSetup> {
  const source = path.resolve(root, file);
  const { bytes } = await readProtectedProjectFile(
    path.dirname(source),
    path.basename(source),
    Number.MAX_SAFE_INTEGER,
    { label: 'workspace setup file' },
  );
  const value = JSON.parse(bytes.toString('utf8')) as { copyFiles?: unknown; checks?: unknown };
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['copyFiles', 'checks'].includes(key)) ||
    (value.copyFiles !== undefined && !Array.isArray(value.copyFiles)) ||
    (value.checks !== undefined && !Array.isArray(value.checks))
  )
    throw new Error('Workspace setup accepts copyFiles and checks arrays');
  const setup: NativeWorkspaceSetup = {
    files: ((value.copyFiles as unknown[]) ?? []).map((ref) => ({
      path: normalizeWorkflowRelativePath(ref, 'setup file'),
      hash: '0'.repeat(64),
    })),
    checks: (value.checks as NativeCheckPlan[] | undefined) ?? [],
  };
  validateNativeWorkspaceSetup(setup, repositories);
  preflightNativeCheckPlans(root, setup.checks);
  for (const entry of setup.files) {
    assertIgnoredLocalFile(root, entry.path, repositories);
    entry.hash = (
      await hashProtectedProjectFile(root, entry.path, { label: 'workspace local file' })
    ).digest;
  }
  return setup;
}

interface SetupAttempt {
  id: string;
  operationId: string;
  process: { pid: number; identity?: string } | null;
  result: (NativeExecutedCheck & { logSha256: string }) | null;
}

/** 与工作流阶段无关的准备收据；失败重试不覆盖已经交给任务的本地配置。 */
export async function prepareNativeWorkspaceSetup(options: {
  sourceRoot: string;
  targetRoot: string;
  repositories: readonly { path: string }[];
  setup?: NativeWorkspaceSetup;
  beforeChecks?: () => Promise<void>;
}): Promise<void> {
  const { setup, sourceRoot, targetRoot, repositories } = options;
  if (!setup) return;
  validateNativeWorkspaceSetup(setup, repositories);
  const { runtimeRoot, workspaceId } = resolveWorkspaceRuntimeLocation(targetRoot);
  const hash = canonicalHash('comet.workspace-setup.v1', setup);
  const ref = `workspace-setup/${hash}.json`;
  await fs.mkdir(runtimeRoot, { recursive: true });
  await withRecoverableFileLock(path.join(runtimeRoot, 'workspace-setup.lock'), async () => {
    let receipt: {
      schema: 'comet.workspace-setup.v1';
      hash: string;
      workspaceId: string;
      files: string[];
      attempts: SetupAttempt[];
    };
    try {
      const { bytes } = await readProtectedProjectFile(runtimeRoot, ref, Number.MAX_SAFE_INTEGER, {
        label: 'workspace setup receipt',
      });
      receipt = JSON.parse(bytes.toString('utf8')) as typeof receipt;
      if (
        !receipt ||
        receipt.schema !== 'comet.workspace-setup.v1' ||
        receipt.hash !== hash ||
        receipt.workspaceId !== workspaceId ||
        !Array.isArray(receipt.files) ||
        receipt.files.some((ref) => !setup.files.some((file) => file.path === ref)) ||
        new Set(receipt.files).size !== receipt.files.length ||
        !Array.isArray(receipt.attempts) ||
        receipt.attempts.some(
          (attempt) =>
            !attempt ||
            !setup.checks.some((check) => check.id === attempt.id) ||
            typeof attempt.operationId !== 'string' ||
            !/^[a-f0-9-]{36}$/u.test(attempt.operationId) ||
            (attempt.process !== null &&
              (!attempt.process ||
                !Number.isSafeInteger(attempt.process.pid) ||
                attempt.process.pid < 1 ||
                (attempt.process.identity !== undefined &&
                  typeof attempt.process.identity !== 'string'))) ||
            (attempt.result !== null &&
              (!attempt.result ||
                attempt.result.id !== attempt.id ||
                !['passed', 'failed', 'interrupted'].includes(attempt.result.status) ||
                attempt.result.logRef !== `logs/checks/${attempt.operationId}-${attempt.id}.log` ||
                !/^[a-f0-9]{64}$/u.test(attempt.result.logSha256) ||
                attempt.result.repeatable !== true ||
                (attempt.result.status === 'passed' &&
                  (attempt.result.exitCode !== 0 || attempt.result.timedOut)))),
        )
      )
        throw new Error('Workspace setup receipt changed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      receipt = { schema: 'comet.workspace-setup.v1', hash, workspaceId, files: [], attempts: [] };
    }
    const save = () =>
      atomicWriteJson(path.join(runtimeRoot, ref), receipt, { containedRoot: runtimeRoot });
    for (const entry of setup.files) {
      assertIgnoredLocalFile(targetRoot, entry.path, repositories);
      let existing;
      try {
        existing = await hashProtectedProjectFile(targetRoot, entry.path, {
          label: 'workspace local file',
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (receipt.files.includes(entry.path)) {
        if (!existing)
          throw new Error(
            `Prepared local file is missing: ${path.join(targetRoot, entry.path)}; restore the task's configuration before retrying`,
          );
        continue;
      }
      if (existing && existing.digest !== entry.hash)
        throw new Error(
          `Workspace setup will not overwrite changed local file: ${path.join(targetRoot, entry.path)}`,
        );
      if (!existing)
        await copyNativeProtectedFile({
          sourceRoot,
          source: path.join(sourceRoot, entry.path),
          targetRoot,
          target: path.join(targetRoot, entry.path),
          maxBytes: null,
          label: `Workspace local file ${entry.path}`,
          expectedHash: entry.hash,
          expectedTargetHash: null,
          exclusive: true,
        });
      const handle = await fs.open(
        path.join(targetRoot, entry.path),
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      try {
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
      receipt.files.push(entry.path);
      await save();
    }
    preflightNativeCheckPlans(targetRoot, setup.checks);
    await options.beforeChecks?.();
    for (const check of setup.checks) {
      const previous = receipt.attempts.filter((attempt) => attempt.id === check.id).at(-1);
      if (previous?.result?.status === 'passed') {
        const log = await hashProtectedProjectFile(runtimeRoot, previous.result.logRef, {
          label: 'workspace setup log',
        });
        if (log.digest !== previous.result.logSha256)
          throw new Error(`Workspace setup log changed: ${previous.result.logRef}`);
        continue;
      }
      if (
        previous?.process &&
        !previous.result &&
        (await inspectNativeCheckProcessTreeLiveness(
          previous.process.pid,
          previous.process.identity,
        )) !== 'dead'
      )
        throw new Error(
          `Workspace setup may still be running: ${previous.operationId}; inspect the recorded process before retrying the same command`,
        );
      const attempt: SetupAttempt = {
        id: check.id,
        operationId: randomUUID(),
        process: null,
        result: null,
      };
      receipt.attempts.push(attempt);
      await save();
      attempt.result = await executeNativeCheck({
        projectRoot: targetRoot,
        runtimeDir: runtimeRoot,
        operationId: attempt.operationId,
        plan: check,
        onSpawn: async (process) => {
          attempt.process = {
            pid: process.pid,
            ...(process.identity ? { identity: process.identity } : {}),
          };
          await save();
        },
      });
      await save();
      if (attempt.result.status !== 'passed')
        throw new Error(
          `Workspace setup failed: ${check.id}; log: ${path.join(runtimeRoot, attempt.result.logRef)}. Resolve the environment error in ${targetRoot} and retry the same command`,
        );
    }
  });
}
