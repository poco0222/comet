import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  resolveWorkspaceIdentity,
  resolveWorkspaceRuntimeLocation,
} from '../../platform/paths/workspace-runtime.js';
import { isLocalGitBranch, listGitWorktrees } from '../../platform/paths/git-worktree.js';
import {
  assertValidGitBranchName,
  gitWorktreeIsClean,
  runGitCommand,
} from '../../platform/process/git.js';
import { atomicWriteJson } from './native-atomic-file.js';
import { canonicalHash } from './native-canonical-hash.js';
import { withNativeLockRecovery } from './native-lock.js';
import { nativeProjectPaths, resolveContainedNativePath } from './native-paths.js';
import {
  registerWorkspaceGroup,
  findWorkspaceGroupRoot,
} from '../workflow-contract/workspace-group.js';
import { readChangeRuntimeOwner } from '../workflow-contract/change-runtime-owner.js';
import { readProtectedProjectFile } from '../workflow-contract/protected-project-path.js';
import {
  validateNativeWorkspaceSetup,
  type NativeWorkspaceSetup,
} from './native-workspace-setup.js';

export interface NativeRepositoryDefinition {
  path: string;
  targetBranch?: string;
}

export interface NativeRepositoryPlan {
  path: string;
  sourceRoot: string;
  sourceWorkspaceId: string;
  commonDir: string;
  sourceHead: string;
  sourceDirty: boolean;
  targetBranch: string;
  baseCommit: string;
  changeBranch: string;
  worktreeRoot: string;
}

export interface NativeWorkspaceGroupPlan {
  schema: 'comet.native.workspace-group-plan.v1';
  coordinatorRoot: string;
  coordinatorId: string;
  name: string;
  projectRoot: string;
  repositories: NativeRepositoryPlan[];
  configurationHash: string | null;
  setup?: NativeWorkspaceSetup;
  hash: string;
}

export interface NativeWorkspaceGroup {
  schema: 'comet.native.workspace-group.v1';
  plan: NativeWorkspaceGroupPlan;
  projectWorkspaceId: string;
  repositories: Array<{ path: string; workspaceId: string }>;
  complete: boolean;
}

function inside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

async function readGroup(root: string, file: string): Promise<NativeWorkspaceGroup> {
  const { bytes } = await readProtectedProjectFile(
    root,
    path.relative(root, file).replaceAll('\\', '/'),
    Number.MAX_SAFE_INTEGER,
    { label: 'Native workspace group journal' },
  );
  return JSON.parse(bytes.toString('utf8')) as NativeWorkspaceGroup;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function canonicalDestination(target: string): Promise<string> {
  if (await exists(target)) {
    const physical = await fs.realpath(target);
    if (physical !== target)
      throw new Error(`Native workspace path must not traverse a symbolic link: ${target}`);
    return physical;
  }
  return path.join(await canonicalDestination(path.dirname(target)), path.basename(target));
}

function repositoryPath(value: string): string {
  if (
    !value ||
    value.includes('\\') ||
    value
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.startsWith('.')) ||
    path.isAbsolute(value)
  ) {
    throw new Error(`Native repository path must be a relative child directory: ${value}`);
  }
  return value;
}

async function repositoryIdentity(root: string) {
  const identity = resolveWorkspaceIdentity(root);
  if (
    identity.projectRoot !== root ||
    (await fs.realpath(runGitCommand(root, ['rev-parse', '--show-toplevel']))) !== root
  ) {
    throw new Error(
      `Native repository must identify its exact Git root without symbolic links: ${root}`,
    );
  }
  const commonDir = await fs.realpath(
    path.resolve(root, runGitCommand(root, ['rev-parse', '--git-common-dir'])),
  );
  return { ...identity, commonDir };
}

function planHash(plan: Omit<NativeWorkspaceGroupPlan, 'hash'>): string {
  return canonicalHash('comet.native.workspace-group-plan.v1', plan);
}

