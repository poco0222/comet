import { promises as fs } from 'node:fs';
import path from 'node:path';

import { inspectGitWorktree, samePath } from '../../platform/paths/git-worktree.js';
import { normalizeWorkflowRelativePath } from '../workflow-contract/project-config.js';
import { defaultProjectConfig, readProjectConfig } from './native-config.js';
import { atomicWriteText } from './native-atomic-file.js';
import {
  discoverWorkflowCapabilityCandidates,
  renderCapabilityAssociationDraft,
} from '../project-knowledge/capability-discovery.js';
import { readNativeBoundedTextFile } from './native-bounded-file.js';
import {
  inspectNativeTotalSpec,
  nativeLegacySectionHash,
  nativeTotalSpecHash,
  renderNativeDelta,
  type NativeDeltaDocument,
} from './native-delta-spec.js';
import {
  createNativeCapabilityKnowledgeProvider,
  readNativeCapabilityDiscoveryCache,
  writeNativeCapabilityDiscoveryCache,
} from './native-capability-discovery.js';
import {
  ensureNativeDirectories,
  nativeChangeArtifactPaths,
  nativeProjectPaths,
  PROJECT_CONFIG_FILE,
} from './native-paths.js';
import { nativePortableContinuation } from './native-portable-continuation.js';
import { createNativePortableChange, nativePortableChangeDir } from './native-portable-runtime.js';
import { selectNativeChange } from './native-selection.js';
import { prepareNativeWorkspace } from './native-workspace-preparation.js';
import {
  planNativeWorkspaceGroup,
  readNativeWorkspaceGroup,
  readNativeWorkspaceGroupPlan,
  readNativeWorkspaceGroupRecord,
} from './native-workspace-group.js';
import { recordNativeWorkspaceConfig } from './native-workspace-config.js';
import { planNativeWorkspaceSetup } from './native-workspace-setup.js';
import { canonicalHash } from './native-canonical-hash.js';
import { type NativeWorkspaceIsolation } from './native-workspace.js';
import { ensureCometProjectGitignore } from '../workflow-contract/project-gitignore.js';
import {
  assertChangeNotSdkOwned,
  readSdkChangeOwner,
} from '../workflow-contract/change-runtime-owner.js';
import { inspectNativeSdkRun } from './native-runtime-ownership.js';
import { createNativeSdkChange } from './native-sdk-create.js';
import { parseNativePortableState } from './native-portable-state.js';
import { projectNativeSdkStatus } from './native-sdk-status.js';
import type { CometProjectConfig } from './native-types.js';
import {
  assertNoArguments,
  languageOption,
  NativeUsageError,
  requiredPositional,
  success,
  takeOption,
  takeFlag,
  type DispatchResult,
} from './native-cli-shared.js';

async function initializeNativeDeltaProposal(options: {
  paths: Awaited<ReturnType<typeof nativeProjectPaths>>;
  changeName: string;
  capability: string;
}): Promise<{ specSource: string; deltaSource: string; baseHash: string }> {
  const canonical = await readNativeBoundedTextFile({
    root: options.paths.specsDir,
    ref: `${options.capability}/spec.md`,
    maxBytes: null,
    includeHash: false,
  });
  const capabilitySegments = options.capability.split('/');
  const changeRoot = nativePortableChangeDir(options.paths, options.changeName);
  const specSource = `specs/${options.capability}/spec.md`;
  const deltaSource = `specs/${options.capability}/delta.yaml`;
  await fs.mkdir(path.join(changeRoot, 'specs', ...capabilitySegments), { recursive: true });
  await atomicWriteText(path.join(changeRoot, ...specSource.split('/')), canonical.text, {
    containedRoot: options.paths.nativeRoot,
  });
  const baseHash = nativeTotalSpecHash(canonical.text);
  const inspected = inspectNativeTotalSpec(canonical.text);
  const delta: NativeDeltaDocument = {
    schema: 'comet.native.delta.v1',
    capability: options.capability,
    base_hash: baseHash,
    base_version: 1,
    legacy_hash: nativeLegacySectionHash(canonical.text),
    base_requirements: Object.fromEntries(
      inspected.requirements.map((requirement) => [
        requirement.id,
        nativeTotalSpecHash(requirement.raw),
      ]),
    ),
    operations: [],
  };
  await atomicWriteText(
    path.join(changeRoot, ...deltaSource.split('/')),
    renderNativeDelta(delta),
    { containedRoot: options.paths.nativeRoot },
  );
  return { specSource, deltaSource, baseHash };
}

