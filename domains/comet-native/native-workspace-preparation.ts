import { NativeWorkspacePreparationError } from './native-runtime-errors.js';
export { NativeWorkspacePreparationError } from './native-runtime-errors.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  assertValidGitBranchName,
  gitWorktreeIsClean,
  runGitCommand,
} from '../../platform/process/git.js';
import {
  inspectGitWorktree,
  isLocalGitBranch,
  listGitWorktrees,
  listGitWorktreeRoots,
  samePath,
} from '../../platform/paths/git-worktree.js';

import { readProjectConfig, writeProjectConfig } from './native-config.js';
import { recordNativeWorkspaceConfig } from './native-workspace-config.js';
import type { CometProjectConfig } from './native-types.js';
import type { NativeWorkspaceBinding, NativeWorkspaceIsolation } from './native-workspace.js';
import { canonicalHash } from './native-canonical-hash.js';
import { initializeNativeWorkspaceGroupSpecs } from './native-workspace-group-specs.js';
import {
  prepareNativeWorkspaceSetup,
  type NativeWorkspaceSetupProgress,
  type NativeWorkspaceSetupReport,
} from './native-workspace-setup.js';
import {
  createNativeWorkspaceGroup,
  readNativeWorkspaceGroup,
  type NativeWorkspaceGroupPlan,
} from './native-workspace-group.js';

export interface NativeWorkspacePreparation {
  isolation: NativeWorkspaceIsolation;
  projectRoot: string;
  changeBranch: string | null;
  targetBranch: string | null;
  worktreePath: string | null;
  createdBranch: boolean;
  createdWorktree: boolean;
  gitExcludeUpdated: boolean;
  configInitialized: boolean;
  group?: NativeWorkspaceGroupPlan;
  setup?: NativeWorkspaceSetupProgress;
}

export interface PreparedNativeWorkspace {
  projectRoot: string;
  binding: NativeWorkspaceBinding;
  preparation: NativeWorkspacePreparation;
}

function isInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function nativeConfigIdentity(config: CometProjectConfig): string {
  // 派发上限由 Parent 逐轮读取，Child worktree 保留原值不影响工作区绑定。
  const workspaceConfig = { ...config.native };
  delete workspaceConfig.max_parallel_children;
  return JSON.stringify({ native: workspaceConfig, repositories: config.repositories });
}

async function ensureConfig(
  targetRoot: string,
  sourceConfig: CometProjectConfig | null,
): Promise<boolean> {
  const targetConfig = await readProjectConfig(targetRoot);
  if (targetConfig && sourceConfig) {
    if (nativeConfigIdentity(targetConfig) !== nativeConfigIdentity(sourceConfig)) {
      throw new Error(
        `Native worktree configuration differs from the source project: ${path.join(targetRoot, '.comet', 'config.yaml')}`,
      );
    }
    return false;
  }
  if (!targetConfig && sourceConfig) {
    await writeProjectConfig(targetRoot, sourceConfig);
    await recordNativeWorkspaceConfig(targetRoot);
    return true;
  }
  return false;
}

