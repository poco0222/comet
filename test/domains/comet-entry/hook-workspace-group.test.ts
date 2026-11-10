import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGitCommand } from '../../../platform/process/git.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/comet-native/native-config.js';
import { runNativeCliDetailed } from '../../../domains/comet-native/native-cli.js';
import { discoverNativeProject } from '../../../domains/comet-native/native-paths.js';
import { resolveCometHookProjectRoot } from '../../../domains/comet-entry/hook-project-root.js';
import { runCometHookRouterGuard } from '../../../domains/comet-entry/hook-router-guard-entry.js';
import { parseCometHookRequest } from '../../../platform/process/hook-adapter.js';
import { resolveWorkspaceRuntimeLocation } from '../../../platform/paths/workspace-runtime.js';
import { registerWorkspaceGroupIntegration } from '../../../domains/workflow-contract/workspace-group.js';

describe('Comet Hook workspace groups', () => {
  let temporary: string, coordinator: string, taskA: string, taskB: string;
  beforeAll(async () => {
    temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'comet-hook-group-')));
    coordinator = path.join(temporary, 'project');
    const repositories = ['backend', 'frontend', 'mobile'].map((ref) => ({ path: ref }));
    for (const entry of repositories) {
      const root = path.join(coordinator, entry.path);
      await fs.mkdir(root, { recursive: true });
      runGitCommand(root, ['init', '-b', 'main']);
      runGitCommand(root, ['config', 'user.name', 'Hook Test']);
      runGitCommand(root, ['config', 'user.email', 'hook@example.invalid']);
      runGitCommand(root, ['commit', '--allow-empty', '-m', 'initial']);
    }
    await writeProjectConfig(coordinator, { ...defaultProjectConfig(), repositories });
    const create = async (name: string) => {
      const result = await runNativeCliDetailed([
        'new',
        name,
        '--project-root',
        coordinator,
        '--isolation',
        'worktree',
        '--json',
      ]);
      expect(result.output.exitCode, result.output.stdout).toBe(0);
      return result.dispatch.executionCwd!;
    };
    taskA = await create('task-a');
    taskB = await create('task-b');
  });
  afterAll(async () => {
    await fs.rm(temporary, { recursive: true, force: true });
  });

  it('routes writes across repositories in the same task to one group guard', async () => {
    await expect(
      resolveCometHookProjectRoot(coordinator, {
        intent: 'write',
        toolName: 'Edit',
        cwd: taskA,
        targets: ['backend/a.ts', 'frontend/b.ts'],
      }),
    ).resolves.toBe(taskA);
    await expect(discoverNativeProject(path.join(taskA, 'backend'))).resolves.toBe(taskA);
    await expect(
      resolveCometHookProjectRoot(coordinator, {
        intent: 'context',
        toolName: null,
        cwd: path.join(taskA, 'mobile'),
        targets: [],
      }),
    ).resolves.toBe(taskA);
  });

  it('rejects cross-task writes and task writes into the original source repositories', async () => {
    for (const foreign of [
      path.join(taskB, 'frontend', 'b.ts'),
      path.join(coordinator, 'backend', 'a.ts'),
    ]) {
      await expect(
        resolveCometHookProjectRoot(coordinator, {
          intent: 'write',
          toolName: 'Edit',
          cwd: taskA,
          targets: [foreign],
        }),
      ).rejects.toThrow('multiple task workspaces');
    }
    await expect(
      resolveCometHookProjectRoot(coordinator, {
        intent: 'write',
        toolName: 'Edit',
        cwd: coordinator,
        targets: [path.join(taskA, 'backend', 'a.ts'), path.join(taskB, 'mobile', 'b.ts')],
      }),
    ).rejects.toThrow('multiple task workspaces');
  });

  it('keeps the Native Shape write guard when invoked from a child repository', async () => {
    const request = {
      intent: 'write' as const,
      toolName: 'Edit',
      cwd: path.join(taskA, 'backend'),
      targets: [path.join(taskA, 'frontend', 'new.ts')],
    };
    for (const parsed of [
      { platformId: 'codex', projectRoot: coordinator },
      { platformId: 'codex' },
    ]) {
      const decision = await runCometHookRouterGuard(parsed, request);
      expect(decision.allowed, decision.reason).toBe(false);
      expect(decision.reason).toMatch(/Shape|shape/);
    }
  });

  it('enforces bound sessions from original source repositories through the generated global Hook', async () => {
    const session = 'source-cwd-session';
    const selected = await runNativeCliDetailed([
      'select',
      'task-a',
      '--session',
      session,
      '--project-root',
      coordinator,
      '--json',
    ]);
    expect(selected.output.exitCode, selected.output.stdout).toBe(0);
    const hook = (cwd: string, target: string) =>
      spawnSync(
        process.execPath,
        [path.resolve('assets/skills/comet/scripts/comet-hook-router.mjs'), '--platform', 'codex'],
        {
          cwd,
          encoding: 'utf8',
          timeout: 20000,
          input: JSON.stringify({
            cwd,
            session_id: session,
            tool_name: 'Edit',
            tool_input: { file_path: target },
          }),
        },
      );
    const source = path.join(coordinator, 'backend');
    for (const target of [path.join(source, 'wrong.ts'), path.join(taskB, 'frontend/wrong.ts')]) {
      const result = hook(source, target);
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('multiple task workspaces');
    }
    const own = hook(source, path.join(taskA, 'frontend/right.ts'));
    expect(own.status, own.stderr).toBe(2);
    expect(own.stderr).toMatch(/Shape|shape/);
    const unrelated = path.join(coordinator, 'unregistered');
    await fs.mkdir(unrelated);
    runGitCommand(unrelated, ['init', '-b', 'main']);
    const ordinary = hook(unrelated, path.join(unrelated, 'own.ts'));
    expect(ordinary.status, ordinary.stderr).toBe(0);
  });

  it('routes integration worktrees to their task and rejects foreign, aliased and damaged integration ownership', async () => {
    const roots: string[] = [];
    for (const task of [taskA, taskB]) {
      const id = randomUUID(),
        root = path.join(path.dirname(task), `.comet-integration-${id}`);
      await fs.mkdir(root);
      runGitCommand(path.join(coordinator, 'backend'), [
        'worktree',
        'add',
        '--detach',
        path.join(root, 'backend'),
        'HEAD',
      ]);
      await registerWorkspaceGroupIntegration(task, root, id);
      roots.push(root);
    }
    const selected = await runNativeCliDetailed([
      'select',
      'task-a',
      '--session',
      'integration-session',
      '--project-root',
      coordinator,
      '--json',
    ]);
    expect(selected.output.exitCode, selected.output.stdout).toBe(0);
    const hook = (target: string) =>
      spawnSync(
        process.execPath,
        [path.resolve('assets/skills/comet/scripts/comet-hook-router.mjs'), '--platform', 'codex'],
        {
          cwd: path.join(roots[0], 'backend'),
          encoding: 'utf8',
          timeout: 20000,
          input: JSON.stringify({
            cwd: path.join(roots[0], 'backend'),
            session_id: 'integration-session',
            tool_name: 'Edit',
            tool_input: { file_path: target },
          }),
        },
      );
    const alias = path.join(temporary, 'integration-alias');
    await fs.symlink(roots[1], alias, 'dir');
    for (const target of [
      path.join(taskB, 'frontend/new.ts'),
      path.join(coordinator, 'frontend/new.ts'),
      path.join(roots[1], 'backend/new.ts'),
      path.join(alias, 'backend/new.ts'),
    ]) {
      const result = hook(target);
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('multiple task workspaces');
    }
    expect(hook(path.join(roots[0], 'backend/repair.ts')).status).toBe(0);
    const runtimeRoot = resolveWorkspaceRuntimeLocation(roots[0]).runtimeRoot;
    expect(hook(path.join(runtimeRoot, 'workspace-group-integration.json')).status).toBe(2);
    const registration = path.join(runtimeRoot, 'workspace-group-integration.json');
    const saved = await fs.readFile(registration);
    await fs.unlink(registration);
    expect(hook(path.join(taskB, 'frontend/new.ts')).status).toBe(2);
    await fs.writeFile(registration, '{bad');
    expect(hook(path.join(taskB, 'frontend/new.ts')).status).toBe(2);
    await fs.writeFile(registration, saved);
    expect(hook(path.join(roots[0], 'backend/repair.ts')).status).toBe(0);
  });

  it('does not switch away from a missing active member without a cleanup receipt', async () => {
    const session = 'damaged-active-session';
    const invoke = (name: string) =>
      runNativeCliDetailed([
        'select',
        name,
        '--session',
        session,
        '--project-root',
        coordinator,
        '--json',
      ]);
    expect((await invoke('task-a')).output.exitCode).toBe(0);
    const member = path.join(taskA, 'mobile'),
      backup = path.join(temporary, 'saved-mobile');
    await fs.rename(member, backup);
    try {
      expect((await invoke('task-b')).output.exitCode).not.toBe(0);
    } finally {
      await fs.rename(backup, member);
    }
    await expect(
      resolveCometHookProjectRoot(coordinator, {
        intent: 'context',
        toolName: null,
        cwd: coordinator,
        targets: [],
        sessionId: session,
      }),
    ).resolves.toBe(taskA);
  });

  it('binds parent-cwd sessions to one task and only switches through explicit select', async () => {
    const request = (sessionId: string, target: string) =>
      parseCometHookRequest(
        JSON.stringify({
          session_id: sessionId,
          cwd: coordinator,
          tool_name: 'Edit',
          tool_input: { file_path: target },
        }),
      );
    const first = request('parent-session', path.join(taskA, 'backend', 'a.ts'));
    expect(first.sessionId).toBe('parent-session');
    const guard = await runCometHookRouterGuard({ platformId: 'codex' }, first);
    expect(guard.allowed).toBe(false);
    expect(guard.reason).toMatch(/Shape|shape/);
    await expect(
      resolveCometHookProjectRoot(coordinator, {
        intent: 'context',
        toolName: null,
        cwd: coordinator,
        targets: [],
        sessionId: first.sessionId,
      }),
    ).resolves.toBe(taskA);
    for (const target of [
      path.join(taskB, 'frontend', 'b.ts'),
      path.join(coordinator, 'backend', 'a.ts'),
    ]) {
      await expect(
        resolveCometHookProjectRoot(coordinator, request('parent-session', target)),
      ).rejects.toThrow('session is bound to task-a');
    }
    await expect(
      resolveCometHookProjectRoot(
        coordinator,
        request('other-session', path.join(taskB, 'mobile', 'b.ts')),
      ),
    ).resolves.toBe(taskB);
    const switched = await runNativeCliDetailed([
      'select',
      'task-b',
      '--session',
      'parent-session',
      '--project-root',
      coordinator,
      '--json',
    ]);
    expect(switched.output.exitCode, switched.output.stdout).toBe(0);
    expect(switched.dispatch.executionCwd).toBe(taskB);
    await expect(
      resolveCometHookProjectRoot(
        coordinator,
        request('parent-session', path.join(taskB, 'frontend', 'b.ts')),
      ),
    ).resolves.toBe(taskB);
    await expect(
      resolveCometHookProjectRoot(
        coordinator,
        request('parent-session', path.join(taskA, 'backend', 'a.ts')),
      ),
    ).rejects.toThrow('session is bound to task-b');
    const next = await runNativeCliDetailed([
      'next',
      'task-a',
      '--session',
      'parent-session',
      '--project-root',
      coordinator,
      '--json',
    ]);
    expect(next.output.exitCode).not.toBe(0);
    expect(next.output.stdout).toContain('Session is bound to task task-b');
  });

  it('serializes first task binding and requires task cwd when the platform omits session identity', async () => {
    const request = (root: string, sessionId?: string) => ({
      intent: 'write' as const,
      toolName: 'Edit',
      cwd: coordinator,
      targets: [path.join(root, 'backend', 'a.ts')],
      sessionId,
    });
    const results = await Promise.allSettled(
      [taskA, taskB].map((root) =>
        resolveCometHookProjectRoot(coordinator, request(root, 'racing-session')),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(resolveCometHookProjectRoot(coordinator, request(taskA))).rejects.toThrow(
      'require a Hook session ID',
    );
    await expect(
      resolveCometHookProjectRoot(coordinator, { ...request(taskA), cwd: taskA }),
    ).resolves.toBe(taskA);
  });

  it('rejects cross-task aliases and runtime writes without bypassing the phase guard', async () => {
    const alias = path.join(taskA, 'other-task');
    await fs.symlink(taskB, alias, 'junction');
    try {
      await expect(
        resolveCometHookProjectRoot(coordinator, {
          intent: 'write',
          toolName: 'Edit',
          cwd: taskA,
          targets: [path.join(alias, 'backend', 'a.ts')],
        }),
      ).rejects.toThrow('multiple task workspaces');
    } finally {
      await fs.unlink(alias);
    }
    const runtime = resolveWorkspaceRuntimeLocation(taskA).runtimeRoot;
    const decision = await runCometHookRouterGuard(
      { platformId: 'codex', projectRoot: coordinator },
      {
        intent: 'write',
        toolName: 'Edit',
        cwd: coordinator,
        sessionId: 'runtime-session',
        targets: [path.join(runtime, 'workspace-group.json')],
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/Runtime|runtime|受管/);
    await expect(
      resolveCometHookProjectRoot(coordinator, {
        intent: 'write',
        toolName: 'Edit',
        cwd: coordinator,
        sessionId: 'runtime-session',
        targets: [
          path.join(resolveWorkspaceRuntimeLocation(taskB).runtimeRoot, 'workspace-group.json'),
        ],
      }),
    ).rejects.toThrow('multiple task workspaces');
  });

  it('fails closed for corrupt session records and missing task registration', async () => {
    const sessionId = 'corrupt-session';
    const request = {
      intent: 'write' as const,
      toolName: 'Edit',
      cwd: coordinator,
      sessionId,
      targets: [path.join(taskA, 'backend', 'a.ts')],
    };
    await resolveCometHookProjectRoot(coordinator, request);
    const runtime = resolveWorkspaceRuntimeLocation(coordinator).runtimeRoot;
    const record = path.join(
      runtime,
      `workspace-group-session-${createHash('sha256').update(sessionId).digest('hex')}.json`,
    );
    const original = await fs.readFile(record);
    try {
      await fs.writeFile(record, '{}');
      await expect(resolveCometHookProjectRoot(coordinator, request)).rejects.toThrow(
        'Invalid workspace group registration',
      );
    } finally {
      await fs.writeFile(record, original);
    }
    const taskRecord = path.join(
      resolveWorkspaceRuntimeLocation(taskA).runtimeRoot,
      'workspace-group.json',
    );
    await fs.rename(taskRecord, `${taskRecord}.backup`);
    try {
      await expect(resolveCometHookProjectRoot(coordinator, request)).rejects.toThrow(
        'session registration changed or is incomplete',
      );
    } finally {
      await fs.rename(`${taskRecord}.backup`, taskRecord);
    }
  });

  it('preserves session selection across generated CLI and Hook processes', () => {
    const scripts = fileURLToPath(new URL('../../../assets/skills/', import.meta.url));
    const invalid = spawnSync(
      process.execPath,
      [
        path.join(scripts, 'comet-native/scripts/comet-native-select.mjs'),
        'task-a',
        '--rebind',
        '--session',
        'bundle-session',
        '--project-root',
        coordinator,
        '--json',
      ],
      { encoding: 'utf8', cwd: coordinator, timeout: 20_000 },
    );
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout + invalid.stderr).toContain('--session and --rebind cannot be combined');
    const select = spawnSync(
      process.execPath,
      [
        path.join(scripts, 'comet-native/scripts/comet-native-select.mjs'),
        'task-a',
        '--session',
        'bundle-session',
        '--project-root',
        coordinator,
        '--json',
      ],
      { encoding: 'utf8', cwd: coordinator, timeout: 20_000 },
    );
    expect(select.status, select.stdout + select.stderr).toBe(0);
    const hook = (root: string) =>
      spawnSync(
        process.execPath,
        [path.join(scripts, 'comet/scripts/comet-hook-router.mjs'), '--platform', 'codex'],
        {
          cwd: coordinator,
          encoding: 'utf8',
          timeout: 20_000,
          input: JSON.stringify({
            session_id: 'bundle-session',
            cwd: coordinator,
            tool_name: 'Edit',
            tool_input: { file_path: path.join(root, 'backend', 'a.ts') },
          }),
        },
      );
    const own = hook(taskA);
    expect(own.status, own.stdout + own.stderr).toBe(2);
    expect(own.stderr + own.stdout).toMatch(/Shape|shape/);
    const foreign = hook(taskB);
    expect(foreign.status, foreign.stdout + foreign.stderr).toBe(2);
    expect(foreign.stderr + foreign.stdout).toContain('session is bound to task-a');
  });
});
