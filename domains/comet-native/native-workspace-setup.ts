import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withRecoverableFileLock } from '../../platform/fs/recoverable-file-lock.js';
import { resolveWorkspaceRuntimeLocation } from '../../platform/paths/workspace-runtime.js';
import { samePath } from '../../platform/paths/git-worktree.js';
import { runGitCommand } from '../../platform/process/git.js';
import { normalizeWorkflowRelativePath } from '../workflow-contract/project-config.js';
import {
  hashProtectedProjectFile,
  inspectProtectedProjectPath,
  readProtectedProjectFile,
} from '../workflow-contract/protected-project-path.js';
import { readFileRaceSafe } from '../../platform/fs/race-safe-read.js';
import { stripUtf8Bom } from '../../platform/fs/strip-bom.js';
import { atomicWriteJson } from './native-atomic-file.js';
import { canonicalHash } from './native-canonical-hash.js';
import { copyNativeProtectedFile } from './native-protected-file.js';
export interface NativeWorkspaceSetupCheck {
  id: string;
  name: string;
  executable: string;
  argv: string[];
  cwdRef: string;
  timeoutMs: number;
  repeatable: true;
}

export interface NativeWorkspaceSetup {
  files: Array<{ path: string; hash: string }>;
  checks: NativeWorkspaceSetupCheck[];
}

interface WorkspaceSetupCheckResult {
  id: string;
  cwd: string;
  result: 'passed' | 'failed' | 'not-run';
  note?: string;
}

export interface NativeWorkspaceSetupReport {
  id: string;
  workspaceId: string;
  checks: WorkspaceSetupCheckResult[];
}

export interface NativeWorkspaceSetupProgress {
  id: string;
  workspaceId: string;
  status: 'ready' | 'awaiting-checks';
  checks: Array<NativeWorkspaceSetupCheck & { cwd: string; reconcile?: string }>;
}

function isCheckResult(value: unknown): value is WorkspaceSetupCheckResult {
  if (!value || typeof value !== 'object') return false;
  const check = value as WorkspaceSetupCheckResult;
  return (
    Object.keys(check).every((key) => ['id', 'cwd', 'result', 'note'].includes(key)) &&
    typeof check.id === 'string' &&
    typeof check.cwd === 'string' &&
    path.isAbsolute(check.cwd) &&
    ['passed', 'failed', 'not-run'].includes(check.result) &&
    (check.note === undefined || (typeof check.note === 'string' && Boolean(check.note.trim())))
  );
}

function isSetupReport(value: unknown): value is NativeWorkspaceSetupReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as NativeWorkspaceSetupReport;
  return (
    Object.keys(report).every((key) => ['id', 'workspaceId', 'checks'].includes(key)) &&
    typeof report.id === 'string' &&
    typeof report.workspaceId === 'string' &&
    Array.isArray(report.checks) &&
    report.checks.length > 0 &&
    report.checks.every(isCheckResult) &&
    new Set(report.checks.map(({ id }) => id)).size === report.checks.length
  );
}

export async function readNativeWorkspaceSetupReport(
  file: string,
): Promise<NativeWorkspaceSetupReport> {
  const { bytes } = await readFileRaceSafe(path.resolve(file), Number.MAX_SAFE_INTEGER, {
    label: 'workspace setup report',
  });
  const value: unknown = JSON.parse(stripUtf8Bom(bytes.toString('utf8')));
  if (!isSetupReport(value)) throw new Error('Invalid workspace setup report');
  return value;
}

async function setupCheckCwd(root: string, ref: string): Promise<string> {
  if (ref === '.') return root;
  const inspected = await inspectProtectedProjectPath(root, ref, {
    label: 'workspace setup check directory',
    expected: 'directory',
  });
  if (!inspected.exists) throw new Error(`Workspace setup check directory is missing: ${ref}`);
  return inspected.target;
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
  const checkIds = new Set<string>();
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
      checkIds.has(check.id) ||
      check.repeatable !== true ||
      !Number.isSafeInteger(check.timeoutMs) ||
      check.timeoutMs < 1 ||
      (check.cwdRef !== '.' &&
        (normalizeWorkflowRelativePath(check.cwdRef, 'workspace setup check directory') !==
          check.cwdRef ||
          !repositories.some(
            (repo) => check.cwdRef === repo.path || check.cwdRef.startsWith(`${repo.path}/`),
          )))
    )
      throw new Error(
        'Workspace setup checks must be unique repeatable commands in the task or a declared repository',
      );
    checkIds.add(check.id);
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

/** 只读检查本地文件和工作目录，计划仅记录文件摘要。 */
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
    checks: (value.checks as NativeWorkspaceSetupCheck[] | undefined) ?? [],
  };
  validateNativeWorkspaceSetup(setup, repositories);
  await Promise.all(setup.checks.map(({ cwdRef }) => setupCheckCwd(root, cwdRef)));
  for (const entry of setup.files) {
    assertIgnoredLocalFile(root, entry.path, repositories);
    entry.hash = (
      await hashProtectedProjectFile(root, entry.path, { label: 'workspace local file' })
    ).digest;
  }
  return setup;
}