async function discoverNativeCapability(
  projectRoot: string,
  artifactRoot: string,
  task: string | undefined,
  capability: string | undefined,
) {
  if (!task && !capability) return null;
  const diagnostics: Array<{ code: string; message: string }> = [];
  const scope = {
    workflow: 'native' as const,
    currentSpecRoot: `${artifactRoot}/comet/specs`,
    archiveRoot: `${artifactRoot}/comet/archive`,
  };
  try {
    if (task && !capability) {
      const cached = await readNativeCapabilityDiscoveryCache({
        projectRoot,
        scope,
        task,
      });
      if (cached) return cached;
    }
    const provider = capability
      ? undefined
      : await createNativeCapabilityKnowledgeProvider({
          projectRoot,
          scope,
          reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        });
    const result = await discoverWorkflowCapabilityCandidates({
      projectRoot,
      scope,
      ...(provider ? { provider } : {}),
      ...(task ? { task } : {}),
      ...(capability ? { capability } : {}),
    });
    const combined = { ...result, diagnostics: [...diagnostics, ...result.diagnostics] };
    if (task && !capability) {
      await writeNativeCapabilityDiscoveryCache({
        projectRoot,
        scope,
        task,
        result: combined,
      });
    }
    return combined;
  } catch (error) {
    if (capability) throw error;
    return {
      workflow: 'native' as const,
      query: null,
      candidates: [],
      associationDraft: null,
      diagnostics: [
        ...diagnostics,
        {
          code: 'capability-discovery',
          message: `能力候选召回不可用，未自动关联：${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      searched: Boolean(task),
      providerLimit: 40,
    };
  }
}

async function suggestNativeRepositoryRegistration(
  projectRoot: string,
  config: CometProjectConfig | null,
  language: 'en' | 'zh-CN',
): Promise<void> {
  if (
    inspectGitWorktree(projectRoot).isGitWorktree ||
    (await readNativeWorkspaceGroupRecord(projectRoot))
  )
    return;
  const artifactDirectory = (config?.native.artifact_root ?? 'docs').split('/')[0];
  const repositories: string[] = [];
  for (const entry of await fs.readdir(projectRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === artifactDirectory)
      continue;
    try {
      if (normalizeWorkflowRelativePath(entry.name, 'repositories.path') !== entry.name) continue;
    } catch {
      continue;
    }
    const root = path.join(projectRoot, entry.name);
    const git = await fs.lstat(path.join(root, '.git')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!git?.isDirectory() && !git?.isFile()) continue;
    const checkout = inspectGitWorktree(root);
    if (
      checkout.currentWorktreeRoot &&
      samePath(root, checkout.currentWorktreeRoot) &&
      !checkout.isSecondaryWorktree
    )
      repositories.push(entry.name);
  }
  if (!repositories.length) return;
  const message =
    language === 'zh-CN'
      ? `在项目根目录下发现 Git 仓库，当前项目尚未登记子仓。${config ? '' : '请先在项目根目录运行 comet native init。'}确认参与范围后，把选中的条目加入 ${PROJECT_CONFIG_FILE} 顶层，再重试原命令。`
      : `Found Git repositories directly under the project root, but none are registered.${config ? '' : ' Run comet native init from the project root first.'} Confirm which repositories to include, add the selected entries to the top level of ${PROJECT_CONFIG_FILE}, then retry.`;
  const entries = repositories.sort().map((ref) => `  - path: ${JSON.stringify(ref)}`);
  throw new NativeUsageError([message, '', 'repositories:', ...entries].join('\n'));
}

export async function nativeNewCommand(
  args: string[],
  projectRoot: string,
): Promise<DispatchResult> {
  const name = requiredPositional(args, 'change name');
  let config = await readProjectConfig(projectRoot);
  const language = languageOption(args, config?.native.language ?? 'en');
  const isolation = (takeOption(args, '--isolation') ?? 'current') as NativeWorkspaceIsolation;
  if (isolation !== 'current' && isolation !== 'branch' && isolation !== 'worktree') {
    throw new NativeUsageError('--isolation must be current, branch, or worktree');
  }
  const changeBranch = takeOption(args, '--change-branch');
  const targetBranch = takeOption(args, '--target-branch');
  const worktreePath = takeOption(args, '--worktree-path');
  const dryRun = takeFlag(args, '--dry-run');
  const planHash = takeOption(args, '--plan-hash');
  const setupFile = takeOption(args, '--setup');
  const task = takeOption(args, '--task');
  if (task !== undefined && !task.trim()) throw new NativeUsageError('--task must not be empty');
  const capability = takeOption(args, '--capability');
  const runtimeFormat = takeOption(args, '--runtime') ?? 'sdk';
  if (runtimeFormat !== 'compat' && runtimeFormat !== 'sdk') {
    throw new NativeUsageError('--runtime must be compat or sdk');
  }
  assertNoArguments(args);
  if (runtimeFormat === 'compat') await assertChangeNotSdkOwned(projectRoot, 'native', name);
  const sourceConfig = config;
  if (config?.native.pending_root_move) {
    throw new Error(`Native root move ${config.native.pending_root_move.id} is incomplete`);
  }
  if (runtimeFormat === 'sdk' && isolation === 'worktree' && !config?.repositories) {
    await suggestNativeRepositoryRegistration(projectRoot, config, language);
  }
  let groupPlan;
  if (config?.repositories) {
    if (runtimeFormat !== 'sdk') throw new Error('Native workspace groups require --runtime sdk');
    const currentGroup = await readNativeWorkspaceGroup(projectRoot);
    if (!currentGroup) {
      const setup = setupFile
        ? await planNativeWorkspaceSetup(projectRoot, setupFile, config.repositories)
        : undefined;
      if (isolation !== 'worktree' || changeBranch || targetBranch)
        throw new NativeUsageError(
          'Native repository groups require --isolation worktree; configure target_branch separately for each repository',
        );
      groupPlan =
        (await readNativeWorkspaceGroupPlan(projectRoot, name)) ??
        (await planNativeWorkspaceGroup({
          projectRoot,
          name,
          repositories: config.repositories.map((entry) => ({
            path: entry.path,
            ...(entry.target_branch ? { targetBranch: entry.target_branch } : {}),
          })),
          ...(worktreePath ? { worktreePath } : {}),
          configuration: sourceConfig,
          ...(setup ? { setup } : {}),
        }));
      if (
        setup &&
        canonicalHash('setup', setup) !== canonicalHash('setup', groupPlan.setup ?? null)
      )
        throw new Error(
          'Workspace setup differs from the original creation plan; use its recorded setup or create another task',
        );
      if (worktreePath && path.resolve(projectRoot, worktreePath) !== groupPlan.projectRoot)
        throw new Error('Native workspace path differs from the original creation plan');
      if (planHash !== undefined && planHash !== groupPlan.hash)
        throw new Error(
          'Native workspace preflight changed; inspect --dry-run before retrying with its --plan-hash',
        );
      if (dryRun)
        return success(
          'new',
          { dryRun: true, plan: groupPlan },
          `Prepared Native workspace group plan ${groupPlan.hash}\n`,
        );
    } else if (dryRun || planHash || setupFile)
      throw new NativeUsageError('Use the coordinator root to inspect the workspace creation plan');
  } else if (dryRun || planHash || setupFile)
    throw new NativeUsageError(
      '--dry-run, --plan-hash and --setup require configured repositories',
    );
  const prepared = await prepareNativeWorkspace({
    projectRoot,
    name,
    isolation,
    ...(changeBranch ? { changeBranch } : {}),
    ...(targetBranch ? { targetBranch } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    sourceConfig,
    ...(groupPlan ? { groupPlan } : {}),
  });
  projectRoot = prepared.projectRoot;
  if (runtimeFormat === 'compat') await assertChangeNotSdkOwned(projectRoot, 'native', name);
  config = await readProjectConfig(projectRoot);
  const initialProjectConfig = config === null ? defaultProjectConfig('docs', language) : undefined;
  if (!config) config = initialProjectConfig!;
  if (config.native.pending_root_move) {
    throw new Error(`Native root move ${config.native.pending_root_move.id} is incomplete`);
  }
  const paths = await nativeProjectPaths(projectRoot, config.native.artifact_root);
  if (prepared.binding.groupHash && (await readSdkChangeOwner(projectRoot, 'native', name))) {
    const existing = await inspectNativeSdkRun(projectRoot, name);
    const input = existing.run.input as { task?: string };
    if (
      existing.state.workspace.group_hash !== prepared.binding.groupHash ||
      (task !== undefined && task !== input.task)
    )
      throw new Error('Native task creation recovery differs from the original Run');
    return {
      executionCwd: projectRoot,
      ...success(
        'new',
        {
          ...(await projectNativeSdkStatus({ projectRoot, name }, existing)),
          preparation: prepared.preparation,
          resumed: true,
        },
        `Resumed Native change ${name}\n`,
      ),
    };
  }
  await ensureNativeDirectories(paths);
  // 保留旧 Runtime 路径及迁移 fence 的 Git 排除，避免兼容文件进入候选输入。
  await ensureCometProjectGitignore(projectRoot);
  const capabilityDiscovery = await discoverNativeCapability(
    projectRoot,
    config.native.artifact_root,
    task,
    capability,
  );
  const sdkRun =
    runtimeFormat === 'sdk'
      ? await createNativeSdkChange({
          paths,
          name,
          language,
          ...(task === undefined ? {} : { task }),
          workspaceBinding: prepared.binding,
          ...(initialProjectConfig ? { initialProjectConfig } : {}),
        })
      : null;
  const state = sdkRun
    ? parseNativePortableState(sdkRun.state)
    : await createNativePortableChange({
        paths,
        name,
        language,
        workspaceBinding: prepared.binding,
        ...(initialProjectConfig ? { initialProjectConfig } : {}),
      });
  let associationPath: string | undefined;
  let deltaProposal: Awaited<ReturnType<typeof initializeNativeDeltaProposal>> | undefined;
  if (capabilityDiscovery?.associationDraft) {
    deltaProposal = await initializeNativeDeltaProposal({
      paths,
      changeName: state.name,
      capability: capabilityDiscovery.associationDraft.capability,
    });
    associationPath = path.join(
      nativePortableChangeDir(paths, state.name),
      'capability-association.yaml',
    );
    await atomicWriteText(
      associationPath,
      renderCapabilityAssociationDraft(capabilityDiscovery.associationDraft),
      { containedRoot: paths.nativeRoot },
    );
  }
  await selectNativeChange(paths, state.name);
  if (initialProjectConfig) await recordNativeWorkspaceConfig(projectRoot);
  return {
    executionCwd: projectRoot,
    ...success(
      'new',
      {
        ...state,
        artifacts: nativeChangeArtifactPaths(paths, state.name),
        preparation: prepared.preparation,
        ...(capabilityDiscovery === null
          ? {}
          : {
              capabilityDiscovery,
              ...(associationPath === undefined ? {} : { associationPath }),
              ...(deltaProposal === undefined ? {} : { deltaProposal }),
            }),
        ...(sdkRun
          ? {
              ...(await projectNativeSdkStatus(
                { projectRoot, name },
                { run: sdkRun, state, artifactRootRef: paths.artifactRootRef, application: null },
              )),
              ...state,
            }
          : { continuation: nativePortableContinuation(state) }),
      },
      `Created Native change ${state.name}\n`,
    ),
  };
}