async function assertSeparateTaskRoot(
  plan: Pick<NativeWorkspaceGroupPlan, 'coordinatorRoot' | 'projectRoot' | 'name'>,
): Promise<void> {
  if (await readChangeRuntimeOwner(plan.coordinatorRoot, 'native', plan.name, { readOnly: true })) {
    throw new Error(
      `Native change ${plan.name} already belongs to the coordinator: ${plan.coordinatorRoot}`,
    );
  }
  const enclosing = await findWorkspaceGroupRoot(plan.projectRoot);
  if (enclosing && enclosing !== plan.projectRoot)
    throw new Error(`Native task workspace overlaps another task: ${enclosing}`);
  const paths = await nativeProjectPaths(plan.coordinatorRoot, 'docs', { readOnly: true });
  const directory = await resolveContainedNativePath(
    paths.runtimeDir,
    path.join(paths.runtimeDir, 'workspace-groups'),
  );
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const file of names) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.json$/u.test(file))
      throw new Error('Invalid Native workspace group journal name');
    const name = file.slice(0, -5);
    if (name === plan.name) continue;
    const other = await readNativeWorkspaceGroupPlan(plan.coordinatorRoot, name);
    if (!other) throw new Error('Native workspace group journal disappeared');
    if (inside(other.projectRoot, plan.projectRoot) || inside(plan.projectRoot, other.projectRoot))
      throw new Error(`Native task workspace overlaps another task: ${other.projectRoot}`);
  }
}

/** 只读预检固定各仓提交；源工作区中的未提交内容不会被复制。 */
export async function planNativeWorkspaceGroup(options: {
  projectRoot: string;
  name: string;
  repositories: readonly NativeRepositoryDefinition[];
  worktreePath?: string;
  configuration?: unknown;
  setup?: NativeWorkspaceSetup;
}): Promise<NativeWorkspaceGroupPlan> {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(options.name))
    throw new Error('Invalid Native change name');
  if (options.repositories.length === 0)
    throw new Error('Native workspace group requires repositories');
  if (options.setup) validateNativeWorkspaceSetup(options.setup, options.repositories);
  const coordinator = resolveWorkspaceIdentity(options.projectRoot);
  const projectRoot = await canonicalDestination(
    path.resolve(
      coordinator.projectRoot,
      options.worktreePath ??
        path.join('..', `${path.basename(coordinator.projectRoot)}-worktrees`, options.name),
    ),
  );
  if (
    inside(coordinator.projectRoot, projectRoot) ||
    inside(projectRoot, coordinator.projectRoot)
  ) {
    throw new Error('Native task workspace must be outside the coordinator directory');
  }
  if (await exists(projectRoot))
    throw new Error(`Native task workspace already exists: ${projectRoot}`);
  const repositories: NativeRepositoryPlan[] = [];
  for (const definition of options.repositories) {
    const ref = repositoryPath(definition.path);
    const sourceRoot = path.join(coordinator.projectRoot, ref);
    const identity = await repositoryIdentity(sourceRoot);
    if (
      repositories.some(
        (entry) =>
          entry.commonDir === identity.commonDir ||
          inside(entry.sourceRoot, sourceRoot) ||
          inside(sourceRoot, entry.sourceRoot),
      )
    ) {
      throw new Error(`Native repositories must be independent, non-overlapping Git roots: ${ref}`);
    }
    const targetBranch =
      definition.targetBranch ??
      runGitCommand(sourceRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const changeBranch = `comet/${options.name}`;
    assertValidGitBranchName(sourceRoot, targetBranch);
    assertValidGitBranchName(sourceRoot, changeBranch);
    if (!isLocalGitBranch(sourceRoot, targetBranch))
      throw new Error(`Native target branch is not local: ${ref}:${targetBranch}`);
    if (isLocalGitBranch(sourceRoot, changeBranch))
      throw new Error(`Native task branch already exists: ${ref}:${changeBranch}`);
    repositories.push({
      path: ref,
      sourceRoot,
      sourceWorkspaceId: identity.workspaceId,
      commonDir: identity.commonDir,
      sourceHead: runGitCommand(sourceRoot, ['rev-parse', 'HEAD']),
      sourceDirty: !gitWorktreeIsClean(sourceRoot),
      targetBranch,
      baseCommit: runGitCommand(sourceRoot, ['rev-parse', `refs/heads/${targetBranch}`]),
      changeBranch,
      worktreeRoot: path.join(projectRoot, ref),
    });
  }
  const plan: Omit<NativeWorkspaceGroupPlan, 'hash'> = {
    schema: 'comet.native.workspace-group-plan.v1',
    coordinatorRoot: coordinator.projectRoot,
    coordinatorId: coordinator.workspaceId,
    name: options.name,
    projectRoot,
    repositories,
    ...(options.setup ? { setup: options.setup } : {}),
    configurationHash:
      options.configuration === undefined
        ? null
        : canonicalHash('comet.native.workspace-group-config', options.configuration),
  };
  await assertSeparateTaskRoot(plan);
  return { ...plan, hash: planHash(plan) };
}

