import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  resolveCometDataRoot,
  resolveWorkspaceIdentity,
  resolveWorkspaceRuntimeLocation,
} from '../../platform/paths/workspace-runtime.js';
import { runGitCommand } from '../../platform/process/git.js';
import { samePath } from '../../platform/paths/git-worktree.js';
import { inspectProtectedProjectPath, readProtectedProjectFile } from './protected-project-path.js';
import { atomicWriteContainedJson } from './contained-atomic-write.js';
import { withRecoverableFileLock } from '../../platform/fs/recoverable-file-lock.js';

/** 仅描述目录归属；任务阶段和推进历史仍属于原 SDK Run。 */
export interface WorkspaceGroupRegistration {
  schema: 'comet.workspace-group.v1';
  name: string;
  planHash: string;
  coordinatorRoot: string;
  coordinatorId: string;
  projectRoot: string;
  workspaceId: string;
  repositories: Array<{
    path: string;
    workspaceId: string;
    sourceWorkspaceId: string;
    commonDir: string;
    branch: string;
  }>;
}

function parseRegistration(value: unknown): WorkspaceGroupRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid workspace group registration');
  const group = value as WorkspaceGroupRegistration;
  if (
    Object.keys(group).some(
      (key) =>
        ![
          'schema',
          'name',
          'planHash',
          'coordinatorRoot',
          'coordinatorId',
          'projectRoot',
          'workspaceId',
          'repositories',
        ].includes(key),
    )
  )
    throw new Error('Unknown workspace group registration field');
  if (
    group.schema !== 'comet.workspace-group.v1' ||
    typeof group.name !== 'string' ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(group.name) ||
    ![group.planHash, group.coordinatorId, group.workspaceId].every(
      (id) => typeof id === 'string' && /^[a-f0-9]{64}$/u.test(id),
    ) ||
    ![group.projectRoot, group.coordinatorRoot].every(
      (root) => typeof root === 'string' && path.isAbsolute(root) && path.resolve(root) === root,
    ) ||
    !Array.isArray(group.repositories) ||
    !group.repositories.length
  )
    throw new Error('Invalid workspace group registration');
  for (const [parent, target] of [
    [group.projectRoot, group.coordinatorRoot],
    [group.coordinatorRoot, group.projectRoot],
  ]) {
    const relative = path.relative(parent, target);
    if (
      relative === '' ||
      (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    )
      throw new Error('Workspace group task and coordinator directories overlap');
  }
  const paths: string[] = [],
    commonDirs: string[] = [];
  for (const entry of group.repositories) {
    if (
      !entry ||
      Object.keys(entry).some(
        (key) => !['path', 'workspaceId', 'sourceWorkspaceId', 'commonDir', 'branch'].includes(key),
      ) ||
      typeof entry.path !== 'string' ||
      !entry.path ||
      entry.path.includes('\\') ||
      path.isAbsolute(entry.path) ||
      entry.path.split('/').some((part) => !part || part.startsWith('.')) ||
      ![entry.workspaceId, entry.sourceWorkspaceId].every(
        (id) => typeof id === 'string' && /^[a-f0-9]{64}$/u.test(id),
      ) ||
      typeof entry.commonDir !== 'string' ||
      !path.isAbsolute(entry.commonDir) ||
      typeof entry.branch !== 'string' ||
      !entry.branch
    )
      throw new Error('Invalid workspace group repository registration');
    if (
      paths.some(
        (ref) =>
          ref === entry.path ||
          ref.startsWith(`${entry.path}/`) ||
          entry.path.startsWith(`${ref}/`),
      ) ||
      commonDirs.includes(entry.commonDir)
    )
      throw new Error('Overlapping workspace group repositories');
    paths.push(entry.path);
    commonDirs.push(entry.commonDir);
  }
  return group;
}