interface LegacySetupAttempt {
  id: string;
  operationId: string;
  process: { pid: number; identity?: string } | null;
  result: {
    id: string;
    status: 'passed' | 'failed' | 'interrupted';
    exitCode: number | null;
    timedOut: boolean;
    repeatable: boolean;
    logRef: string;
    logSha256: string;
  } | null;
}

/** 与工作流阶段无关的准备收据；失败重试不覆盖已经交给任务的本地配置。 */
export async function prepareNativeWorkspaceSetup(options: {
  sourceRoot: string;
  targetRoot: string;
  repositories: readonly { path: string }[];
  setup?: NativeWorkspaceSetup;
  beforeChecks?: () => Promise<void>;
  report?: NativeWorkspaceSetupReport;
}): Promise<NativeWorkspaceSetupProgress | undefined> {
  const { setup, sourceRoot, targetRoot, repositories, report } = options;
  if (!setup) {
    if (report) throw new Error('This workspace has no setup to report');
    return;
  }
  validateNativeWorkspaceSetup(setup, repositories);
  const { runtimeRoot, workspaceId } = resolveWorkspaceRuntimeLocation(targetRoot);
  const hash = canonicalHash('comet.workspace-setup.v1', setup);
  const ref = `workspace-setup/${hash}.json`;
  await fs.mkdir(runtimeRoot, { recursive: true });
  return withRecoverableFileLock(path.join(runtimeRoot, 'workspace-setup.lock'), async () => {
    let receipt: {
      schema: 'comet.workspace-setup.v1';
      hash: string;
      workspaceId: string;
      files: string[];
      attempts: LegacySetupAttempt[];
      reportId?: string;
      reports?: NativeWorkspaceSetupReport[];
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
        (receipt.reportId !== undefined && typeof receipt.reportId !== 'string') ||
        (receipt.reports !== undefined &&
          (!Array.isArray(receipt.reports) ||
            receipt.reports.some(
              (entry) =>
                !isSetupReport(entry) ||
                entry.workspaceId !== workspaceId ||
                entry.checks.some(({ id }) => !setup.checks.some((check) => check.id === id)),
            ) ||
            new Set(receipt.reports.map(({ id }) => id)).size !== receipt.reports.length)) ||
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
    const previousReport = report && receipt.reports?.find(({ id }) => id === report.id);
    if (
      report &&
      (report.workspaceId !== workspaceId ||
        (previousReport
          ? canonicalHash('setup report', previousReport) !== canonicalHash('setup report', report)
          : report.id !== receipt.reportId))
    )
      throw new Error('Workspace setup report does not match the current request');
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
    await options.beforeChecks?.();
    const checks = await Promise.all(
      setup.checks.map(async (check) => ({
        ...check,
        cwd: await setupCheckCwd(targetRoot, check.cwdRef),
      })),
    );
    const legacyAttempts = new Map(receipt.attempts.map((attempt) => [attempt.id, attempt]));
    if (report && !previousReport) {
      for (const result of report.checks) {
        const check = checks.find(({ id }) => id === result.id);
        if (!check || !samePath(result.cwd, check.cwd))
          throw new Error(`Workspace setup report check or directory does not match: ${result.id}`);
        const legacy = legacyAttempts.get(result.id);
        if (legacy && !legacy.result && !result.note)
          throw new Error(`Reconcile the original setup execution before reporting ${result.id}`);
      }
      (receipt.reports ??= []).push(report);
      receipt.reportId = randomUUID();
      await save();
    }
    const results = new Map(
      (receipt.reports ?? []).flatMap(({ checks }) => checks.map((result) => [result.id, result])),
    );
    const pending: NativeWorkspaceSetupProgress['checks'] = [];
    for (const check of checks) {
      const result = results.get(check.id);
      if (result?.result === 'passed') continue;
      const legacy = legacyAttempts.get(check.id);
      if (!result && legacy?.result?.status === 'passed') {
        const log = await hashProtectedProjectFile(runtimeRoot, legacy.result.logRef, {
          label: 'legacy workspace setup log',
        });
        if (log.digest !== legacy.result.logSha256)
          throw new Error(`Legacy workspace setup log changed: ${legacy.result.logRef}`);
        continue;
      }
      pending.push({
        ...check,
        ...(legacy && !legacy.result && !result
          ? {
              reconcile: `Inspect original workspace setup execution ${legacy.operationId} in the Agent platform before retrying or reporting its result`,
            }
          : {}),
      });
    }
    if (!receipt.reportId) {
      receipt.reportId = randomUUID();
      await save();
    }
    return {
      id: receipt.reportId,
      workspaceId,
      status: pending.length ? 'awaiting-checks' : 'ready',
      checks: pending,
    };
  });
}