async function validatePlan(plan: NativeWorkspaceGroupPlan): Promise<void> {
  const { hash, ...body } = plan;
  if (
    plan.schema !== 'comet.native.workspace-group-plan.v1' ||
    planHash(body) !== hash ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(plan.name) ||
    !plan.repositories.length
  )
    throw new Error('Invalid Native workspace group plan');
  if (plan.setup) validateNativeWorkspaceSetup(plan.setup, plan.repositories);
  const coordinator = resolveWorkspaceIdentity(plan.coordinatorRoot);
  if (
    coordinator.projectRoot !== plan.coordinatorRoot ||
    coordinator.workspaceId !== plan.coordinatorId
  )
    throw new Error('Native coordinator identity changed; prepare a new plan');
  if (
    !path.isAbsolute(plan.projectRoot) ||
    inside(plan.coordinatorRoot, plan.projectRoot) ||
    inside(plan.projectRoot, plan.coordinatorRoot)
  )
    throw new Error('Invalid Native task workspace destination');
  await canonicalDestination(plan.projectRoot);
  const seen: NativeRepositoryPlan[] = [];
  for (const entry of plan.repositories) {
    const ref = repositoryPath(entry.path);
    if (
      entry.sourceRoot !== path.join(plan.coordinatorRoot, ref) ||
      entry.worktreeRoot !== path.join(plan.projectRoot, ref)
    )
      throw new Error(`Native repository path changed: ${ref}`);
    const identity = await repositoryIdentity(entry.sourceRoot);
    if (identity.workspaceId !== entry.sourceWorkspaceId || identity.commonDir !== entry.commonDir)
      throw new Error(`Native repository identity changed: ${ref}`);
    if (
      seen.some(
        (other) =>
          other.commonDir === entry.commonDir ||
          inside(other.sourceRoot, entry.sourceRoot) ||
          inside(entry.sourceRoot, other.sourceRoot),
      )
    )
      throw new Error(`Overlapping Native repository: ${ref}`);
    seen.push(entry);
    if (entry.changeBranch !== `comet/${plan.name}`)
      throw new Error(`Invalid Native task branch: ${ref}`);
    assertValidGitBranchName(entry.sourceRoot, entry.targetBranch);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(entry.baseCommit))
      throw new Error(`Invalid Native base commit: ${ref}`);
    runGitCommand(entry.sourceRoot, ['cat-file', '-e', `${entry.baseCommit}^{commit}`]);
  }
}

async function verifyMember(entry: NativeRepositoryPlan, workspaceId?: string): Promise<string> {
  const identity = await repositoryIdentity(entry.worktreeRoot);
  if (
    identity.commonDir !== entry.commonDir ||
    (workspaceId !== undefined && identity.workspaceId !== workspaceId) ||
    runGitCommand(entry.worktreeRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !==
      entry.changeBranch ||
    !listGitWorktrees(entry.sourceRoot).some(
      (tree) => tree.root === entry.worktreeRoot && tree.branch === entry.changeBranch,
    )
  ) {
    throw new Error(`Native task worktree binding changed: ${entry.worktreeRoot}`);
  }
  return identity.workspaceId;
}

export async function assertNativeWorkspaceGroupCurrent(
  group: NativeWorkspaceGroup,
): Promise<void> {
  await validatePlan(group.plan);
  if (
    group.schema !== 'comet.native.workspace-group.v1' ||
    group.complete !== true ||
    resolveWorkspaceIdentity(group.plan.projectRoot).workspaceId !== group.projectWorkspaceId ||
    group.repositories.length !== group.plan.repositories.length
  )
    throw new Error('Native workspace group is incomplete or replaced');
  for (const entry of group.plan.repositories) {
    const member = group.repositories.find((item) => item.path === entry.path);
    if (!member) throw new Error(`Missing Native task repository: ${entry.path}`);
    await verifyMember(entry, member.workspaceId);
  }
}

async function publishBinding(group: NativeWorkspaceGroup): Promise<void> {
  await registerWorkspaceGroup({
    schema: 'comet.workspace-group.v1',
    name: group.plan.name,
    planHash: group.plan.hash,
    coordinatorRoot: group.plan.coordinatorRoot,
    coordinatorId: group.plan.coordinatorId,
    projectRoot: group.plan.projectRoot,
    workspaceId: group.projectWorkspaceId,
    repositories: group.plan.repositories.map((entry) => ({
      path: entry.path,
      sourceWorkspaceId: entry.sourceWorkspaceId,
      commonDir: entry.commonDir,
      branch: entry.changeBranch,
      workspaceId: group.repositories.find((member) => member.path === entry.path)!.workspaceId,
    })),
  });
  const { runtimeRoot } = resolveWorkspaceRuntimeLocation(group.plan.projectRoot);
  await fs.mkdir(runtimeRoot, { recursive: true });
  const file = await resolveContainedNativePath(
    runtimeRoot,
    path.join(runtimeRoot, 'native', 'workspace-group.json'),
  );
  if (await exists(file)) {
    if (
      canonicalHash('group', await readGroup(runtimeRoot, file)) !== canonicalHash('group', group)
    )
      throw new Error(`Native workspace group binding already differs: ${file}`);
    return;
  }
  await atomicWriteJson(file, group, { containedRoot: runtimeRoot, exclusive: true });
}

export async function readNativeWorkspaceGroupPlan(
  coordinatorRoot: string,
  name: string,
): Promise<NativeWorkspaceGroupPlan | null> {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name)) throw new Error('Invalid Native change name');
  const paths = await nativeProjectPaths(coordinatorRoot, 'docs', { readOnly: true });
  const file = await resolveContainedNativePath(
    paths.runtimeDir,
    path.join(paths.runtimeDir, 'workspace-groups', `${name}.json`),
  );
  if (!(await exists(file))) return null;
  const group = await readGroup(paths.runtimeDir, file);
  await validatePlan(group.plan);
  if (
    group.schema !== 'comet.native.workspace-group.v1' ||
    group.plan.name !== name ||
    group.plan.coordinatorRoot !== (await fs.realpath(coordinatorRoot))
  )
    throw new Error(`Native workspace creation journal belongs to another task: ${file}`);
  return group.plan;
}

