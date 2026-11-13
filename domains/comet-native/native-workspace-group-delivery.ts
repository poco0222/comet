import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import { withRecoverableFileLock } from '../../platform/fs/recoverable-file-lock.js';
import { listGitWorktrees } from '../../platform/paths/git-worktree.js';
import {
  resolveCometDataRoot,
  resolveWorkspaceIdentity,
} from '../../platform/paths/workspace-runtime.js';
import { gitStatusPaths, gitWorktreeIsClean, runGitCommand } from '../../platform/process/git.js';
import {
  hashProtectedProjectFile,
  readProtectedProjectFile,
} from '../workflow-contract/protected-project-path.js';
import { atomicWriteJson } from './native-atomic-file.js';
import { canonicalHash } from './native-canonical-hash.js';
import {
  executeNativeCheck,
  inspectNativeCheckProcessTreeLiveness,
  preflightNativeCheckPlans,
  type NativeCheckPlan,
  type NativeExecutedCheck,
} from './native-check-executor.js';
import { nativeProjectPaths } from './native-paths.js';
import { nativeRawInputSnapshot, readNativeInputExclusions } from './native-portable-checks.js';
import { isNativeCodeGraphCachePath } from './native-sensitive-paths.js';
import { copyNativeProtectedFile } from './native-protected-file.js';
import { normalizeWorkflowRelativePath } from '../workflow-contract/project-config.js';
import { registerWorkspaceGroupIntegration } from '../workflow-contract/workspace-group.js';
import {
  prepareNativeWorkspaceSetup,
  type NativeWorkspaceSetup,
} from './native-workspace-setup.js';
import {
  assertNativeWorkspaceGroupCurrent,
  type NativeWorkspaceGroup,
} from './native-workspace-group.js';

interface RepositoryDelivery {
  path: string;
  sourceHash: string;
  sourceParent: string;
  sourceTree: string | null;
  sourceCommit: string | null;
  targetCommit: string;
  targetRoot: string | null;
  targetWorkspaceId: string | null;
  integrationWorkspaceId: string | null;
  integrationCommit: string | null;
  applied: boolean;
  applyStarted: boolean;
}

interface DeliveryCheck {
  id: string;
  operationId: string;
  inputHash: string;
  process: { pid: number; identity?: string } | null;
  result: (NativeExecutedCheck & { logSha256: string }) | null;
}

export interface NativeWorkspaceGroupDelivery {
  schema: 'comet.native.workspace-group-delivery.v1';
  id: string;
  supersedes: string | null;
  groupHash: string;
  candidateId: string;
  commitMessage: string;
  checks: NativeCheckPlan[];
  artifactRootRef: string;
  rootFiles: Array<{ path: string; hash: string; mode: string; generated?: true }>;
  localFiles: NativeWorkspaceSetup['files'];
  integrationRoot: string;
  integrationRootId: string | null;
  repositories: RepositoryDelivery[];
  checkAttempts: DeliveryCheck[];
  integrationHash: string | null;
  planHash: string | null;
  status: 'preparing' | 'ready' | 'applying' | 'merged';
}

function deliveryHash(journal: NativeWorkspaceGroupDelivery): string {
  return canonicalHash('comet.native.workspace-group-delivery-plan.v1', {
    id: journal.id,
    groupHash: journal.groupHash,
    candidateId: journal.candidateId,
    repositories: journal.repositories.map(
      ({ applied: _applied, applyStarted: _started, ...entry }) => entry,
    ),
    checks: journal.checks,
    artifactRootRef: journal.artifactRootRef,
    rootFiles: journal.rootFiles,
    localFiles: journal.localFiles,
    checkAttempts: journal.checkAttempts,
    integrationRoot: journal.integrationRoot,
    integrationRootId: journal.integrationRootId,
    integrationHash: journal.integrationHash,
  });
}