async function readRegistration(
  root: string,
  ref: string,
): Promise<WorkspaceGroupRegistration | null> {
  try {
    const { bytes } = await readProtectedProjectFile(root, ref, Number.MAX_SAFE_INTEGER, {
      label: 'workspace group registration',
    });
    return parseRegistration(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function assertWorkspaceGroupRegistration(
  group: WorkspaceGroupRegistration,
): Promise<void> {
  assertWorkspaceGroupRoots(group);
  await assertWorkspaceGroupMembers(group);
}

function assertWorkspaceGroupRoots(group: WorkspaceGroupRegistration): void {
  parseRegistration(group);
  for (const [root, id] of [
    [group.coordinatorRoot, group.coordinatorId],
    [group.projectRoot, group.workspaceId],
  ]) {
    const actual = resolveWorkspaceIdentity(root);
    if (actual.projectRoot !== root || actual.workspaceId !== id)
      throw new Error(`Workspace group directory identity changed: ${root}`);
  }
}

async function assertWorkspaceGroupMembers(
  group: WorkspaceGroupRegistration,
  retired: readonly string[] = [],
): Promise<void> {
  if (retired.some((ref) => !group.repositories.some((entry) => entry.path === ref)))
    throw new Error('Unknown retired workspace group repository');
  for (const entry of group.repositories) {
    const root = path.join(group.projectRoot, entry.path);
    if (retired.includes(entry.path)) {
      let missing = false;
      try {
        await fs.lstat(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        missing = true;
      }
      if (
        !missing ||
        runGitCommand(path.join(group.coordinatorRoot, entry.path), [
          'worktree',
          'list',
          '--porcelain',
          '-z',
        ])
          .split('\0')
          .some(
            (line) =>
              line.startsWith('worktree ') && samePath(line.slice('worktree '.length), root),
          )
      )
        throw new Error(`Retired workspace group repository was reused: ${root}`);
      continue;
    }
    const identity = resolveWorkspaceIdentity(root);
    const source = resolveWorkspaceIdentity(path.join(group.coordinatorRoot, entry.path));
    const common = await fs.realpath(
      path.resolve(root, runGitCommand(root, ['rev-parse', '--git-common-dir'])),
    );
    if (
      identity.projectRoot !== root ||
      identity.workspaceId !== entry.workspaceId ||
      source.projectRoot !== path.join(group.coordinatorRoot, entry.path) ||
      source.workspaceId !== entry.sourceWorkspaceId ||
      common !== entry.commonDir ||
      (await fs.realpath(runGitCommand(root, ['rev-parse', '--show-toplevel']))) !== root ||
      runGitCommand(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== entry.branch
    )
      throw new Error(`Workspace group repository identity or branch changed: ${root}`);
  }
}

export async function registerWorkspaceGroup(group: WorkspaceGroupRegistration): Promise<void> {
  await assertWorkspaceGroupRegistration(group);
  for (const [root, ref] of [
    [group.coordinatorRoot, `workspace-groups/${group.name}.json`],
    [group.projectRoot, 'workspace-group.json'],
  ]) {
    const { runtimeRoot } = resolveWorkspaceRuntimeLocation(root);
    await fs.mkdir(runtimeRoot, { recursive: true });
    const existing = await readRegistration(runtimeRoot, ref);
    if (existing) {
      if (!isDeepStrictEqual(existing, group))
        throw new Error(
          `Workspace group registration already differs: ${path.join(runtimeRoot, ref)}`,
        );
    } else
      await atomicWriteContainedJson(path.join(runtimeRoot, ref), group, {
        containedRoot: runtimeRoot,
        exclusive: true,
      });
  }
}

export async function readWorkspaceGroup(
  projectRoot: string,
): Promise<WorkspaceGroupRegistration | null> {
  const group = await readWorkspaceGroupRecord(projectRoot);
  if (group) await assertWorkspaceGroupMembers(group);
  return group;
}

async function readWorkspaceGroupRecord(
  projectRoot: string,
): Promise<WorkspaceGroupRegistration | null> {
  const location = resolveWorkspaceRuntimeLocation(projectRoot);
  const group = await readRegistration(location.runtimeRoot, 'workspace-group.json');
  if (!group) return null;
  if (group.projectRoot !== location.projectRoot || group.workspaceId !== location.workspaceId)
    throw new Error('Workspace group belongs to a different task root');
  const registryRoot = resolveWorkspaceRuntimeLocation(group.coordinatorRoot).runtimeRoot;
  const registered = await readRegistration(registryRoot, `workspace-groups/${group.name}.json`);
  if (!isDeepStrictEqual(registered, group))
    throw new Error('Workspace group is missing from its coordinator registry');
  assertWorkspaceGroupRoots(group);
  return group;
}

export async function listWorkspaceGroups(
  coordinatorRoot: string,
): Promise<WorkspaceGroupRegistration[]> {
  const location = resolveWorkspaceRuntimeLocation(coordinatorRoot);
  let names: string[];
  try {
    await inspectProtectedProjectPath(location.runtimeRoot, 'workspace-groups', {
      label: 'workspace group registry',
      expected: 'directory',
    });
    names = await fs.readdir(path.join(location.runtimeRoot, 'workspace-groups'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const groups: WorkspaceGroupRegistration[] = [];
  for (const name of names.sort()) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.json$/u.test(name))
      throw new Error(`Invalid workspace group registry entry: ${name}`);
    const group = await readRegistration(location.runtimeRoot, `workspace-groups/${name}`);
    if (
      !group ||
      group.coordinatorRoot !== location.projectRoot ||
      group.coordinatorId !== location.workspaceId ||
      `${group.name}.json` !== name
    )
      throw new Error(`Workspace group registry identity changed: ${name}`);
    groups.push(group);
  }
  return groups;
}

function sessionRef(sessionId: string): string {
  if (!sessionId.trim()) throw new Error('Workspace group requires a non-empty session ID');
  return `workspace-group-session-${createHash('sha256').update(sessionId).digest('hex')}.json`;
}

interface WorkspaceGroupIntegration {
  schema: 'comet.workspace-group-integration.v1';
  id: string;
  taskRoot: string;
  groupHash: string;
  projectRoot: string;
  workspaceId: string;
}

async function readIntegration(
  root: string,
  ref: string,
): Promise<WorkspaceGroupIntegration | null> {
  try {
    const { bytes } = await readProtectedProjectFile(root, ref, Number.MAX_SAFE_INTEGER, {
      label: 'workspace group integration',
    });
    const value = JSON.parse(bytes.toString('utf8')) as WorkspaceGroupIntegration;
    if (
      !value ||
      value.schema !== 'comet.workspace-group-integration.v1' ||
      Object.keys(value).some(
        (key) =>
          !['schema', 'id', 'taskRoot', 'groupHash', 'projectRoot', 'workspaceId'].includes(key),
      ) ||
      typeof value.id !== 'string' ||
      !/^[a-f0-9-]{36}$/u.test(value.id) ||
      ![value.taskRoot, value.projectRoot].every(
        (root) => typeof root === 'string' && path.isAbsolute(root) && path.resolve(root) === root,
      ) ||
      ![value.groupHash, value.workspaceId].every(
        (id) => typeof id === 'string' && /^[a-f0-9]{64}$/u.test(id),
      ) ||
      value.projectRoot !==
        path.join(path.dirname(value.taskRoot), `.comet-integration-${value.id}`)
    )
      throw new Error('Invalid workspace group integration registration');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readWorkspaceGroupIntegration(projectRoot: string) {
  const location = resolveWorkspaceRuntimeLocation(projectRoot);
  const value = await readIntegration(location.runtimeRoot, 'workspace-group-integration.json');
  if (!value) return null;
  const group = await readWorkspaceGroupRecord(value.taskRoot);
  if (
    !group ||
    group.planHash !== value.groupHash ||
    value.projectRoot !== location.projectRoot ||
    value.workspaceId !== location.workspaceId ||
    !isDeepStrictEqual(
      value,
      await readIntegration(
        resolveWorkspaceRuntimeLocation(group.coordinatorRoot).runtimeRoot,
        `workspace-group-integrations/${value.id}.json`,
      ),
    )
  )
    throw new Error('Workspace group integration identity or registration changed');
  return { ...value, group };
}

export async function registerWorkspaceGroupIntegration(
  taskRoot: string,
  projectRoot: string,
  id: string,
): Promise<void> {
  const group = await readWorkspaceGroup(taskRoot);
  if (
    !group ||
    !/^[a-f0-9-]{36}$/u.test(id) ||
    projectRoot !== path.join(path.dirname(taskRoot), `.comet-integration-${id}`)
  )
    throw new Error('Integration must belong to its registered workspace group');
  const identity = resolveWorkspaceIdentity(projectRoot);
  if (identity.projectRoot !== projectRoot) throw new Error('Integration path must be canonical');
  const value: WorkspaceGroupIntegration = {
    schema: 'comet.workspace-group-integration.v1',
    id,
    taskRoot,
    groupHash: group.planHash,
    projectRoot,
    workspaceId: identity.workspaceId,
  };
  for (const [root, ref] of [
    [group.coordinatorRoot, `workspace-group-integrations/${id}.json`],
    [projectRoot, 'workspace-group-integration.json'],
  ]) {
    const { runtimeRoot } = resolveWorkspaceRuntimeLocation(root);
    const previous = await readIntegration(runtimeRoot, ref);
    if (previous) {
      if (!isDeepStrictEqual(previous, value))
        throw new Error('Integration registration already differs');
    } else {
      await fs.mkdir(runtimeRoot, { recursive: true });
      await atomicWriteContainedJson(path.join(runtimeRoot, ref), value, {
        containedRoot: runtimeRoot,
        exclusive: true,
      });
    }
  }
}

export async function listWorkspaceGroupIntegrations(
  coordinatorRoot: string,
): Promise<WorkspaceGroupIntegration[]> {
  const { runtimeRoot } = resolveWorkspaceRuntimeLocation(coordinatorRoot);
  const directory = 'workspace-group-integrations';
  let files: string[];
  try {
    await inspectProtectedProjectPath(runtimeRoot, directory, {
      expected: 'directory',
      label: 'workspace group integrations',
    });
    files = await fs.readdir(path.join(runtimeRoot, directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const groups = await listWorkspaceGroups(coordinatorRoot);
  const result: WorkspaceGroupIntegration[] = [];
  for (const file of files) {
    if (!/^[a-f0-9-]{36}\.json$/u.test(file)) throw new Error('Invalid integration registry entry');
    const value = await readIntegration(runtimeRoot, `${directory}/${file}`);
    if (
      !value ||
      `${value.id}.json` !== file ||
      !groups.some(
        (group) => group.projectRoot === value.taskRoot && group.planHash === value.groupHash,
      )
    )
      throw new Error('Integration is missing from its coordinator group');
    result.push(value);
  }
  return result;
}

/** 会话归属独立于任务阶段；读取不会启动或恢复工作流。 */
export async function readWorkspaceGroupSession(
  coordinatorRoot: string,
  sessionId: string,
  retiredRepositories?: (group: WorkspaceGroupRegistration) => Promise<readonly string[]>,
): Promise<WorkspaceGroupRegistration | null> {
  const { runtimeRoot } = resolveWorkspaceRuntimeLocation(coordinatorRoot);
  const group = await readRegistration(runtimeRoot, sessionRef(sessionId));
  if (!group) return null;
  if (
    group.coordinatorRoot !== coordinatorRoot ||
    !isDeepStrictEqual(await readWorkspaceGroupRecord(group.projectRoot), group)
  )
    throw new Error('Workspace group session registration changed or is incomplete');
  try {
    await assertWorkspaceGroupMembers(group);
  } catch (error) {
    const retired = await retiredRepositories?.(group);
    if (!retired?.length) throw error;
    await assertWorkspaceGroupMembers(group, retired);
  }
  return group;
}

export async function bindWorkspaceGroupSession(
  group: WorkspaceGroupRegistration,
  sessionId: string,
  options: {
    replace?: boolean;
    retiredRepositories?: (group: WorkspaceGroupRegistration) => Promise<readonly string[]>;
  } = {},
): Promise<void> {
  const { runtimeRoot } = resolveWorkspaceRuntimeLocation(group.coordinatorRoot);
  const file = path.join(runtimeRoot, sessionRef(sessionId));
  await inspectProtectedProjectPath(runtimeRoot, sessionRef(sessionId), {
    label: 'workspace group session runtime',
    expected: 'file',
  });
  await withRecoverableFileLock(`${file}.lock`, async () => {
    if (!isDeepStrictEqual(await readWorkspaceGroup(group.projectRoot), group))
      throw new Error('Workspace group registration changed before session binding');
    const existing = await readWorkspaceGroupSession(
      group.coordinatorRoot,
      sessionId,
      options.replace ? options.retiredRepositories : undefined,
    );
    if (existing && !isDeepStrictEqual(existing, group) && !options.replace)
      throw new Error(
        `Session is bound to task ${existing.name} at ${existing.projectRoot}; ` +
          `from coordinator ${group.coordinatorRoot}, inspect it with comet native status ${existing.name}. ` +
          `To explicitly switch tasks, run comet native select ${group.name} --session <actual-session> from that coordinator`,
      );
    if (!isDeepStrictEqual(existing, group))
      await atomicWriteContainedJson(file, group, { containedRoot: runtimeRoot });
  });
}

/** 登记的任务根可以跨越子仓的 .git 边界，普通项目仍由原发现规则处理。 */
export async function findWorkspaceGroupRoot(start: string): Promise<string | null> {
  return findWorkspaceGroupAncestor(start, 'task');
}

export async function findWorkspaceGroupIntegrationRoot(start: string): Promise<string | null> {
  return findWorkspaceGroupAncestor(start, 'integration');
}

/** Only an exactly registered source checkout may cross its own Git discovery boundary. */
export async function findWorkspaceGroupSourceCoordinator(start: string): Promise<string | null> {
  return findWorkspaceGroupAncestor(start, 'source');
}

async function findWorkspaceGroupAncestor(
  start: string,
  kind: 'task' | 'source' | 'integration',
): Promise<string | null> {
  const source = kind === 'source' ? resolveWorkspaceIdentity(start) : null;
  let cursor = path.resolve(start);
  const dataRoot = resolveCometDataRoot();
  try {
    if (!(await fs.stat(cursor)).isDirectory()) cursor = path.dirname(cursor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    cursor = path.dirname(cursor);
  }
  while (true) {
    let present = true;
    try {
      await fs.lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      present = false;
    }
    if (present) {
      const relativeData = path.relative(await fs.realpath(cursor), dataRoot);
      if (
        relativeData === '' ||
        (!path.isAbsolute(relativeData) &&
          relativeData !== '..' &&
          !relativeData.startsWith(`..${path.sep}`))
      )
        return null;
      if (source) {
        for (const group of await listWorkspaceGroups(cursor)) {
          const member = group.repositories.find(
            (entry) => path.join(group.coordinatorRoot, entry.path) === source.projectRoot,
          );
          if (!member) continue;
          const commonDir = await fs.realpath(
            path.resolve(
              source.projectRoot,
              runGitCommand(source.projectRoot, ['rev-parse', '--git-common-dir']),
            ),
          );
          if (source.workspaceId !== member.sourceWorkspaceId || commonDir !== member.commonDir)
            throw new Error(
              `Workspace group source repository identity changed: ${source.projectRoot}`,
            );
          return group.coordinatorRoot;
        }
      } else if (kind === 'integration') {
        if (await readWorkspaceGroupIntegration(cursor)) return cursor;
        if (/^\.comet-integration-[a-f0-9-]{36}$/u.test(path.basename(cursor)))
          throw new Error(
            'Integration ownership is missing; rerun deliver from its registered task root',
          );
      } else if (await readWorkspaceGroupRecord(cursor)) return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}