export async function readNativeWorkspaceGroup(
  projectRoot: string,
): Promise<NativeWorkspaceGroup | null> {
  const group = await readNativeWorkspaceGroupRecord(projectRoot);
  if (group) await assertNativeWorkspaceGroupCurrent(group);
  return group;
}

/** Cleanup history keeps root ownership while individual worktrees may have been removed. */
export async function readNativeWorkspaceGroupRecord(
  projectRoot: string,
): Promise<NativeWorkspaceGroup | null> {
  const { runtimeRoot, workspaceId } = resolveWorkspaceRuntimeLocation(projectRoot);
  const file = await resolveContainedNativePath(
    runtimeRoot,
    path.join(runtimeRoot, 'native', 'workspace-group.json'),
  );
  if (!(await exists(file))) return null;
  const group = await readGroup(runtimeRoot, file);
  if (
    group.projectWorkspaceId !== workspaceId ||
    group.plan.projectRoot !== (await fs.realpath(projectRoot))
  )
    throw new Error(`Native workspace group belongs to a different task: ${file}`);
  await validatePlan(group.plan);
  if (group.schema !== 'comet.native.workspace-group.v1' || !group.complete)
    throw new Error('Native workspace group is incomplete');
  const coordinator = await nativeProjectPaths(group.plan.coordinatorRoot, 'docs', {
    readOnly: true,
  });
  const journal = await resolveContainedNativePath(
    coordinator.runtimeDir,
    path.join(coordinator.runtimeDir, 'workspace-groups', `${group.plan.name}.json`),
  );
  const registered = await readGroup(coordinator.runtimeDir, journal);
  if (canonicalHash('group', registered) !== canonicalHash('group', group))
    throw new Error(`Native workspace group does not match its coordinator registry: ${file}`);
  return group;
}

