import { resolveWorkspaceRuntimeRootSync } from '../workflow-contract/workspace-runtime.js';
import {
  cometHookRuntimeTargetCandidates,
  isCometHookTargetWithin,
} from '../workflow-contract/hook-target-scope.js';
import { promises as fs } from 'fs';
import path from 'path';

import { listGitWorktreeRoots } from '../../platform/paths/git-worktree.js';
import type { CometHookRequest } from './hook-types.js';
import { readHookCurrentSelection } from '../workflow-contract/current-selection.js';
import {
  bindWorkspaceGroupSession,
  findWorkspaceGroupRoot,
  findWorkspaceGroupSourceCoordinator,
  findWorkspaceGroupIntegrationRoot,
  readWorkspaceGroupIntegration,
  listWorkspaceGroupIntegrations,
  listWorkspaceGroups,
  readWorkspaceGroup,
  readWorkspaceGroupSession,
} from '../workflow-contract/workspace-group.js';

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function owningWorktree(candidate: string, roots: readonly string[]): string | null {
  return (
    [...roots]
      .sort((left, right) => right.length - left.length)
      .find((root) => isWithin(root, candidate)) ?? null
  );
}

async function assertRebasedWorktreeReady(projectRoot: string): Promise<void> {
  const selected = await readHookCurrentSelection(projectRoot);
  const applicationSelected =
    selected.status === 'selected' && selected.selection.workflow === 'application';
  for (const marker of ['.git', path.join('.comet', 'config.yaml')]) {
    if (marker !== '.git' && applicationSelected) continue;
    try {
      await fs.lstat(path.join(projectRoot, marker));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new Error(
        `linked worktree ${projectRoot} is not initialized for Comet: missing ${marker.replaceAll('\\', '/')}`,
        { cause: error },
      );
    }
  }
}

export async function resolveCometHookProjectRoot(
  explicitProjectRoot: string,
  request: CometHookRequest,
): Promise<string> {
  const explicitRoot = path.resolve(explicitProjectRoot);
  const integrationRoot = await findWorkspaceGroupIntegrationRoot(explicitRoot);
  const integration = integrationRoot ? await readWorkspaceGroupIntegration(integrationRoot) : null;
  const boundRoot = integration?.taskRoot ?? (await findWorkspaceGroupRoot(explicitRoot));
  const bound = boundRoot ? await readWorkspaceGroup(boundRoot) : null;
  const coordinatorRoot =
    bound?.coordinatorRoot ??
    (await findWorkspaceGroupSourceCoordinator(explicitRoot)) ??
    explicitRoot;
  const groups = await listWorkspaceGroups(coordinatorRoot);
  if (groups.length) {
    const taskRoots = groups.map((group) => group.projectRoot);
    const integrations = await listWorkspaceGroupIntegrations(coordinatorRoot);
    const allRoots = [
      ...taskRoots,
      coordinatorRoot,
      ...integrations.map((item) => item.projectRoot),
    ];
    const ownerOf = (root: string) =>
      integrations.find((item) => item.projectRoot === root)?.taskRoot ?? root;
    const cwdRoot = request.cwd ? owningWorktree(path.resolve(request.cwd), allRoots) : null;
    const owners = new Set<string>();
    const session = request.sessionId
      ? await readWorkspaceGroupSession(coordinatorRoot, request.sessionId)
      : null;
    if (session) owners.add(session.projectRoot);
    if (boundRoot) owners.add(boundRoot);
    if (cwdRoot && taskRoots.includes(ownerOf(cwdRoot))) owners.add(ownerOf(cwdRoot));
    for (const target of request.targets) {
      const absolute = path.isAbsolute(target)
        ? target
        : `${request.cwd ?? explicitRoot}${path.sep}${target}`;
      for (const root of allRoots) {
        const integration = integrations.find((item) => item.projectRoot === root);
        if (await isCometHookTargetWithin(root, absolute)) {
          if (integration && !(await readWorkspaceGroupIntegration(root)))
            throw new Error('Workspace group integration registration is incomplete');
          owners.add(ownerOf(root));
        }
        for (const candidate of cometHookRuntimeTargetCandidates(
          explicitRoot,
          target,
          request.cwd,
        )) {
          // Retained integration roots keep their identity and routing after member cleanup.
          if (
            integration &&
            request.intent === 'write' &&
            ((await isCometHookTargetWithin(resolveWorkspaceRuntimeRootSync(root), candidate)) ||
              (await isCometHookTargetWithin(path.join(root, '.comet/runtime'), candidate)))
          )
            throw new Error(
              'Comet Runtime-owned integration files must be maintained by Runtime commands',
            );
          if (await isCometHookTargetWithin(resolveWorkspaceRuntimeRootSync(root), candidate))
            owners.add(ownerOf(root));
        }
      }
    }
    if (owners.size > 1)
      throw new Error(
        'one Hook request cannot write across multiple task workspaces' +
          (session
            ? `; session is bound to ${session.name} at ${session.projectRoot}. From coordinator ${coordinatorRoot}, use comet native select <change-name> --session <actual-session> to explicitly switch tasks`
            : ''),
      );
    const owner = [...owners][0];
    if (owner && owner !== coordinatorRoot) {
      const group = await readWorkspaceGroup(owner);
      if (!group) throw new Error(`Workspace group registration is incomplete: ${owner}`);
      if (request.intent === 'write') {
        if (request.sessionId) await bindWorkspaceGroupSession(group, request.sessionId);
        else if (!boundRoot && !taskRoots.includes(cwdRoot ?? ''))
          throw new Error(
            `Task writes from the coordinator require a Hook session ID; run this tool from the task directory ${owner}`,
          );
      }
      return owner;
    }
  }
  if (request.targets.length === 0) return explicitRoot;
  const roots = listGitWorktreeRoots(explicitRoot);
  if (roots.length < 2) return explicitRoot;

  const cwdOwner = request.cwd ? owningWorktree(path.resolve(request.cwd), roots) : null;
  const relativeTargetBase = cwdOwner ?? explicitRoot;
  const owners = new Map<string, string>();
  let runtimeTarget = false;

  const addOwner = (owner: string) => {
    const key = process.platform === 'win32' ? owner.toLowerCase() : owner;
    owners.set(key, owner);
  };
  for (const target of request.targets) {
    let runtimeOwnerFound = false;
    for (const candidate of cometHookRuntimeTargetCandidates(explicitRoot, target, request.cwd)) {
      for (const root of roots) {
        if (await isCometHookTargetWithin(resolveWorkspaceRuntimeRootSync(root), candidate)) {
          addOwner(root);
          runtimeTarget = true;
          runtimeOwnerFound = true;
        }
      }
    }
    if (runtimeOwnerFound) continue;
    const absoluteTarget = path.isAbsolute(target)
      ? path.resolve(target)
      : path.resolve(relativeTargetBase, target);
    const owner = owningWorktree(absoluteTarget, roots);
    if (owner) addOwner(owner);
  }

  if (owners.size === 0) return explicitRoot;
  if (owners.size > 1) {
    throw new Error('one Hook request cannot write across multiple Git worktrees');
  }

  const [selectedRoot] = owners.values();
  if (!runtimeTarget && !samePath(selectedRoot, explicitRoot)) {
    await assertRebasedWorktreeReady(selectedRoot);
  }
  return selectedRoot;
}
