import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runGitCommand } from '../../../platform/process/git.js';
import { resolveWorkspaceIdentity } from '../../../platform/paths/workspace-runtime.js';
import {
  bindWorkspaceGroupSession,
  readWorkspaceGroupSession,
  registerWorkspaceGroup,
  type WorkspaceGroupRegistration,
} from '../../../domains/workflow-contract/workspace-group.js';

let temporary: string;
afterEach(async () => {
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
});

it('rejects equivalent Git paths for a retired member until registration is pruned', async () => {
  temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'comet-retired-group-')));
  const coordinatorRoot = path.join(temporary, 'project');
  const projectRoot = path.join(temporary, 'task');
  const source = path.join(coordinatorRoot, 'backend');
  const member = path.join(projectRoot, 'backend');
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(projectRoot);
  runGitCommand(source, ['init', '-b', 'main']);
  runGitCommand(source, ['config', 'user.name', 'Workspace Test']);
  runGitCommand(source, ['config', 'user.email', 'workspace@example.invalid']);
  runGitCommand(source, ['commit', '--allow-empty', '-m', 'initial']);
  runGitCommand(source, ['worktree', 'add', '-b', 'task', member]);
  const gitDir = path.resolve(member, runGitCommand(member, ['rev-parse', '--git-dir']));
  const group: WorkspaceGroupRegistration = {
    schema: 'comet.workspace-group.v1',
    name: 'task',
    planHash: '1'.repeat(64),
    coordinatorRoot,
    coordinatorId: resolveWorkspaceIdentity(coordinatorRoot).workspaceId,
    projectRoot,
    workspaceId: resolveWorkspaceIdentity(projectRoot).workspaceId,
    repositories: [
      {
        path: 'backend',
        workspaceId: resolveWorkspaceIdentity(member).workspaceId,
        sourceWorkspaceId: resolveWorkspaceIdentity(source).workspaceId,
        commonDir: await fs.realpath(path.join(source, '.git')),
        branch: 'task',
      },
    ],
  };
  await registerWorkspaceGroup(group);
  await bindWorkspaceGroupSession(group, 'session');
  // 保留真实 Git 登记，用等价路径覆盖不同平台的路径表示。
  await fs.writeFile(path.join(gitDir, 'gitdir'), `${member}${path.sep}.${path.sep}.git\n`);
  await fs.rm(member, { recursive: true });
  const read = () => readWorkspaceGroupSession(coordinatorRoot, 'session', async () => ['backend']);
  await expect(read()).rejects.toThrow('was reused');

  const unavailable = path.join(source, '.git-unavailable');
  await fs.rename(path.join(source, '.git'), unavailable);
  try {
    await expect(read()).rejects.toThrow();
  } finally {
    await fs.rename(unavailable, path.join(source, '.git'));
  }

  runGitCommand(source, ['worktree', 'prune', '--expire', 'now']);
  await expect(read()).resolves.toEqual(group);
  await fs.mkdir(member);
  await expect(read()).rejects.toThrow('was reused');
});