async function appendLocalExclude(projectRoot: string, worktreePath?: string): Promise<boolean> {
  // 历史分支可能尚未包含新的 .gitignore；本机 fence 不能把准备好的 worktree 变脏。
  const patterns = ['/.comet/runtime'];
  if (worktreePath && isInside(projectRoot, worktreePath)) {
    const relative = path.relative(projectRoot, worktreePath).replaceAll('\\', '/');
    patterns.push(`/${relative.replace(/\/+$/u, '')}/`);
  }
  const rawCommonDir = runGitCommand(projectRoot, ['rev-parse', '--git-common-dir']);
  const commonDir = path.resolve(projectRoot, rawCommonDir);
  const excludeFile = path.join(commonDir, 'info', 'exclude');
  let existing = '';
  try {
    existing = await fs.readFile(excludeFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const missing = patterns.filter((pattern) => !existing.split(/\r?\n/u).includes(pattern));
  if (missing.length === 0) return false;
  await fs.mkdir(path.dirname(excludeFile), { recursive: true });
  const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  await fs.appendFile(excludeFile, `${prefix}${missing.join('\n')}\n`, 'utf8');
  return true;
}

function resolveWorktreePath(
  primaryRoot: string,
  name: string,
  requested: string | undefined,
): string {
  const target = path.resolve(primaryRoot, requested ?? path.join('.worktrees', name));
  const commonDir = path.resolve(
    primaryRoot,
    runGitCommand(primaryRoot, ['rev-parse', '--git-common-dir']),
  );
  if (isInside(commonDir, target)) {
    throw new Error('Native worktree path cannot be inside the Git common directory');
  }
  if (listGitWorktreeRoots(primaryRoot).some((root) => samePath(root, target))) {
    throw new Error(`Native worktree path is already registered: ${target}`);
  }
  return target;
}

async function assertPathAbsent(target: string): Promise<void> {
  try {
    await fs.lstat(target);
    throw new Error(`Native worktree path already exists: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function prepareNativeWorkspace(options: {
  projectRoot: string;
  name: string;
  isolation: NativeWorkspaceIsolation;
  changeBranch?: string;
  targetBranch?: string;
  worktreePath?: string;
  sourceConfig: CometProjectConfig | null;
  groupPlan?: NativeWorkspaceGroupPlan;
  setupReport?: NativeWorkspaceSetupReport;
}): Promise<PreparedNativeWorkspace> {
  const initialRoot = path.resolve(options.projectRoot);
  if (options.groupPlan) {
    const plan = options.groupPlan;
    if (
      options.isolation !== 'worktree' ||
      options.changeBranch ||
      options.targetBranch ||
      plan.name !== options.name ||
      plan.coordinatorRoot !== (await fs.realpath(initialRoot))
    )
      throw new Error(
        'Native workspace group preparation does not match its plan or source configuration',
      );
    if (
      plan.configurationHash !==
      canonicalHash('comet.native.workspace-group-config', options.sourceConfig)
    ) {
      // 已建立的旧组由登记和任务自身配置恢复，历史配置摘要包含已撤下的字段。
      const previous = (await pathExists(plan.projectRoot))
        ? await readNativeWorkspaceGroup(plan.projectRoot)
        : null;
      const taskConfig = previous ? await readProjectConfig(plan.projectRoot) : null;
      if (
        previous?.plan.hash !== plan.hash ||
        !taskConfig ||
        !options.sourceConfig ||
        nativeConfigIdentity(taskConfig) !== nativeConfigIdentity(options.sourceConfig)
      )
        throw new Error('Native workspace group configuration differs from its creation plan');
    }
    const createdBranch = plan.repositories.some(
      (entry) => !isLocalGitBranch(entry.sourceRoot, entry.changeBranch),
    );
    const createdWorktree = (
      await Promise.all(plan.repositories.map((entry) => pathExists(entry.worktreeRoot)))
    ).some((present) => !present);
    const group = await createNativeWorkspaceGroup(plan);
    await initializeNativeWorkspaceGroupSpecs(
      group,
      options.sourceConfig?.native.artifact_root ?? 'docs',
    );
    const configInitialized = await ensureConfig(group.plan.projectRoot, options.sourceConfig);
    const setup = await prepareNativeWorkspaceSetup({
      sourceRoot: plan.coordinatorRoot,
      targetRoot: plan.projectRoot,
      repositories: plan.repositories,
      setup: plan.setup,
      report: options.setupReport,
    });
    return {
      projectRoot: plan.projectRoot,
      binding: {
        isolation: 'current',
        changeBranch: null,
        targetBranch: null,
        groupHash: plan.hash,
      },
      preparation: {
        isolation: 'worktree',
        projectRoot: plan.projectRoot,
        changeBranch: null,
        targetBranch: null,
        worktreePath: plan.projectRoot,
        createdBranch,
        createdWorktree,
        gitExcludeUpdated: false,
        configInitialized,
        group: plan,
        ...(setup ? { setup } : {}),
      },
    };
  }
  const group = await readNativeWorkspaceGroup(initialRoot);
  if (group) {
    if (
      group.plan.name !== options.name ||
      options.isolation !== 'current' ||
      options.changeBranch ||
      options.targetBranch ||
      options.worktreePath
    )
      throw new Error(
        'Native task workspace is already bound to its original group; use its original new command to recover',
      );
    const setup = await prepareNativeWorkspaceSetup({
      sourceRoot: group.plan.coordinatorRoot,
      targetRoot: initialRoot,
      repositories: group.plan.repositories,
      setup: group.plan.setup,
    });
    return {
      projectRoot: initialRoot,
      binding: {
        isolation: 'current',
        changeBranch: null,
        targetBranch: null,
        groupHash: group.plan.hash,
      },
      preparation: {
        isolation: 'worktree',
        projectRoot: initialRoot,
        changeBranch: null,
        targetBranch: null,
        worktreePath: initialRoot,
        createdBranch: false,
        createdWorktree: false,
        gitExcludeUpdated: false,
        configInitialized: false,
        group: group.plan,
        ...(setup ? { setup } : {}),
      },
    };
  }
  if (options.sourceConfig?.repositories && options.isolation !== 'current')
    throw new Error('Native multi-repository workspace requires a reviewed workspace group plan');
  if (options.isolation === 'current') {
    if (options.changeBranch || options.targetBranch || options.worktreePath) {
      throw new Error(
        'Native current isolation does not accept --change-branch, --target-branch, or --worktree-path',
      );
    }
    const context = inspectGitWorktree(initialRoot);
    if (context.isGitWorktree && context.currentBranch === null) {
      throw new Error('Native workspace binding requires a branch; detached HEAD is not supported');
    }
    return {
      projectRoot: initialRoot,
      binding: {
        isolation: 'current',
        changeBranch: context.currentBranch,
        targetBranch: context.currentBranch,
      },
      preparation: {
        isolation: 'current',
        projectRoot: initialRoot,
        changeBranch: context.currentBranch,
        targetBranch: context.currentBranch,
        worktreePath: null,
        createdBranch: false,
        createdWorktree: false,
        gitExcludeUpdated: false,
        configInitialized: false,
      },
    };
  }

  const context = inspectGitWorktree(initialRoot);
  if (
    !context.isGitWorktree ||
    context.currentBranch === null ||
    context.primaryWorktreeRoot === null ||
    context.currentWorktreeRoot === null
  ) {
    throw new Error('Native branch and worktree isolation require an attached Git branch');
  }
  const changeBranch = options.changeBranch ?? `comet/${options.name}`;
  assertValidGitBranchName(initialRoot, changeBranch);
  const alreadyPrepared = context.currentBranch === changeBranch;
  const targetBranch =
    options.targetBranch ?? (alreadyPrepared ? undefined : context.currentBranch);
  if (!targetBranch) {
    throw new Error(
      'Native isolated workspace already on its change branch requires --target-branch',
    );
  }
  assertValidGitBranchName(initialRoot, targetBranch);
  if (!isLocalGitBranch(initialRoot, targetBranch)) {
    throw new Error(`Native target branch is not a verified local branch: ${targetBranch}`);
  }

  const runtimeExcludeUpdated = await appendLocalExclude(context.primaryWorktreeRoot);

  if (options.isolation === 'branch') {
    if (options.worktreePath) {
      throw new Error('--worktree-path is only valid with --isolation worktree');
    }
    let createdBranch = false;
    if (!alreadyPrepared) {
      if (!gitWorktreeIsClean(initialRoot)) {
        throw new Error('Native branch isolation requires a clean current working directory');
      }
      if (isLocalGitBranch(initialRoot, changeBranch)) {
        throw new Error(`Native change branch already exists: ${changeBranch}`);
      }
      runGitCommand(initialRoot, ['switch', '-c', changeBranch, targetBranch]);
      createdBranch = true;
    }
    let configInitialized: boolean;
    try {
      configInitialized = await ensureConfig(initialRoot, options.sourceConfig);
    } catch (error) {
      throw new NativeWorkspacePreparationError(
        `Native branch preparation is incomplete: ${(error as Error).message}`,
        {
          isolation: 'branch',
          projectRoot: initialRoot,
          changeBranch,
          targetBranch,
          worktreePath: null,
          createdBranch,
          createdWorktree: false,
          gitExcludeUpdated: runtimeExcludeUpdated,
          configInitialized: false,
        },
        { cause: error },
      );
    }
    return {
      projectRoot: initialRoot,
      binding: { isolation: 'branch', changeBranch, targetBranch },
      preparation: {
        isolation: 'branch',
        projectRoot: initialRoot,
        changeBranch,
        targetBranch,
        worktreePath: null,
        createdBranch,
        createdWorktree: false,
        gitExcludeUpdated: runtimeExcludeUpdated,
        configInitialized,
      },
    };
  }

  if (alreadyPrepared) {
    if (!context.isSecondaryWorktree) {
      throw new Error('Native worktree isolation must use a linked Git worktree');
    }
    const requestedWorktreePath = options.worktreePath
      ? path.resolve(context.primaryWorktreeRoot, options.worktreePath)
      : undefined;
    if (requestedWorktreePath && !samePath(requestedWorktreePath, context.currentWorktreeRoot)) {
      throw new Error(
        `Native worktree path ${requestedWorktreePath} does not match the current worktree ${context.currentWorktreeRoot}`,
      );
    }
    let configInitialized: boolean;
    try {
      configInitialized = await ensureConfig(initialRoot, options.sourceConfig);
    } catch (error) {
      throw new NativeWorkspacePreparationError(
        `Native worktree preparation is incomplete: ${(error as Error).message}`,
        {
          isolation: 'worktree',
          projectRoot: initialRoot,
          changeBranch,
          targetBranch,
          worktreePath: initialRoot,
          createdBranch: false,
          createdWorktree: false,
          gitExcludeUpdated: runtimeExcludeUpdated,
          configInitialized: false,
        },
        { cause: error },
      );
    }
    return {
      projectRoot: initialRoot,
      binding: { isolation: 'worktree', changeBranch, targetBranch },
      preparation: {
        isolation: 'worktree',
        projectRoot: initialRoot,
        changeBranch,
        targetBranch,
        worktreePath: initialRoot,
        createdBranch: false,
        createdWorktree: false,
        gitExcludeUpdated: runtimeExcludeUpdated,
        configInitialized,
      },
    };
  }
  let entries = listGitWorktrees(context.primaryWorktreeRoot);
  const existing = entries.find((entry) => entry.branch === changeBranch);
  if (existing && (await pathExists(existing.root))) {
    const requestedWorktreePath = options.worktreePath
      ? path.resolve(context.primaryWorktreeRoot, options.worktreePath)
      : undefined;
    if (requestedWorktreePath && !samePath(requestedWorktreePath, existing.root)) {
      throw new Error(
        `Native worktree branch ${changeBranch} is already checked out at ${existing.root}`,
      );
    }
    let configInitialized: boolean;
    try {
      configInitialized = await ensureConfig(existing.root, options.sourceConfig);
    } catch (error) {
      throw new NativeWorkspacePreparationError(
        `Native worktree preparation is incomplete: ${(error as Error).message}`,
        {
          isolation: 'worktree',
          projectRoot: existing.root,
          changeBranch,
          targetBranch,
          worktreePath: existing.root,
          createdBranch: false,
          createdWorktree: false,
          gitExcludeUpdated: runtimeExcludeUpdated,
          configInitialized: false,
        },
        { cause: error },
      );
    }
    return {
      projectRoot: existing.root,
      binding: { isolation: 'worktree', changeBranch, targetBranch },
      preparation: {
        isolation: 'worktree',
        projectRoot: existing.root,
        changeBranch,
        targetBranch,
        worktreePath: existing.root,
        createdBranch: false,
        createdWorktree: false,
        gitExcludeUpdated: runtimeExcludeUpdated,
        configInitialized,
      },
    };
  }
  if (existing && !(await pathExists(existing.root))) {
    runGitCommand(context.primaryWorktreeRoot, ['worktree', 'prune']);
    entries = listGitWorktrees(context.primaryWorktreeRoot);
  }
  const branchExists = isLocalGitBranch(initialRoot, changeBranch);
  if (entries.some((entry) => entry.branch === changeBranch)) {
    throw new Error(`Native change branch ${changeBranch} is already registered to a worktree`);
  }
  const worktreePath = resolveWorktreePath(
    context.primaryWorktreeRoot,
    options.name,
    options.worktreePath,
  );
  await assertPathAbsent(worktreePath);
  const worktreeExcludeUpdated = await appendLocalExclude(
    context.primaryWorktreeRoot,
    worktreePath,
  );
  const gitExcludeUpdated = runtimeExcludeUpdated || worktreeExcludeUpdated;
  const preparation: NativeWorkspacePreparation = {
    isolation: 'worktree',
    projectRoot: worktreePath,
    changeBranch,
    targetBranch,
    worktreePath,
    createdBranch: false,
    createdWorktree: false,
    gitExcludeUpdated,
    configInitialized: false,
  };
  try {
    runGitCommand(
      context.primaryWorktreeRoot,
      branchExists
        ? ['worktree', 'add', worktreePath, changeBranch]
        : ['worktree', 'add', '-b', changeBranch, worktreePath, targetBranch],
    );
    preparation.createdBranch = !branchExists;
    preparation.createdWorktree = true;
    preparation.configInitialized = await ensureConfig(worktreePath, options.sourceConfig);
  } catch (error) {
    throw new NativeWorkspacePreparationError(
      `Native worktree preparation is incomplete: ${(error as Error).message}`,
      preparation,
      { cause: error },
    );
  }
  return {
    projectRoot: worktreePath,
    binding: { isolation: 'worktree', changeBranch, targetBranch },
    preparation,
  };
}
