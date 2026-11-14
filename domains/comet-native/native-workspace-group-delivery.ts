import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import { withRecoverableFileLock } from '../../platform/fs/recoverable-file-lock.js';
import { listGitWorktrees } from '../../platform/paths/git-worktree.js';
import {
  resolveCometDataRoot,
  resolveWorkspaceIdentity,
} from '../../platform/paths/workspace-runtime.js';
import { gitWorktreeIsClean, runGitCommand } from '../../platform/process/git.js';
import {
  hashProtectedProjectFile,
  inspectProtectedProjectPath,
  readProtectedProjectFile,
} from '../workflow-contract/protected-project-path.js';
import { atomicWriteJson } from './native-atomic-file.js';
import { canonicalHash } from './native-canonical-hash.js';
import { nativeProjectPaths } from './native-paths.js';
import {
  captureNativeWorkspaceDeliverySetupFiles,
  captureNativeWorkspaceDeliveryRootFiles,
  captureNativeWorkspaceDeliveryTrees,
  nativeWorkspaceDeliveryPaths,
} from './native-workspace-delivery-binding.js';
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
  sourceHash?: string;
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

interface LegacyDeliveryCheck {
  id: string;
  operationId: string;
  inputHash: string;
  process: { pid: number; identity?: string } | null;
  result: { status: string; logRef: string; logSha256: string } | null;
}

interface DeliveryCheckRequirement {
  id: string;
  name: string;
  cwdRef?: string;
  executable?: string;
  argv?: string[];
}

interface DeliveryCheckReport {
  deliveryId: string;
  planHash: string;
  checks: Array<{
    id: string;
    command?: string;
    actualCommand?: { executable: string; argv: string[] };
    cwd: string;
    result: 'passed' | 'failed' | 'not-run';
    note?: string;
  }>;
  noChecksReason?: string;
  legacyReconciliation?: string;
}

interface DeliveryJournal {
  id: string;
  supersedes: string | null;
  groupHash: string;
  candidateId: string;
  commitMessage: string;
  artifactRootRef: string;
  rootFiles: Array<{ path: string; hash: string; mode: string; generated?: true }>;
  localFiles: NativeWorkspaceSetup['files'];
  integrationRoot: string;
  integrationRootId: string | null;
  repositories: RepositoryDelivery[];
  planHash: string | null;
}

interface LegacyDeliveryJournal extends DeliveryJournal {
  schema: 'comet.native.workspace-group-delivery.v1';
  checks: Array<{ id: string; name: string; cwdRef: string; executable: string; argv: string[] }>;
  checkAttempts: LegacyDeliveryCheck[];
  integrationHash: string | null;
  status: 'preparing' | 'ready' | 'applying' | 'merged';
}

interface ReportedDeliveryJournal extends DeliveryJournal {
  schema: 'comet.native.workspace-group-delivery.v2';
  checks: DeliveryCheckRequirement[];
  reports: DeliveryCheckReport[];
  legacyPlanHash?: string;
  legacyUnconfirmed?: string[];
  legacyRootFiles?: true;
  status: 'preparing' | 'awaiting-checks' | 'ready' | 'applying' | 'merged';
}

export type NativeWorkspaceGroupDelivery = LegacyDeliveryJournal | ReportedDeliveryJournal;

function isLegacy(journal: NativeWorkspaceGroupDelivery): journal is LegacyDeliveryJournal {
  return journal.schema === 'comet.native.workspace-group-delivery.v1';
}