async function directoryExists(root: string): Promise<boolean> {
  try {
    await fs.lstat(root);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function preparedCheckoutAlreadyWritten(root: string, receipt: RepositoryDelivery): boolean {
  if (!receipt.applyStarted || !receipt.integrationCommit) return false;
  return (
    runGitCommand(root, ['diff', '--name-only', '-z']) === '' &&
    runGitCommand(root, ['ls-files', '--others', '--exclude-standard', '-z']) === '' &&
    runGitCommand(root, ['write-tree']) ===
      runGitCommand(root, ['rev-parse', `${receipt.integrationCommit}^{tree}`])
  );
}

function targetCheckout(
  sourceRoot: string,
  branch: string,
): { root: string | null; id: string | null } {
  const entries = listGitWorktrees(sourceRoot).filter((entry) => entry.branch === branch);
  if (entries.length > 1) throw new Error(`Target branch has multiple worktrees: ${branch}`);
  const root = entries[0]?.root ?? null;
  return { root, id: root ? resolveWorkspaceIdentity(root).workspaceId : null };
}

async function repositoryInput(
  root: string,
  ref: string,
  checks: readonly NativeCheckPlan[],
  managedArtifactRoot: string,
  localFiles: readonly { path: string }[],
  exclusionRoot = ref.split('/').reduce((parent) => path.dirname(parent), root),
) {
  const prefix = `${ref}/`;
  const snapshot = await nativeRawInputSnapshot({
    projectRoot: root,
    exclusionScope: { projectRoot: exclusionRoot, relativeRoot: ref },
    managedArtifactRoot,
    includedPaths: localFiles
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => file.path.slice(prefix.length)),
    outputs: checks
      .flatMap((check) => check.outputs ?? [])
      .filter((output) => output.startsWith(prefix))
      .map((output) => output.slice(prefix.length)),
  });
  if (!snapshot.complete)
    throw new Error(
      `Delivery inputs are incomplete at ${root}: ${snapshot.diagnostics.join('; ')}`,
    );
  return snapshot;
}

function changedGitPaths(root: string, args: string[]): string[] {
  return runGitCommand(root, [...args, '--name-status', '--no-renames', '-z'])
    .split('\0')
    .filter((ref, index) => index % 2 === 1 && ref);
}

function trackedDeliveryChanges(root: string): string[] {
  return [
    ...changedGitPaths(root, ['diff', '--cached', 'HEAD']),
    ...changedGitPaths(root, ['diff-files', '--ignore-submodules=dirty']),
  ];
}

function untrackedDeliveryPaths(root: string): string[] {
  return runGitCommand(root, ['ls-files', '--others', '--exclude-standard', '-t', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(2));
}

async function rootInput(
  root: string,
  repositories: readonly { path: string }[],
  checks: readonly NativeCheckPlan[],
  artifactRootRef: string,
  exclusionRoot = root,
) {
  const snapshot = await nativeRawInputSnapshot({
    projectRoot: root,
    exclusionScope: { projectRoot: exclusionRoot },
    managedArtifactRoot: path.resolve(root, artifactRootRef),
    excludedPaths: repositories.map((entry) => entry.path),
    outputs: checks.flatMap((check) => check.outputs ?? []),
  });
  if (!snapshot.complete)
    throw new Error(`Delivery root inputs are incomplete: ${snapshot.diagnostics.join('; ')}`);
  return snapshot.files;
}

async function assertRootInput(
  root: string,
  journal: NativeWorkspaceGroupDelivery,
  exclusionRoot = root,
) {
  const files = await rootInput(
    root,
    journal.repositories,
    journal.checks,
    journal.artifactRootRef,
    exclusionRoot,
  );
  if (canonicalHash('root-files', files) !== canonicalHash('root-files', journal.rootFiles))
    throw new Error(`Delivery root inputs changed: ${root}`);
}

async function integrationFingerprint(
  journal: NativeWorkspaceGroupDelivery,
  exclusionRoot: string,
): Promise<string> {
  const repositories = [];
  if (resolveWorkspaceIdentity(journal.integrationRoot).workspaceId !== journal.integrationRootId)
    throw new Error(`Integration directory was replaced: ${journal.integrationRoot}`);
  await assertRootInput(journal.integrationRoot, journal, exclusionRoot);
  for (const entry of journal.repositories) {
    const root = path.join(journal.integrationRoot, entry.path);
    if (
      resolveWorkspaceIdentity(root).workspaceId !== entry.integrationWorkspaceId ||
      runGitCommand(root, ['rev-parse', 'HEAD']) !== entry.integrationCommit
    )
      throw new Error(`Integration worktree changed: ${root}`);
    const input = await repositoryInput(
      root,
      entry.path,
      journal.checks,
      path.resolve(journal.integrationRoot, journal.artifactRootRef),
      journal.localFiles,
      exclusionRoot,
    );
    const outputs = journal.checks
      .flatMap((check) => check.outputs ?? [])
      .filter((output) => output.startsWith(`${entry.path}/`))
      .map((output) => output.slice(entry.path.length + 1));
    const tracked = new Set(
      runGitCommand(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']).split('\0'),
    );
    if (
      (input.exclusionHash
        ? trackedDeliveryChanges(root).some(
            (ref) => !outputs.some((output) => ref === output || ref.startsWith(`${output}/`)),
          )
        : runGitCommand(root, [
            'diff',
            '--name-only',
            '-z',
            'HEAD',
            '--',
            '.',
            ...outputs.map((output) => `:(exclude,literal)${output}`),
          ])) ||
      input.files.some(
        (file) =>
          !file.generated &&
          !tracked.has(file.path) &&
          !journal.localFiles.some((local) => local.path === `${entry.path}/${file.path}`),
      )
    )
      throw new Error(
        `Integration inputs are not committed: ${root}; preserve local changes and refresh integration from the accepted candidate`,
      );
    repositories.push({
      path: entry.path,
      commit: entry.integrationCommit,
      contentHash: input.contentHash,
    });
  }
  return canonicalHash('comet.native.workspace-group-integration.v1', {
    repositories,
    rootFiles: journal.rootFiles,
  });
}

function assertJournal(journal: NativeWorkspaceGroupDelivery, group: NativeWorkspaceGroup): void {
  const commit = (value: unknown) =>
    typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value);
  const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  if (
    !journal ||
    journal.schema !== 'comet.native.workspace-group-delivery.v1' ||
    !/^[a-f0-9-]{36}$/u.test(journal.id) ||
    journal.groupHash !== group.plan.hash ||
    !['preparing', 'ready', 'applying', 'merged'].includes(journal.status) ||
    journal.integrationRoot !==
      path.join(path.dirname(group.plan.projectRoot), `.comet-integration-${journal.id}`) ||
    typeof journal.candidateId !== 'string' ||
    !journal.candidateId ||
    typeof journal.commitMessage !== 'string' ||
    !journal.commitMessage.trim() ||
    !Array.isArray(journal.checks) ||
    !Array.isArray(journal.checkAttempts) ||
    typeof journal.artifactRootRef !== 'string' ||
    !Array.isArray(journal.rootFiles) ||
    !Array.isArray(journal.localFiles) ||
    journal.localFiles.length !== (group.plan.setup?.files.length ?? 0) ||
    journal.localFiles.some(
      (file, index) =>
        !file || file.path !== group.plan.setup!.files[index].path || !hash(file.hash),
    ) ||
    journal.rootFiles.some(
      (file) => !file || !hash(file.hash) || !['100644', '100755'].includes(file.mode),
    ) ||
    !Array.isArray(journal.repositories) ||
    journal.repositories.length !== group.plan.repositories.length ||
    journal.repositories.some(
      (entry, index) =>
        !entry ||
        entry.path !== group.plan.repositories[index].path ||
        !hash(entry.sourceHash) ||
        !commit(entry.sourceParent) ||
        !commit(entry.targetCommit) ||
        (entry.sourceTree !== null && !commit(entry.sourceTree)) ||
        (entry.sourceCommit !== null && !commit(entry.sourceCommit)) ||
        (entry.integrationCommit !== null && !commit(entry.integrationCommit)) ||
        typeof entry.applied !== 'boolean' ||
        typeof entry.applyStarted !== 'boolean' ||
        (journal.status !== 'preparing' && (!entry.sourceCommit || !entry.integrationCommit)),
    )
  )
    throw new Error('Invalid Native workspace group delivery journal');
  if (
    journal.artifactRootRef !== '.' &&
    normalizeWorkflowRelativePath(journal.artifactRootRef, 'delivery artifact root') !==
      journal.artifactRootRef
  )
    throw new Error('Invalid Native delivery artifact root');
  const paths = new Set<string>();
  for (const file of journal.rootFiles) {
    if (
      normalizeWorkflowRelativePath(file.path, 'delivery root file') !== file.path ||
      paths.has(file.path) ||
      journal.repositories.some(
        (entry) => file.path === entry.path || file.path.startsWith(`${entry.path}/`),
      )
    )
      throw new Error('Invalid Native delivery root file');
    paths.add(file.path);
  }
  if (
    journal.status !== 'preparing' &&
    (!journal.planHash || journal.planHash !== deliveryHash(journal))
  )
    throw new Error('Native workspace group delivery plan hash differs from its journal');
}

async function deliveryStorage(group: NativeWorkspaceGroup, readOnly = false) {
  const paths = await nativeProjectPaths(group.plan.projectRoot, 'docs', { readOnly });
  const ref = 'group-delivery/journal.json';
  const read = async (): Promise<NativeWorkspaceGroupDelivery | null> => {
    try {
      const { bytes } = await readProtectedProjectFile(
        paths.runtimeDir,
        ref,
        Number.MAX_SAFE_INTEGER,
        { label: 'Native group delivery' },
      );
      const journal = JSON.parse(bytes.toString('utf8')) as NativeWorkspaceGroupDelivery;
      assertJournal(journal, group);
      return journal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const save = (journal: NativeWorkspaceGroupDelivery) =>
    atomicWriteJson(path.join(paths.runtimeDir, ref), journal, { containedRoot: paths.runtimeDir });
  return { paths, read, save, lease: path.join(paths.locksDir, 'group-delivery.lock') };
}

export async function inspectNativeWorkspaceGroupDelivery(
  group: NativeWorkspaceGroup,
): Promise<NativeWorkspaceGroupDelivery | null> {
  return (await deliveryStorage(group, true)).read();
}

export async function listNativeWorkspaceGroupDeliveries(
  group: NativeWorkspaceGroup,
): Promise<NativeWorkspaceGroupDelivery[]> {
  const io = await deliveryStorage(group, true);
  const current = await io.read();
  if (!current) return [];
  const result = [current];
  const seen = new Set([current.id]);
  let previous = current.supersedes;
  while (previous) {
    if (!/^[a-f0-9-]{36}$/u.test(previous) || seen.has(previous))
      throw new Error('Invalid Native delivery history');
    const { bytes } = await readProtectedProjectFile(
      io.paths.runtimeDir,
      `group-delivery/history/${previous}.json`,
      Number.MAX_SAFE_INTEGER,
      { label: 'Native delivery history' },
    );
    const journal = JSON.parse(bytes.toString('utf8')) as NativeWorkspaceGroupDelivery;
    assertJournal(journal, group);
    if (journal.id !== previous) throw new Error('Native delivery history identity changed');
    seen.add(previous);
    result.push(journal);
    previous = journal.supersedes;
  }
  return result;
}

async function assertDeliveryChecks(journal: NativeWorkspaceGroupDelivery, runtimeDir: string) {
  for (const plan of journal.checks) {
    const attempt = journal.checkAttempts.filter((entry) => entry.id === plan.id).at(-1);
    if (
      !attempt?.result ||
      attempt.result.status !== 'passed' ||
      attempt.inputHash !== journal.integrationHash
    )
      throw new Error(`Integration check has no current passing result: ${plan.id}`);
    const log = await hashProtectedProjectFile(runtimeDir, attempt.result.logRef, {
      label: 'Native integration check log',
    });
    if (log.digest !== attempt.result.logSha256)
      throw new Error(`Integration check log changed: ${attempt.result.logRef}`);
  }
}

/** Commit only the accepted task bytes, then verify the actual merged trees before any target update. */
export async function prepareNativeWorkspaceGroupDelivery(options: {
  group: NativeWorkspaceGroup;
  candidateId: string;
  commitMessage: string;
  checks: NativeCheckPlan[];
  artifactRootRef?: string;
  refreshDeliveryId?: string;
  validateCandidate?: () => Promise<void>;
}): Promise<NativeWorkspaceGroupDelivery> {
  const { group } = options;
  const artifactRootRef = options.artifactRootRef ?? 'docs';
  if (
    artifactRootRef !== '.' &&
    normalizeWorkflowRelativePath(artifactRootRef, 'delivery artifact root') !== artifactRootRef
  )
    throw new Error('Invalid Native delivery artifact root');
  await assertNativeWorkspaceGroupCurrent(group);
  if (
    !options.candidateId ||
    !options.commitMessage.trim() ||
    options.checks.some((check) => !check.repeatable)
  )
    throw new Error(
      'Group delivery requires an accepted candidate, a commit message and repeatable integration checks',
    );
  await preflightNativeCheckPlans(group.plan.projectRoot, options.checks);
  const storage = await deliveryStorage(group);
  return withRecoverableFileLock(storage.lease, async () => {
    let journal = await storage.read();
    if (!journal && options.refreshDeliveryId)
      throw new Error('Refresh requires an existing unfinished delivery');
    if (
      journal &&
      (journal.candidateId !== options.candidateId ||
        journal.artifactRootRef !== artifactRootRef ||
        journal.commitMessage !== options.commitMessage ||
        canonicalHash('checks', journal.checks) !== canonicalHash('checks', options.checks))
    )
      throw new Error('Delivery request differs from the original candidate or check plan');
    const exclusions = await readNativeInputExclusions(group.plan.projectRoot);
    const excludedFromDelivery = (repository: string, ref: string) =>
      exclusions.matches(`${repository}/${ref}`) || isNativeCodeGraphCachePath(ref);
    const assertExcludedPathsUnchanged = (
      entry: NativeWorkspaceGroup['plan']['repositories'][number],
    ) => {
      const changed = changedGitPaths(entry.worktreeRoot, [
        'diff',
        '--cached',
        entry.baseCommit,
      ]).find((ref) => excludedFromDelivery(entry.path, ref));
      if (changed)
        throw new Error(
          `Changed file is excluded from accepted delivery inputs: ${entry.path}/${changed}`,
        );
    };
    group.plan.repositories.forEach(assertExcludedPathsUnchanged);
    if (!journal) {
      const id = randomUUID();
      const repositories: RepositoryDelivery[] = [];
      const localFiles: NativeWorkspaceSetup['files'] = [];
      for (const entry of group.plan.repositories) {
        runGitCommand(entry.worktreeRoot, [
          'merge-base',
          '--is-ancestor',
          entry.baseCommit,
          'HEAD',
        ]);
        const input = await repositoryInput(
          entry.worktreeRoot,
          entry.path,
          options.checks,
          path.resolve(group.plan.projectRoot, artifactRootRef),
          group.plan.setup?.files ?? [],
        );
        for (const file of group.plan.setup?.files ?? []) {
          if (!file.path.startsWith(`${entry.path}/`)) continue;
          const observed = input.files.find(
            (item) => item.path === file.path.slice(entry.path.length + 1),
          );
          if (!observed) throw new Error(`Missing accepted local setup file: ${file.path}`);
          localFiles.push({ path: file.path, hash: observed.hash });
        }
        const checkout = targetCheckout(entry.sourceRoot, entry.targetBranch);
        repositories.push({
          path: entry.path,
          sourceHash: input.contentHash,
          sourceParent: runGitCommand(entry.worktreeRoot, ['rev-parse', 'HEAD']),
          sourceTree: null,
          sourceCommit: null,
          targetCommit: runGitCommand(entry.sourceRoot, [
            'rev-parse',
            `refs/heads/${entry.targetBranch}`,
          ]),
          targetRoot: checkout.root,
          targetWorkspaceId: checkout.id,
          integrationWorkspaceId: null,
          integrationCommit: null,
          applied: false,
          applyStarted: false,
        });
      }
      const rootFiles = await rootInput(
        group.plan.projectRoot,
        repositories,
        options.checks,
        artifactRootRef,
      );
      await options.validateCandidate?.();
      journal = {
        schema: 'comet.native.workspace-group-delivery.v1',
        id,
        supersedes: null,
        groupHash: group.plan.hash,
        candidateId: options.candidateId,
        commitMessage: options.commitMessage,
        checks: options.checks,
        artifactRootRef,
        rootFiles,
        localFiles: (group.plan.setup?.files ?? []).map((file) =>
          localFiles.find((observed) => observed.path === file.path)!,
        ),
        integrationRoot: path.join(
          path.dirname(group.plan.projectRoot),
          `.comet-integration-${id}`,
        ),
        integrationRootId: null,
        repositories,
        checkAttempts: [],
        integrationHash: null,
        planHash: null,
        status: 'preparing',
      };
      await storage.save(journal);
    }
    await assertRootInput(group.plan.projectRoot, journal);
    if (options.refreshDeliveryId && journal.supersedes !== options.refreshDeliveryId) {
      if (journal.id !== options.refreshDeliveryId || journal.status === 'merged')
        throw new Error('Refresh requires the exact unfinished delivery ID');
      for (const attempt of journal.checkAttempts) {
        if (
          attempt.process &&
          !attempt.result &&
          (await inspectNativeCheckProcessTreeLiveness(
            attempt.process.pid,
            attempt.process.identity,
          )) !== 'dead'
        )
          throw new Error(`Integration check may still be running: ${attempt.operationId}`);
      }
      const repositories: RepositoryDelivery[] = [];
      for (const [index, entry] of group.plan.repositories.entries()) {
        const receipt = journal.repositories[index];
        if (
          !receipt.sourceCommit ||
          runGitCommand(entry.worktreeRoot, ['rev-parse', 'HEAD']) !== receipt.sourceCommit ||
          (
            await repositoryInput(
              entry.worktreeRoot,
              entry.path,
              journal.checks,
              path.resolve(group.plan.projectRoot, journal.artifactRootRef),
              journal.localFiles,
            )
          ).contentHash !== receipt.sourceHash
        )
          throw new Error(`Refresh requires the unchanged prepared candidate: ${entry.path}`);
        const targetCommit = runGitCommand(entry.sourceRoot, [
          'rev-parse',
          `refs/heads/${entry.targetBranch}`,
        ]);
        if (receipt.applied || (receipt.applyStarted && targetCommit !== receipt.targetCommit)) {
          try {
            runGitCommand(entry.sourceRoot, [
              'merge-base',
              '--is-ancestor',
              receipt.integrationCommit!,
              targetCommit,
            ]);
          } catch (error) {
            throw new Error(
              `Delivery target no longer contains the possibly published commit: ${entry.path}:${entry.targetBranch}; inspect ${receipt.integrationCommit} before refreshing`,
              { cause: error },
            );
          }
        }
        const checkout = targetCheckout(entry.sourceRoot, entry.targetBranch);
        if (checkout.root && !gitWorktreeIsClean(checkout.root))
          throw new Error(
            `Delivery target is dirty: ${checkout.root}; finish recovery of the original plan before refreshing`,
          );
        repositories.push({
          ...receipt,
          targetCommit,
          targetRoot: checkout.root,
          targetWorkspaceId: checkout.id,
          integrationWorkspaceId: null,
          integrationCommit: null,
          applied: false,
          applyStarted: false,
        });
      }
      // Preserve failed checks, conflicts and partial publication receipts for diagnosis.
      await atomicWriteJson(
        path.join(storage.paths.runtimeDir, 'group-delivery/history', `${journal.id}.json`),
        journal,
        { containedRoot: storage.paths.runtimeDir },
      );
      const id = randomUUID();
      journal = {
        ...journal,
        id,
        supersedes: journal.id,
        repositories,
        integrationRoot: path.join(
          path.dirname(group.plan.projectRoot),
          `.comet-integration-${id}`,
        ),
        integrationRootId: null,
        integrationHash: null,
        planHash: null,
        checkAttempts: [],
        status: 'preparing',
      };
      await storage.save(journal);
    }
    const save = () => storage.save(journal!);
    for (const [index, entry] of group.plan.repositories.entries()) {
      const receipt = journal.repositories[index];
      const input = await repositoryInput(
        entry.worktreeRoot,
        entry.path,
        journal.checks,
        path.resolve(group.plan.projectRoot, journal.artifactRootRef),
        journal.localFiles,
      );
      if (input.exclusionHash !== exclusions.hash)
        throw new Error(
          'Native input exclusions changed during delivery; verify the current candidate',
        );
      if (input.contentHash !== receipt.sourceHash)
        throw new Error(
          `Accepted task content changed: ${entry.worktreeRoot}; return to Native verification before delivery`,
        );
      const head = runGitCommand(entry.worktreeRoot, ['rev-parse', 'HEAD']);
      if (receipt.sourceCommit) {
        if (head !== receipt.sourceCommit)
          throw new Error(`Task branch changed after delivery preparation: ${entry.worktreeRoot}`);
        continue;
      }
      const message = `${journal.commitMessage}\n\nComet-Delivery: ${journal.id}\nComet-Candidate: ${journal.candidateId}`;
      if (head !== receipt.sourceParent) {
        if (
          !receipt.sourceTree ||
          runGitCommand(entry.worktreeRoot, ['show', '-s', '--format=%P', head]) !==
            receipt.sourceParent ||
          runGitCommand(entry.worktreeRoot, ['rev-parse', `${head}^{tree}`]) !==
            receipt.sourceTree ||
          runGitCommand(entry.worktreeRoot, ['show', '-s', '--format=%B', head]) !== message
        )
          throw new Error(`Unrecorded task commit differs from delivery: ${entry.worktreeRoot}`);
      } else {
        assertExcludedPathsUnchanged(entry);
        const changed = exclusions.hash
          ? [
              ...new Set([
                ...trackedDeliveryChanges(entry.worktreeRoot),
                ...untrackedDeliveryPaths(entry.worktreeRoot),
              ]),
            ]
          : gitStatusPaths(entry.worktreeRoot);
        const tracked = new Set(runGitCommand(entry.worktreeRoot, ['ls-files', '-z']).split('\0'));
        const accepted = new Set(
          input.files.filter((file) => !file.generated).map((file) => file.path),
        );
        const stage: string[] = [];
        for (const ref of changed) {
          if (excludedFromDelivery(entry.path, ref)) continue;
          if (
            accepted.has(ref) ||
            (tracked.has(ref) && !(await directoryExists(path.join(entry.worktreeRoot, ref))))
          )
            stage.push(ref);
          else if (tracked.has(ref))
            throw new Error(
              `Changed tracked file is outside accepted delivery inputs: ${entry.path}/${ref}`,
            );
        }
        if (stage.length)
          runGitCommand(entry.worktreeRoot, ['--literal-pathspecs', 'add', '-A', '--', ...stage]);
        receipt.sourceTree = runGitCommand(entry.worktreeRoot, ['write-tree']);
        await save();
        if (receipt.sourceTree !== runGitCommand(entry.worktreeRoot, ['rev-parse', 'HEAD^{tree}']))
          runGitCommand(entry.worktreeRoot, ['commit', '-m', message]);
      }
      receipt.sourceCommit = runGitCommand(entry.worktreeRoot, ['rev-parse', 'HEAD']);
      if (
        runGitCommand(entry.worktreeRoot, ['rev-parse', 'HEAD^{tree}']) !== receipt.sourceTree ||
        (
          await repositoryInput(
            entry.worktreeRoot,
            entry.path,
            journal.checks,
            path.resolve(group.plan.projectRoot, journal.artifactRootRef),
            journal.localFiles,
          )
        ).contentHash !== receipt.sourceHash
      )
        throw new Error(`Commit changed accepted task inputs: ${entry.worktreeRoot}`);
      await save();
    }
    if (journal.status !== 'preparing') {
      await registerWorkspaceGroupIntegration(
        group.plan.projectRoot,
        journal.integrationRoot,
        journal.id,
      );
      if (
        (await integrationFingerprint(journal, group.plan.projectRoot)) !== journal.integrationHash
      )
        throw new Error('Verified integration inputs changed; prepare a new integration round');
      await assertDeliveryChecks(journal, storage.paths.runtimeDir);
      return journal;
    }
    if (!journal.integrationRootId) {
      if (await directoryExists(journal.integrationRoot))
        throw new Error(
          `Integration directory has no recorded identity: ${journal.integrationRoot}; inspect it before recovery`,
        );
      await fs.mkdir(journal.integrationRoot, { mode: 0o700 });
      journal.integrationRootId = resolveWorkspaceIdentity(journal.integrationRoot).workspaceId;
      await save();
    }
    if (resolveWorkspaceIdentity(journal.integrationRoot).workspaceId !== journal.integrationRootId)
      throw new Error('Integration directory identity changed');
    await registerWorkspaceGroupIntegration(
      group.plan.projectRoot,
      journal.integrationRoot,
      journal.id,
    );
    for (const file of journal.rootFiles) {
      const target = path.join(journal.integrationRoot, file.path);
      if (await directoryExists(target)) {
        const existing = await hashProtectedProjectFile(journal.integrationRoot, file.path, {
          label: 'Delivery root input',
        });
        if (existing.digest !== file.hash)
          throw new Error(`Integration root input changed: ${file.path}`);
        continue;
      }
      await copyNativeProtectedFile({
        sourceRoot: group.plan.projectRoot,
        source: path.join(group.plan.projectRoot, file.path),
        targetRoot: journal.integrationRoot,
        target,
        maxBytes: null,
        label: `Delivery root input ${file.path}`,
        expectedHash: file.hash,
        expectedTargetHash: null,
        exclusive: true,
      });
      if (file.mode === '100755') {
        const handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          await handle.chmod(0o755);
        } finally {
          await handle.close();
        }
      }
    }
    for (const [index, entry] of group.plan.repositories.entries()) {
      const receipt = journal.repositories[index];
      const root = path.join(journal.integrationRoot, entry.path);
      if (!receipt.integrationWorkspaceId) {
        if (await directoryExists(root))
          throw new Error(
            `Integration worktree has no recorded identity: ${root}; inspect it before recovery`,
          );
        runGitCommand(entry.sourceRoot, [
          'worktree',
          'add',
          '--detach',
          root,
          receipt.targetCommit,
        ]);
        receipt.integrationWorkspaceId = resolveWorkspaceIdentity(root).workspaceId;
        await save();
      }
      if (resolveWorkspaceIdentity(root).workspaceId !== receipt.integrationWorkspaceId)
        throw new Error(`Integration worktree was replaced: ${root}`);
      if (!receipt.integrationCommit) {
        if (
          exclusions.hash
            ? trackedDeliveryChanges(root).length > 0 || untrackedDeliveryPaths(root).length > 0
            : !gitWorktreeIsClean(root)
        )
          throw new Error(
            `Integration has unresolved changes: ${root}; inspect git status and preserve conflict evidence`,
          );
        const head = runGitCommand(root, ['rev-parse', 'HEAD']);
        if (
          head === receipt.targetCommit &&
          receipt.sourceTree !==
            runGitCommand(entry.sourceRoot, ['rev-parse', `${entry.baseCommit}^{tree}`])
        )
          runGitCommand(root, [
            'merge',
            '--no-ff',
            '--no-edit',
            '--no-overwrite-ignore',
            receipt.sourceCommit!,
          ]);
        else if (
          head !== receipt.targetCommit &&
          runGitCommand(root, ['show', '-s', '--format=%P', head]) !==
            `${receipt.targetCommit} ${receipt.sourceCommit}`
        )
          throw new Error(`Unrecorded integration commit differs: ${root}`);
        receipt.integrationCommit = runGitCommand(root, ['rev-parse', 'HEAD']);
        await save();
      }
    }
    if (group.plan.setup) {
      let beforeSetup: string | undefined;
      await prepareNativeWorkspaceSetup({
        sourceRoot: group.plan.projectRoot,
        targetRoot: journal.integrationRoot,
        repositories: journal.repositories,
        setup: { ...group.plan.setup, files: journal.localFiles },
        beforeChecks: async () => {
          beforeSetup = await integrationFingerprint(journal!, group.plan.projectRoot);
        },
      });
      if (beforeSetup !== (await integrationFingerprint(journal, group.plan.projectRoot)))
        throw new Error(
          'Workspace setup changed integration inputs; preserve the prepared candidate before retrying',
        );
    }
    await preflightNativeCheckPlans(journal.integrationRoot, journal.checks);
    const before = await integrationFingerprint(journal, group.plan.projectRoot);
    for (const plan of journal.checks) {
      const previous = journal.checkAttempts.filter((attempt) => attempt.id === plan.id).at(-1);
      if (previous?.result?.status === 'passed' && previous.inputHash === before) continue;
      if (
        previous?.process &&
        !previous.result &&
        (await inspectNativeCheckProcessTreeLiveness(
          previous.process.pid,
          previous.process.identity,
        )) !== 'dead'
      )
        throw new Error(
          `Integration check may still be running: ${previous.operationId}; inspect the recorded process before retrying`,
        );
      const attempt: DeliveryCheck = {
        id: plan.id,
        operationId: randomUUID(),
        inputHash: before,
        process: null,
        result: null,
      };
      journal.checkAttempts.push(attempt);
      journal.integrationHash = before;
      await save();
      attempt.result = await executeNativeCheck({
        projectRoot: journal.integrationRoot,
        runtimeDir: storage.paths.runtimeDir,
        operationId: attempt.operationId,
        plan,
        onSpawn: async (process) => {
          attempt.process = {
            pid: process.pid,
            ...(process.identity === undefined ? {} : { identity: process.identity }),
          };
          await save();
        },
      });
      await save();
      if (attempt.result.status !== 'passed')
        throw new Error(
          `Integration check failed: ${plan.id}; log: ${attempt.result.logRef}; retry the same delivery after correcting the task and verifying its candidate`,
        );
      if ((await integrationFingerprint(journal, group.plan.projectRoot)) !== before)
        throw new Error(
          'Integration checks changed implementation inputs; no target branches were updated',
        );
    }
    journal.integrationHash = before;
    await assertDeliveryChecks(journal, storage.paths.runtimeDir);
    journal.status = 'ready';
    journal.planHash = deliveryHash(journal);
    await save();
    return journal;
  });
}

/** Cross-repository updates are journaled individually; a partial merge is never rolled back. */
export async function applyNativeWorkspaceGroupDelivery(
  group: NativeWorkspaceGroup,
  expectedPlanHash: string,
): Promise<NativeWorkspaceGroupDelivery> {
  await assertNativeWorkspaceGroupCurrent(group);
  const storage = await deliveryStorage(group);
  return withRecoverableFileLock(storage.lease, async () => {
    const journal = await storage.read();
    if (!journal || journal.status === 'preparing' || journal.planHash !== expectedPlanHash)
      throw new Error('Prepare and verify the exact delivery plan before applying it');
    const lockFiles = group.plan.repositories
      .map((entry) =>
        path.join(
          resolveCometDataRoot(),
          'git-delivery-locks',
          `${canonicalHash('git-target', [entry.commonDir, entry.targetBranch])}.lock`,
        ),
      )
      .sort();
    const apply = async (index: number): Promise<NativeWorkspaceGroupDelivery> => {
      if (index < lockFiles.length)
        return withRecoverableFileLock(lockFiles[index], () => apply(index + 1));
      await assertRootInput(group.plan.projectRoot, journal);
      if (
        (await integrationFingerprint(journal, group.plan.projectRoot)) !== journal.integrationHash
      )
        throw new Error('Integration inputs changed after verification');
      await assertDeliveryChecks(journal, storage.paths.runtimeDir);
      for (const [position, entry] of group.plan.repositories.entries()) {
        const receipt = journal.repositories[position];
        if (
          (
            await repositoryInput(
              entry.worktreeRoot,
              entry.path,
              journal.checks,
              path.resolve(group.plan.projectRoot, journal.artifactRootRef),
              journal.localFiles,
            )
          ).contentHash !== receipt.sourceHash ||
          runGitCommand(entry.worktreeRoot, ['rev-parse', 'HEAD']) !== receipt.sourceCommit
        )
          throw new Error(`Task candidate changed before merge: ${entry.path}`);
        const current = runGitCommand(entry.sourceRoot, [
          'rev-parse',
          `refs/heads/${entry.targetBranch}`,
        ]);
        if (receipt.applied || current === receipt.integrationCommit) {
          runGitCommand(entry.sourceRoot, [
            'merge-base',
            '--is-ancestor',
            receipt.integrationCommit!,
            current,
          ]);
          if (journal.status !== 'merged' && current !== receipt.integrationCommit)
            throw new Error(
              `Delivery target moved after partial publication: ${entry.path}:${entry.targetBranch}; refresh integration and rerun its checks`,
            );
          continue;
        }
        const checkout = targetCheckout(entry.sourceRoot, entry.targetBranch);
        if (
          current !== receipt.targetCommit ||
          checkout.root !== receipt.targetRoot ||
          checkout.id !== receipt.targetWorkspaceId
        )
          throw new Error(
            `Delivery target moved: ${entry.path}:${entry.targetBranch}; rebuild integration and rerun its checks`,
          );
        if (
          checkout.root &&
          !gitWorktreeIsClean(checkout.root) &&
          !preparedCheckoutAlreadyWritten(checkout.root, receipt)
        )
          throw new Error(
            `Delivery target is dirty: ${checkout.root}; preserve or finish those changes before retrying this plan`,
          );
      }
      journal.status = 'applying';
      await storage.save(journal);
      for (const [position, entry] of group.plan.repositories.entries()) {
        const receipt = journal.repositories[position];
        if (receipt.applied) continue;
        const current = runGitCommand(entry.sourceRoot, [
          'rev-parse',
          `refs/heads/${entry.targetBranch}`,
        ]);
        if (current !== receipt.integrationCommit) {
          if (current !== receipt.targetCommit)
            throw new Error(`Delivery target moved during merge: ${entry.path}`);
          const checkout = targetCheckout(entry.sourceRoot, entry.targetBranch);
          if (checkout.root !== receipt.targetRoot || checkout.id !== receipt.targetWorkspaceId)
            throw new Error(`Delivery target checkout changed: ${entry.path}`);
          if (checkout.root) {
            const recoverCheckout = preparedCheckoutAlreadyWritten(checkout.root, receipt);
            if (!gitWorktreeIsClean(checkout.root) && !recoverCheckout)
              throw new Error(`Delivery target became dirty: ${checkout.root}`);
            receipt.applyStarted = true;
            await storage.save(journal);
            if (recoverCheckout)
              runGitCommand(checkout.root, [
                'update-ref',
                `refs/heads/${entry.targetBranch}`,
                receipt.integrationCommit!,
                receipt.targetCommit,
              ]);
            else
              runGitCommand(checkout.root, [
                'merge',
                '--ff-only',
                '--no-overwrite-ignore',
                receipt.integrationCommit!,
              ]);
          } else {
            receipt.applyStarted = true;
            await storage.save(journal);
            runGitCommand(entry.sourceRoot, [
              'update-ref',
              `refs/heads/${entry.targetBranch}`,
              receipt.integrationCommit!,
              receipt.targetCommit,
            ]);
          }
        }
        if (
          runGitCommand(entry.sourceRoot, ['rev-parse', `refs/heads/${entry.targetBranch}`]) !==
          receipt.integrationCommit
        )
          throw new Error(`Delivery target did not retain its prepared commit: ${entry.path}`);
        receipt.applied = true;
        await storage.save(journal);
      }
      journal.status = 'merged';
      await storage.save(journal);
      return journal;
    };
    return apply(0);
  });
}