/** 日志先于 Git 副作用落盘；重试只能继续同一预检，不删除已创建的仓库。 */
export async function createNativeWorkspaceGroup(
  plan: NativeWorkspaceGroupPlan,
): Promise<NativeWorkspaceGroup> {
  await validatePlan(plan);
  const paths = await nativeProjectPaths(plan.coordinatorRoot, 'docs');
  return withNativeLockRecovery([paths], `create Native workspace group ${plan.name}`, async () => {
    await assertSeparateTaskRoot(plan);
    const directory = await resolveContainedNativePath(
      paths.runtimeDir,
      path.join(paths.runtimeDir, 'workspace-groups'),
    );
    await fs.mkdir(directory, { recursive: true });
    const journal = await resolveContainedNativePath(
      paths.runtimeDir,
      path.join(directory, `${plan.name}.json`),
    );
    let group: NativeWorkspaceGroup;
    if (await exists(journal)) {
      group = await readGroup(paths.runtimeDir, journal);
      if (
        group.schema !== 'comet.native.workspace-group.v1' ||
        group.plan.hash !== plan.hash ||
        canonicalHash('plan', group.plan) !== canonicalHash('plan', plan)
      )
        throw new Error(
          `Native workspace group plan differs from its creation journal: ${journal}`,
        );
      if (group.complete) {
        await assertNativeWorkspaceGroupCurrent(group);
        await publishBinding(group);
        return group;
      }
    } else {
      if (await exists(plan.projectRoot))
        throw new Error(
          `Native task destination is not owned by this transaction: ${plan.projectRoot}`,
        );
      // 再次检查预检到执行之间的分支变化，避免接管其他任务的分支。
      for (const entry of plan.repositories) {
        if (
          isLocalGitBranch(entry.sourceRoot, entry.changeBranch) ||
          runGitCommand(entry.sourceRoot, ['rev-parse', `refs/heads/${entry.targetBranch}`]) !==
            entry.baseCommit
        )
          throw new Error(`Native preflight is stale: ${entry.path}; prepare a new plan`);
      }
      group = {
        schema: 'comet.native.workspace-group.v1',
        plan,
        projectWorkspaceId: '',
        repositories: [],
        complete: false,
      };
      await atomicWriteJson(journal, group, { containedRoot: paths.runtimeDir, exclusive: true });
    }
    const save = () => atomicWriteJson(journal, group, { containedRoot: paths.runtimeDir });
    await canonicalDestination(plan.projectRoot);
    if (!group.projectWorkspaceId && (await exists(plan.projectRoot)))
      throw new Error(
        `Native task directory has no recorded identity: ${plan.projectRoot}; preserve it and inspect before retrying creation`,
      );
    await fs.mkdir(plan.projectRoot, { recursive: true, mode: 0o700 });
    const rootId = resolveWorkspaceIdentity(plan.projectRoot).workspaceId;
    if (group.projectWorkspaceId && group.projectWorkspaceId !== rootId)
      throw new Error(`Native task workspace was replaced: ${plan.projectRoot}`);
    group.projectWorkspaceId = rootId;
    await save();
    for (const entry of plan.repositories) {
      const member = group.repositories.find((item) => item.path === entry.path);
      if (member) {
        await verifyMember(entry, member.workspaceId);
        continue;
      }
      await canonicalDestination(entry.worktreeRoot);
      const creationMessage = `comet workspace group ${plan.hash}`;
      if (
        isLocalGitBranch(entry.sourceRoot, entry.changeBranch) &&
        runGitCommand(entry.sourceRoot, [
          'reflog',
          'show',
          '-1',
          '--format=%gs',
          `refs/heads/${entry.changeBranch}`,
        ]) !== creationMessage
      )
        throw new Error(
          `Native task branch is not owned by this preparation: ${entry.path}; preserve the branch before retrying`,
        );
      if (!(await exists(entry.worktreeRoot))) {
        if (isLocalGitBranch(entry.sourceRoot, entry.changeBranch)) {
          if (
            runGitCommand(entry.sourceRoot, ['rev-parse', `refs/heads/${entry.changeBranch}`]) !==
            entry.baseCommit
          )
            throw new Error(
              `Native task branch is not owned by this preparation: ${entry.path}; preserve the branch before retrying`,
            );
        } else {
          runGitCommand(entry.sourceRoot, [
            'update-ref',
            '--create-reflog',
            '-m',
            creationMessage,
            `refs/heads/${entry.changeBranch}`,
            entry.baseCommit,
            '0'.repeat(entry.baseCommit.length),
          ]);
        }
        runGitCommand(entry.sourceRoot, [
          'worktree',
          'add',
          entry.worktreeRoot,
          entry.changeBranch,
        ]);
      }
      const workspaceId = await verifyMember(entry);
      if (
        runGitCommand(entry.worktreeRoot, ['rev-parse', 'HEAD']) !== entry.baseCommit ||
        !gitWorktreeIsClean(entry.worktreeRoot)
      )
        throw new Error(
          `Unrecorded Native task worktree changed; preserve it and inspect before recovery: ${entry.worktreeRoot}`,
        );
      group.repositories.push({ path: entry.path, workspaceId });
      await save();
    }
    group.complete = true;
    await save();
    await assertNativeWorkspaceGroupCurrent(group);
    await publishBinding(group);
    return group;
  });
}