function deliveryHash(journal: NativeWorkspaceGroupDelivery): string {
  const repositories = journal.repositories.map(
    ({ applied: _applied, applyStarted: _started, ...entry }) => entry,
  );
  if (isLegacy(journal)) {
    return canonicalHash('comet.native.workspace-group-delivery-plan.v1', {
      id: journal.id,
      groupHash: journal.groupHash,
      candidateId: journal.candidateId,
      repositories,
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
  return canonicalHash('comet.native.workspace-group-delivery-plan.v2', {
    id: journal.id,
    groupHash: journal.groupHash,
    candidateId: journal.candidateId,
    repositories,
    checks: journal.checks,
    artifactRootRef: journal.artifactRootRef,
    rootFiles: journal.rootFiles,
    localFiles: journal.localFiles,
    integrationRoot: journal.integrationRoot,
    integrationRootId: journal.integrationRootId,
    reports: journal.reports,
  });
}

export function nativeWorkspaceDeliveryReportTemplate(journal: NativeWorkspaceGroupDelivery) {
  if (isLegacy(journal) || !['awaiting-checks', 'ready'].includes(journal.status)) return null;
  return {
    deliveryId: journal.id,
    planHash: deliveryHash(journal),
    checks: [...journal.checks]
      .sort((a, b) => Number(b.id.startsWith('setup:')) - Number(a.id.startsWith('setup:')))
      .map((check) => ({
        id: check.id,
        name: check.name,
        cwd: path.resolve(journal.integrationRoot, check.cwdRef ?? '.'),
        ...(check.executable
          ? {
              executable: check.executable,
              argv: check.argv,
              actualCommand: { executable: '', argv: [] },
            }
          : {}),
        command: '',
        result: 'not-run',
        note: '',
      })),
    ...(journal.checks.length ? {} : { noChecksReason: '' }),
    ...(journal.legacyUnconfirmed?.length && !journal.reports.some((r) => r.legacyReconciliation)
      ? { legacyUnconfirmed: journal.legacyUnconfirmed, legacyReconciliation: '' }
      : {}),
  };
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

function repositoryHead(root: string): string {
  return runGitCommand(root, ['rev-parse', 'HEAD']);
}

function gitTree(root: string, commit: string): string {
  return runGitCommand(root, ['rev-parse', `${commit}^{tree}`]);
}

async function assertRootInput(
  group: NativeWorkspaceGroup,
  journal: NativeWorkspaceGroupDelivery,
  root = group.plan.projectRoot,
) {
  if (!isLegacy(journal) && !journal.legacyRootFiles) {
    const files = await captureNativeWorkspaceDeliveryRootFiles(group, root);
    if (canonicalHash('root-files', files) !== canonicalHash('root-files', journal.rootFiles))
      throw new Error(`Delivery root inputs changed: ${root}`);
    return;
  }
  for (const file of journal.rootFiles) {
    const observed = await hashProtectedProjectFile(root, file.path, {
      label: 'Delivery root input',
    });
    if (observed.digest !== file.hash)
      throw new Error(`Delivery root inputs changed: ${root}/${file.path}`);
  }
}

async function assertLocalInputs(journal: NativeWorkspaceGroupDelivery, root: string) {
  for (const file of journal.localFiles) {
    const observed = await hashProtectedProjectFile(root, file.path, {
      label: 'Delivery local input',
    });
    if (observed.digest !== file.hash)
      throw new Error(`Delivery local inputs changed: ${root}/${file.path}`);
  }
}

async function assertIntegration(group: NativeWorkspaceGroup, journal: ReportedDeliveryJournal) {
  if (resolveWorkspaceIdentity(journal.integrationRoot).workspaceId !== journal.integrationRootId)
    throw new Error(`Integration directory was replaced: ${journal.integrationRoot}`);
  await assertRootInput(group, journal, journal.integrationRoot);
  await assertLocalInputs(journal, journal.integrationRoot);
  for (const entry of journal.repositories) {
    const root = path.join(journal.integrationRoot, entry.path);
    if (
      resolveWorkspaceIdentity(root).workspaceId !== entry.integrationWorkspaceId ||
      repositoryHead(root) !== entry.integrationCommit
    )
      throw new Error(`Integration worktree changed: ${root}`);
    if (!gitWorktreeIsClean(root))
      throw new Error(
        `Integration inputs are not committed: ${root}; preserve local changes and refresh integration from the accepted candidate`,
      );
  }
}

async function assertSource(group: NativeWorkspaceGroup, journal: ReportedDeliveryJournal) {
  await assertRootInput(group, journal);
  await assertLocalInputs(journal, group.plan.projectRoot);
  const trees = await captureNativeWorkspaceDeliveryTrees(group);
  for (const [index, entry] of group.plan.repositories.entries()) {
    const receipt = journal.repositories[index];
    if (
      repositoryHead(entry.worktreeRoot) !== receipt.sourceCommit ||
      trees[index].tree !== receipt.sourceTree
    )
      throw new Error(`Task candidate changed before merge: ${entry.path}`);
  }
}

function targetHead(entry: NativeWorkspaceGroup['plan']['repositories'][number]): string {
  return runGitCommand(entry.sourceRoot, ['rev-parse', `refs/heads/${entry.targetBranch}`]);
}

function assertTargetRefs(group: NativeWorkspaceGroup, journal: NativeWorkspaceGroupDelivery) {
  for (const [index, entry] of group.plan.repositories.entries()) {
    const receipt = journal.repositories[index];
    const current = targetHead(entry);
    if (journal.status === 'merged') {
      runGitCommand(entry.sourceRoot, [
        'merge-base',
        '--is-ancestor',
        receipt.integrationCommit!,
        current,
      ]);
    } else if (receipt.applied || (receipt.applyStarted && current !== receipt.targetCommit)) {
      if (current !== receipt.integrationCommit)
        throw new Error(
          `Delivery target moved after partial publication: ${entry.path}:${entry.targetBranch}; refresh integration and rerun its checks`,
        );
    } else if (current !== receipt.targetCommit) {
      throw new Error(
        `Delivery target moved: ${entry.path}:${entry.targetBranch}; rebuild integration and rerun its checks`,
      );
    }
  }
}

function assertJournal(journal: NativeWorkspaceGroupDelivery, group: NativeWorkspaceGroup): void {
  const commit = (value: unknown) =>
    typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value);
  const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  if (
    !journal ||
    ![
      'comet.native.workspace-group-delivery.v1',
      'comet.native.workspace-group-delivery.v2',
    ].includes(journal.schema) ||
    !/^[a-f0-9-]{36}$/u.test(journal.id) ||
    journal.groupHash !== group.plan.hash ||
    !['preparing', 'awaiting-checks', 'ready', 'applying', 'merged'].includes(journal.status) ||
    journal.integrationRoot !==
      path.join(path.dirname(group.plan.projectRoot), `.comet-integration-${journal.id}`) ||
    typeof journal.candidateId !== 'string' ||
    !journal.candidateId ||
    typeof journal.commitMessage !== 'string' ||
    !journal.commitMessage.trim() ||
    !Array.isArray(journal.checks) ||
    (isLegacy(journal) ? !Array.isArray(journal.checkAttempts) : !Array.isArray(journal.reports)) ||
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
        (isLegacy(journal) && !hash(entry.sourceHash)) ||
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
    ['ready', 'applying', 'merged'].includes(journal.status) &&
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
  return {
    paths,
    read,
    save,
    lease: path.join(paths.runtimeDir, 'locks', 'group-delivery.lock'),
  };
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

interface DeliveryCandidateInputs {
  trees: readonly { path: string; head: string; tree: string }[];
  rootFiles: DeliveryJournal['rootFiles'];
  localFiles: DeliveryJournal['localFiles'];
}

function sourceCommitMessage(journal: DeliveryJournal) {
  return `${journal.commitMessage}

Comet-Delivery: ${journal.id}
Comet-Candidate: ${journal.candidateId}`;
}

function isOriginalSourceCommit(
  root: string,
  head: string,
  receipt: RepositoryDelivery,
  journal: DeliveryJournal,
) {
  return (
    runGitCommand(root, ['show', '-s', '--format=%P', head]) === receipt.sourceParent &&
    gitTree(root, head) === receipt.sourceTree &&
    runGitCommand(root, ['show', '-s', '--format=%B', head]) === sourceCommitMessage(journal)
  );
}

async function preserveLegacyJournal(
  group: NativeWorkspaceGroup,
  journal: LegacyDeliveryJournal,
  runtimeDir: string,
  validateCandidate?: () => Promise<void | DeliveryCandidateInputs>,
): Promise<ReportedDeliveryJournal> {
  await assertRootInput(group, journal);
  await assertLocalInputs(journal, group.plan.projectRoot);
  const needsOriginalProof = journal.repositories.some((entry) => !entry.sourceTree);
  const missingProof = () =>
    new Error(
      'Original delivery has no recorded source tree. Preserve the journal and restore every task branch to its recorded original parent and the archived candidate inputs before retrying without --refresh.',
    );
  const current = await captureNativeWorkspaceDeliveryTrees(group);
  let accepted: DeliveryCandidateInputs | undefined;
  if (needsOriginalProof) {
    if (
      journal.status !== 'preparing' ||
      journal.repositories.some((entry, index) => current[index].head !== entry.sourceParent)
    )
      throw missingProof();
    try {
      accepted = (await validateCandidate?.()) || undefined;
    } catch (cause) {
      throw new Error(missingProof().message, { cause });
    }
    if (!accepted) throw missingProof();
  }
  const repositories = journal.repositories.map((receipt, index) => {
    const entry = group.plan.repositories[index];
    const { head, tree } = current[index];
    if (!receipt.sourceTree) {
      const proof = accepted?.trees[index];
      if (
        receipt.sourceCommit ||
        receipt.integrationCommit ||
        proof?.path !== receipt.path ||
        proof.head !== head ||
        proof.tree !== tree
      )
        throw missingProof();
      return { ...receipt, sourceTree: tree };
    }
    if (receipt.sourceTree !== tree)
      throw new Error(
        `Original delivery tree changed: ${entry.worktreeRoot}; restore its recorded tree before retrying`,
      );
    if (receipt.sourceCommit) {
      if (head !== receipt.sourceCommit || gitTree(entry.worktreeRoot, head) !== receipt.sourceTree)
        throw new Error(`Original delivery source commit changed: ${entry.worktreeRoot}`);
      return receipt;
    }
    if (head === receipt.sourceParent) return receipt;
    if (!isOriginalSourceCommit(entry.worktreeRoot, head, receipt, journal))
      throw new Error(
        `Unrecorded task commit differs from original delivery: ${entry.worktreeRoot}; restore the original recorded commit or parent before retrying`,
      );
    return { ...receipt, sourceCommit: head };
  });
  const legacyUnconfirmed = journal.checkAttempts
    .filter((attempt) => attempt.process && !attempt.result)
    .map((attempt) => attempt.operationId);
  await atomicWriteJson(
    path.join(runtimeDir, 'group-delivery/legacy', `${journal.id}.json`),
    journal,
    { containedRoot: runtimeDir },
  );
  const {
    schema: _schema,
    checkAttempts: _checkAttempts,
    integrationHash: _integrationHash,
    ...rest
  } = journal;
  return {
    ...rest,
    schema: 'comet.native.workspace-group-delivery.v2',
    repositories,
    legacyRootFiles: true,
    ...(journal.planHash ? { legacyPlanHash: journal.planHash } : {}),
    ...(legacyUnconfirmed.length ? { legacyUnconfirmed } : {}),
    reports: [],
    planHash: null,
    status: 'preparing',
  };
}

export async function prepareNativeWorkspaceGroupDelivery(options: {
  group: NativeWorkspaceGroup;
  candidateId: string;
  commitMessage: string;
  checks: DeliveryCheckRequirement[];
  artifactRootRef?: string;
  refreshDeliveryId?: string;
  validateCandidate?: () => Promise<void | DeliveryCandidateInputs>;
}): Promise<NativeWorkspaceGroupDelivery> {
  const { group } = options;
  const artifactRootRef = options.artifactRootRef ?? 'docs';
  if (
    artifactRootRef !== '.' &&
    normalizeWorkflowRelativePath(artifactRootRef, 'delivery artifact root') !== artifactRootRef
  )
    throw new Error('Invalid Native delivery artifact root');
  await assertNativeWorkspaceGroupCurrent(group);
  if (!options.candidateId || !options.commitMessage.trim())
    throw new Error('Group delivery requires an accepted candidate and a commit message');
  const storage = await deliveryStorage(group);
  return withRecoverableFileLock(storage.lease, async () => {
    const saved = await storage.read();
    if (!saved && options.refreshDeliveryId)
      throw new Error('Refresh requires an existing unfinished delivery');
    if (
      options.refreshDeliveryId &&
      saved?.id !== options.refreshDeliveryId &&
      saved?.supersedes !== options.refreshDeliveryId
    )
      throw new Error('Refresh requires the exact unfinished delivery ID');
    if (
      saved &&
      (saved.candidateId !== options.candidateId ||
        saved.artifactRootRef !== artifactRootRef ||
        saved.commitMessage !== options.commitMessage)
    )
      throw new Error('Delivery request differs from the original candidate');
    if (saved?.status === 'merged') {
      if (options.refreshDeliveryId)
        throw new Error('Refresh requires the exact unfinished delivery ID');
      assertTargetRefs(group, saved);
      return saved;
    }
    let journal: ReportedDeliveryJournal;
    if (saved) {
      if (isLegacy(saved)) {
        journal = await preserveLegacyJournal(
          group,
          saved,
          storage.paths.runtimeDir,
          options.validateCandidate,
        );
        await storage.save(journal);
      } else {
        journal = saved;
      }
    } else {
      const accepted = await options.validateCandidate?.();
      const trees = accepted?.trees ?? (await captureNativeWorkspaceDeliveryTrees(group));
      const rootFiles =
        accepted?.rootFiles ?? (await captureNativeWorkspaceDeliveryRootFiles(group));
      const id = randomUUID();
      const repositories = group.plan.repositories.map((entry, index): RepositoryDelivery => {
        runGitCommand(entry.worktreeRoot, [
          'merge-base',
          '--is-ancestor',
          entry.baseCommit,
          'HEAD',
        ]);
        const checkout = targetCheckout(entry.sourceRoot, entry.targetBranch);
        return {
          path: entry.path,
          sourceParent: trees[index].head,
          sourceTree: trees[index].tree,
          sourceCommit: null,
          targetCommit: targetHead(entry),
          targetRoot: checkout.root,
          targetWorkspaceId: checkout.id,
          integrationWorkspaceId: null,
          integrationCommit: null,
          applied: false,
          applyStarted: false,
        };
      });
      journal = {
        schema: 'comet.native.workspace-group-delivery.v2',
        id,
        supersedes: null,
        groupHash: group.plan.hash,
        candidateId: options.candidateId,
        commitMessage: options.commitMessage,
        checks: options.checks,
        artifactRootRef,
        rootFiles,
        localFiles: accepted?.localFiles ?? (await captureNativeWorkspaceDeliverySetupFiles(group)),
        integrationRoot: path.join(
          path.dirname(group.plan.projectRoot),
          `.comet-integration-${id}`,
        ),
        integrationRootId: null,
        repositories,
        reports: [],
        planHash: null,
        status: 'preparing',
      };
      await storage.save(journal);
    }
    await assertRootInput(group, journal);
    await assertLocalInputs(journal, group.plan.projectRoot);
    const save = () => storage.save(journal);
    const trees = await captureNativeWorkspaceDeliveryTrees(group);
    for (const [index, entry] of group.plan.repositories.entries()) {
      const receipt = journal.repositories[index];
      const { head } = trees[index];
      if (repositoryHead(entry.worktreeRoot) !== head)
        throw new Error(`Task branch changed during delivery preparation: ${entry.worktreeRoot}`);
      if (trees[index].tree !== receipt.sourceTree)
        throw new Error(
          `Accepted task content changed: ${entry.worktreeRoot}; return to Native verification before delivery`,
        );
      if (receipt.sourceCommit) {
        if (head !== receipt.sourceCommit)
          throw new Error(`Task branch changed after delivery preparation: ${entry.worktreeRoot}`);
        continue;
      }
      const message = sourceCommitMessage(journal);
      if (head !== receipt.sourceParent) {
        if (!isOriginalSourceCommit(entry.worktreeRoot, head, receipt, journal))
          throw new Error(`Unrecorded task commit differs from delivery: ${entry.worktreeRoot}`);
      } else {
        const stage = await nativeWorkspaceDeliveryPaths(group, entry);
        if (stage.length)
          runGitCommand(entry.worktreeRoot, ['--literal-pathspecs', 'add', '-A', '--', ...stage]);
        if (runGitCommand(entry.worktreeRoot, ['write-tree']) !== receipt.sourceTree)
          throw new Error(`Staged tree changed during delivery preparation: ${entry.worktreeRoot}`);
        if (receipt.sourceTree !== gitTree(entry.worktreeRoot, head))
          runGitCommand(entry.worktreeRoot, ['commit', '-m', message]);
      }
      receipt.sourceCommit = repositoryHead(entry.worktreeRoot);
      if (gitTree(entry.worktreeRoot, receipt.sourceCommit) !== receipt.sourceTree)
        throw new Error(`Commit changed accepted task inputs: ${entry.worktreeRoot}`);
      await save();
    }
    if (options.refreshDeliveryId && journal.supersedes !== options.refreshDeliveryId) {
      await assertSource(group, journal);
      const repositories: RepositoryDelivery[] = [];
      for (const [index, entry] of group.plan.repositories.entries()) {
        const receipt = journal.repositories[index];
        const targetCommit = targetHead(entry);
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
      await atomicWriteJson(
        path.join(storage.paths.runtimeDir, 'group-delivery/history', `${journal.id}.json`),
        journal,
        { containedRoot: storage.paths.runtimeDir },
      );
      const id = randomUUID();
      const { legacyPlanHash: _legacyPlanHash, ...rest } = journal;
      journal = {
        ...rest,
        id,
        supersedes: journal.id,
        repositories,
        integrationRoot: path.join(
          path.dirname(group.plan.projectRoot),
          `.comet-integration-${id}`,
        ),
        integrationRootId: null,
        planHash: null,
        reports: [],
        status: 'preparing',
      };
      await storage.save(journal);
    }
    if (journal.status !== 'preparing') {
      await registerWorkspaceGroupIntegration(
        group.plan.projectRoot,
        journal.integrationRoot,
        journal.id,
      );
      await assertIntegration(group, journal);
      assertTargetRefs(group, journal);
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
        if (!gitWorktreeIsClean(root))
          throw new Error(
            `Integration has unresolved changes: ${root}; inspect git status and preserve conflict evidence`,
          );
        const head = runGitCommand(root, ['rev-parse', 'HEAD']);
        if (
          head === receipt.targetCommit &&
          receipt.sourceTree !== gitTree(entry.sourceRoot, entry.baseCommit)
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
    if (group.plan.setup && (!journal.legacyRootFiles || journal.supersedes)) {
      const setup = await prepareNativeWorkspaceSetup({
        sourceRoot: group.plan.projectRoot,
        targetRoot: journal.integrationRoot,
        repositories: journal.repositories,
        setup: { ...group.plan.setup, files: journal.localFiles },
      });
      for (const check of setup?.checks ?? []) {
        const id = `setup:${check.id}`;
        if (!journal.checks.some((entry) => entry.id === id))
          journal.checks.push({
            id,
            name: check.name,
            cwdRef: check.cwdRef,
            executable: check.executable,
            argv: check.argv,
          });
      }
    }
    await assertIntegration(group, journal);
    assertTargetRefs(group, journal);
    journal.status = 'awaiting-checks';
    await save();
    return journal;
  });
}

function readDeliveryReport(value: unknown): DeliveryCheckReport {
  const input = value as DeliveryCheckReport;
  if (
    !input ||
    typeof input.deliveryId !== 'string' ||
    typeof input.planHash !== 'string' ||
    !Array.isArray(input.checks) ||
    input.checks.some(
      (check) =>
        !check ||
        typeof check.id !== 'string' ||
        !check.id.trim() ||
        (check.command !== undefined && typeof check.command !== 'string') ||
        (check.actualCommand !== undefined &&
          (!check.actualCommand ||
            typeof check.actualCommand.executable !== 'string' ||
            !check.actualCommand.executable.trim() ||
            !Array.isArray(check.actualCommand.argv) ||
            check.actualCommand.argv.some((argument) => typeof argument !== 'string'))) ||
        typeof check.cwd !== 'string' ||
        !path.isAbsolute(check.cwd) ||
        !['passed', 'failed', 'not-run'].includes(check.result) ||
        (check.note !== undefined && typeof check.note !== 'string'),
    ) ||
    new Set(input.checks.map((check) => check.id)).size !== input.checks.length ||
    (input.noChecksReason !== undefined && typeof input.noChecksReason !== 'string') ||
    (input.legacyReconciliation !== undefined && typeof input.legacyReconciliation !== 'string')
  )
    throw new Error('Invalid integration check report');
  return {
    deliveryId: input.deliveryId,
    planHash: input.planHash,
    checks: input.checks.map(({ id, command, actualCommand, cwd, result, note }) => ({
      id,
      ...(actualCommand
        ? {
            actualCommand: {
              executable: actualCommand.executable,
              argv: actualCommand.argv,
            },
          }
        : command?.trim()
          ? { command }
          : {}),
      cwd,
      result,
      ...(note === undefined ? {} : { note }),
    })),
    ...(input.noChecksReason?.trim() ? { noChecksReason: input.noChecksReason.trim() } : {}),
    ...(input.legacyReconciliation?.trim()
      ? { legacyReconciliation: input.legacyReconciliation.trim() }
      : {}),
  };
}

export async function reportNativeWorkspaceGroupDelivery(
  group: NativeWorkspaceGroup,
  value: unknown,
): Promise<ReportedDeliveryJournal> {
  const report = readDeliveryReport(value);
  await assertNativeWorkspaceGroupCurrent(group);
  const storage = await deliveryStorage(group);
  return withRecoverableFileLock(storage.lease, async () => {
    const journal = await storage.read();
    if (
      !journal ||
      isLegacy(journal) ||
      !['awaiting-checks', 'ready'].includes(journal.status) ||
      report.deliveryId !== journal.id
    )
      throw new Error('Integration report is for a different or closed delivery');
    await assertSource(group, journal);
    await assertIntegration(group, journal);
    assertTargetRefs(group, journal);
    const latest = journal.reports.at(-1);
    if (
      latest &&
      canonicalHash('delivery-report', latest) === canonicalHash('delivery-report', report)
    )
      return journal;
    if (report.planHash !== deliveryHash(journal))
      throw new Error('Integration report does not match the current delivery plan');
    if (
      journal.legacyUnconfirmed?.length &&
      !journal.reports.some((entry) => entry.legacyReconciliation) &&
      !report.legacyReconciliation
    )
      throw new Error(
        'Reconcile the original integration execution before submitting a new result',
      );
    const requirements = new Map(journal.checks.map((check) => [check.id, check]));
    for (const check of report.checks) {
      const relative = path.relative(journal.integrationRoot, check.cwd);
      const requirement = requirements.get(check.id);
      if (
        path.isAbsolute(relative) ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        (requirement?.cwdRef !== undefined &&
          path.resolve(journal.integrationRoot, requirement.cwdRef) !== path.resolve(check.cwd))
      )
        throw new Error(`Integration check ran outside its prepared workspace: ${check.id}`);
      if (requirement?.executable !== undefined) {
        const actual = check.actualCommand;
        const expectedArgs = requirement.argv ?? [];
        if (
          !actual ||
          actual.executable !== requirement.executable ||
          actual.argv.length !== expectedArgs.length ||
          actual.argv.some((argument, index) => argument !== expectedArgs[index])
        )
          throw new Error(
            `Integration check did not report its required executable and arguments: ${check.id}`,
          );
      } else if (!check.command?.trim()) {
        throw new Error(`Integration check must report the actual command: ${check.id}`);
      }
      if (relative) {
        const directory = await inspectProtectedProjectPath(
          journal.integrationRoot,
          relative.replaceAll(path.sep, '/'),
          { expected: 'directory', label: 'Integration check working directory' },
        );
        if (!directory.exists)
          throw new Error(`Integration check working directory is missing: ${check.cwd}`);
      }
    }
    const missing = journal.checks.filter(
      (check) => !report.checks.some((result) => result.id === check.id),
    );
    if (missing.length)
      throw new Error(
        `Integration report is missing required checks: ${missing.map((check) => check.id).join(', ')}`,
      );
    if (!report.checks.length && !report.noChecksReason)
      throw new Error('Report actual integration checks or explain why none are required');
    journal.reports.push(report);
    journal.status = report.checks.every((check) => check.result === 'passed')
      ? 'ready'
      : 'awaiting-checks';
    journal.planHash = journal.status === 'ready' ? deliveryHash(journal) : null;
    await storage.save(journal);
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
    if (
      !journal ||
      journal.planHash !== expectedPlanHash ||
      !['ready', 'applying', 'merged'].includes(journal.status)
    )
      throw new Error('Prepare and verify the exact delivery plan before applying it');
    if (journal.status === 'merged') {
      assertTargetRefs(group, journal);
      return journal;
    }
    if (isLegacy(journal))
      throw new Error(
        'Prepare the original delivery and submit a current integration report before continuing',
      );
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
      await assertSource(group, journal);
      await assertIntegration(group, journal);
      assertTargetRefs(group, journal);
      for (const [position, entry] of group.plan.repositories.entries()) {
        const receipt = journal.repositories[position];
        if (receipt.applied || targetHead(entry) === receipt.integrationCommit) continue;
        const checkout = targetCheckout(entry.sourceRoot, entry.targetBranch);
        if (checkout.root !== receipt.targetRoot || checkout.id !== receipt.targetWorkspaceId)
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
