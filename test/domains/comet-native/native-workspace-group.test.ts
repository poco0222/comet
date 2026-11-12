import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runGitCommand } from '../../../platform/process/git.js';
import { runNativeCliDetailed } from '../../../domains/comet-native/native-cli.js';
import { nativeRawInputSnapshot } from '../../../domains/comet-native/native-portable-checks.js';
import {
  defaultProjectConfig,
  writeProjectConfig,
} from '../../../domains/comet-native/native-config.js';
import { resolveWorkspaceRuntimeLocation } from '../../../platform/paths/workspace-runtime.js';
import { readProcessIdentity } from '../../../platform/process/process-identity.js';
import {
  assertNativeWorkspaceGroupCurrent,
  createNativeWorkspaceGroup,
  planNativeWorkspaceGroup,
} from '../../../domains/comet-native/native-workspace-group.js';

describe('Native workspace group creation', () => {
  let temporary: string;
  let projectRoot: string;
  const repositories = [{ path: 'backend' }, { path: 'frontend' }, { path: 'mobile' }];

  beforeEach(async () => {
    temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'comet-group-')));
    projectRoot = path.join(temporary, 'project');
    for (const { path: ref } of repositories) {
      const root = path.join(projectRoot, ref);
      await fs.mkdir(root, { recursive: true });
      runGitCommand(root, ['init', '-b', ref === 'mobile' ? 'main' : 'master']);
      runGitCommand(root, ['config', 'user.name', 'Workspace Test']);
      runGitCommand(root, ['config', 'user.email', 'workspace@example.invalid']);
      await fs.writeFile(path.join(root, 'source.txt'), `${ref}\n`);
      runGitCommand(root, ['add', 'source.txt']);
      runGitCommand(root, ['commit', '-m', 'initial']);
    }
  });

  afterEach(async () => {
    await fs.rm(temporary, { recursive: true, force: true });
  });

  it('suggests unregistered child repositories before creating worktrees through the public CLI', async () => {
    const config = path.join(projectRoot, '.comet/config.yaml');
    await writeProjectConfig(projectRoot, defaultProjectConfig('docs', 'zh-CN'));
    const original = await fs.readFile(config, 'utf8');
    const nested = path.join(projectRoot, 'ordinary/nested');
    await fs.mkdir(nested, { recursive: true });
    runGitCommand(nested, ['init', '-b', 'main']);
    await fs.mkdir(path.join(projectRoot, 'invalid/.git'), { recursive: true });
    await fs.symlink(
      path.join(projectRoot, 'backend'),
      path.join(projectRoot, 'alias'),
      'junction',
    );
    const backend = path.join(projectRoot, 'backend');
    runGitCommand(backend, [
      'worktree',
      'add',
      '--detach',
      path.join(projectRoot, 'linked-checkout'),
    ]);
    const originalWorktrees = repositories.map(({ path: ref }) =>
      runGitCommand(path.join(projectRoot, ref), ['worktree', 'list', '--porcelain']),
    );
    const invoke = (...flags: string[]) =>
      spawnSync(
        process.execPath,
        [
          path.resolve('assets/skills/comet-native/scripts/comet-native-new.mjs'),
          'first-worktree',
          '--isolation',
          'worktree',
          '--json',
          ...flags,
        ],
        { cwd: projectRoot, encoding: 'utf8', timeout: 30000 },
      );
    const suggestion =
      'repositories:\n  - path: "backend"\n  - path: "frontend"\n  - path: "mobile"';
    for (const flags of [[], ['--dry-run']]) {
      const blocked = invoke(...flags);
      expect(blocked.error).toBeUndefined();
      expect(blocked.status).not.toBe(0);
      const { error } = JSON.parse(blocked.stdout);
      expect(error.message).toContain('尚未登记');
      expect(error.message).toContain('.comet/config.yaml');
      expect(error.message.split('\n\n').at(-1)).toBe(suggestion);
    }
    expect(await fs.readFile(config, 'utf8')).toBe(original);
    expect(await fs.readdir(path.dirname(config))).toEqual(['config.yaml']);
    const task = path.join(temporary, 'project-worktrees', 'first-worktree');
    await expect(fs.stat(task)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const [index, { path: ref }] of repositories.entries()) {
      const repo = path.join(projectRoot, ref);
      expect(runGitCommand(repo, ['worktree', 'list', '--porcelain'])).toBe(
        originalWorktrees[index],
      );
      expect(runGitCommand(repo, ['branch', '--list', 'comet/first-worktree'])).toBe('');
    }

    await fs.appendFile(config, `\n${suggestion}\n`);
    const preview = invoke('--dry-run');
    expect(preview.status, preview.stdout + preview.stderr).toBe(0);
    const { plan } = JSON.parse(preview.stdout).data;
    const created = invoke('--plan-hash', plan.hash);
    expect(created.status, created.stdout + created.stderr).toBe(0);
    for (const { path: ref } of repositories) {
      expect(runGitCommand(path.join(task, ref), ['branch', '--show-current'])).toBe(
        'comet/first-worktree',
      );
    }
  });

  it('inherits project input exclusions in Git members without refreshing excluded worktree files', async () => {
    const backend = path.join(projectRoot, 'backend');
    const filename = 'application-prod.yml';
    await fs.writeFile(path.join(backend, filename), 'fixture: one\n');
    await fs.writeFile(path.join(backend, '.gitattributes'), `${filename} filter=fixture\n`);
    runGitCommand(backend, ['add', filename, '.gitattributes']);
    runGitCommand(backend, ['commit', '-m', 'tracked fixture']);
    const config = defaultProjectConfig();
    config.native.snapshot.exclude = ['backend/**/application-prod.yml'];
    await writeProjectConfig(projectRoot, { ...config, repositories });
    const created = await runNativeCliDetailed([
      'new',
      'exclusion',
      '--isolation',
      'worktree',
      '--project-root',
      projectRoot,
      '--json',
    ]);
    expect(created.output.exitCode, created.output.stdout).toBe(0);
    const task = created.dispatch.executionCwd!;
    const member = path.join(task, 'backend');
    const marker = path.join(temporary, 'clean-filter-called');
    const script = path.join(temporary, 'clean-filter.cjs');
    await fs.writeFile(
      script,
      `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'read'); process.stdin.pipe(process.stdout);`,
    );
    runGitCommand(backend, [
      'config',
      'filter.fixture.clean',
      `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`,
    ]);
    await fs.writeFile(path.join(member, filename), 'fixture: two\n');
    const before = await nativeRawInputSnapshot({ projectRoot: task });
    expect(before.complete, before.diagnostics.join('; ')).toBe(true);
    expect(before.files.map((file) => file.path)).not.toContain(`backend/${filename}`);
    expect(before.files.map((file) => file.path)).toContain('backend/source.txt');
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.writeFile(path.join(member, filename), 'fixture: six\n');
    const after = await nativeRawInputSnapshot({ projectRoot: task, previous: before });
    expect(after.complete, after.diagnostics.join('; ')).toBe(true);
    expect(after.contentHash).toBe(before.contentHash);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preflights explicit local setup without copying secrets and binds copied ignored inputs', async () => {
    await writeProjectConfig(projectRoot, { ...defaultProjectConfig(), repositories });
    const backend = path.join(projectRoot, 'backend');
    await fs.writeFile(path.join(backend, '.gitignore'), '.env\nnode_modules/\n');
    runGitCommand(backend, ['add', '.gitignore']);
    runGitCommand(backend, ['commit', '-m', 'ignore local environment']);
    await fs.writeFile(path.join(backend, '.env'), 'fixture-private-value');
    const setupFile = path.join(temporary, 'setup.json');
    await fs.writeFile(
      setupFile,
      JSON.stringify({
        copyFiles: ['backend/.env'],
        checks: [
          {
            id: 'ready',
            name: 'prepare local dependencies',
            executable: process.execPath,
            argv: [
              '-e',
              'const fs=require("node:fs"); if(!fs.existsSync(".env")) process.exit(2); fs.mkdirSync("node_modules",{recursive:true}); fs.writeFileSync("node_modules/ready","ok")',
            ],
            cwdRef: 'backend',
            timeoutMs: 10000,
            repeatable: true,
          },
        ],
      }),
    );
    const cli = (...args: string[]) =>
      runNativeCliDetailed([
        'new',
        'local-setup',
        '--isolation',
        'worktree',
        '--project-root',
        projectRoot,
        '--json',
        ...args,
      ]);
    const preview = await cli('--setup', setupFile, '--dry-run');
    expect(preview.output.exitCode, preview.output.stdout).toBe(0);
    expect(preview.output.stdout).not.toContain('fixture-private-value');
    const plan = JSON.parse(preview.output.stdout).data.plan;
    await expect(fs.stat(plan.projectRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    const created = await cli('--setup', setupFile, '--plan-hash', plan.hash);
    expect(created.output.exitCode, created.output.stdout).toBe(0);
    const task = created.dispatch.executionCwd!;
    expect(await fs.readFile(path.join(task, 'backend/.env'), 'utf8')).toBe(
      'fixture-private-value',
    );
    expect(await fs.readFile(path.join(task, 'backend/node_modules/ready'), 'utf8')).toBe('ok');
    expect(runGitCommand(path.join(task, 'backend'), ['status', '--porcelain'])).toBe('');
    const before = await nativeRawInputSnapshot({ projectRoot: task });
    expect(before.complete, before.diagnostics.join('; ')).toBe(true);
    expect(before.files.map((file) => file.path)).toContain('backend/.env');
    await fs.writeFile(path.join(task, 'backend/.env'), 'task-owned-config');
    expect((await nativeRawInputSnapshot({ projectRoot: task })).contentHash).not.toBe(
      before.contentHash,
    );
    const resumed = await cli();
    expect(resumed.output.exitCode, resumed.output.stdout).toBe(0);
    expect(await fs.readFile(path.join(task, 'backend/.env'), 'utf8')).toBe('task-owned-config');
    expect(await fs.readFile(path.join(backend, '.env'), 'utf8')).toBe('fixture-private-value');
    await fs.unlink(path.join(task, 'backend/.env'));
    const missing = await nativeRawInputSnapshot({ projectRoot: task });
    expect(missing.complete).toBe(false);
    expect(missing.diagnostics.join('; ')).toContain('.env');
    const unavailable = await cli();
    expect(unavailable.output.exitCode).not.toBe(0);
    expect(unavailable.output.stdout + unavailable.output.stderr).toContain(
      'Prepared local file is missing',
    );
  });

  it('retries failed repeatable setup without overwriting task-local configuration', async () => {
    await writeProjectConfig(projectRoot, { ...defaultProjectConfig(), repositories });
    const backend = path.join(projectRoot, 'backend');
    await fs.writeFile(path.join(backend, '.gitignore'), '.env\nnode_modules/\n');
    runGitCommand(backend, ['add', '.gitignore']);
    runGitCommand(backend, ['commit', '-m', 'ignore environment']);
    await fs.writeFile(path.join(backend, '.env'), 'original');
    const setupFile = path.join(temporary, 'retry-setup.json');
    await fs.writeFile(
      setupFile,
      JSON.stringify({
        copyFiles: ['backend/.env'],
        checks: [
          {
            id: 'retry',
            name: 'repeatable setup',
            executable: process.execPath,
            argv: [
              '-e',
              'const fs=require("node:fs"); fs.mkdirSync("node_modules",{recursive:true}); if(!fs.existsSync("node_modules/attempt")){fs.writeFileSync("node_modules/attempt","one");process.exit(1)}',
            ],
            cwdRef: 'backend',
            timeoutMs: 10000,
            repeatable: true,
          },
        ],
      }),
    );
    const invoke = (...args: string[]) =>
      runNativeCliDetailed([
        'new',
        'retry-setup',
        '--isolation',
        'worktree',
        '--project-root',
        projectRoot,
        '--json',
        ...args,
      ]);
    const failed = await invoke('--setup', setupFile);
    expect(failed.output.exitCode).not.toBe(0);
    expect(failed.output.stdout + failed.output.stderr).toContain('Workspace setup failed');
    const task = path.join(temporary, 'project-worktrees/retry-setup');
    const runtimeRoot = resolveWorkspaceRuntimeLocation(task).runtimeRoot;
    const setupDirectory = path.join(runtimeRoot, 'workspace-setup');
    const receiptFile = path.join(setupDirectory, (await fs.readdir(setupDirectory))[0]);
    const original = await fs.readFile(receiptFile, 'utf8');
    const interrupted = JSON.parse(original);
    interrupted.attempts[0].result = null;
    const running = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    });
    await once(running, 'spawn');
    try {
      interrupted.attempts[0].process = {
        pid: running.pid!,
        identity: (await readProcessIdentity(running.pid!)) ?? undefined,
      };
      await fs.writeFile(receiptFile, JSON.stringify(interrupted));
      const live = await invoke();
      expect(live.output.exitCode).not.toBe(0);
      expect(live.output.stdout + live.output.stderr).toContain('may still be running');
    } finally {
      const exited = once(running, 'exit');
      running.kill();
      await exited;
    }
    interrupted.attempts[0].process.pid = 'invalid';
    await fs.writeFile(receiptFile, JSON.stringify(interrupted));
    const corrupt = await invoke();
    expect(corrupt.output.exitCode).not.toBe(0);
    expect(corrupt.output.stdout + corrupt.output.stderr).toContain(
      'Workspace setup receipt changed',
    );
    await fs.writeFile(receiptFile, original);
    await fs.writeFile(path.join(task, 'backend/.env'), 'keep user edit');
    const resumed = await invoke();
    expect(resumed.output.exitCode, resumed.output.stdout).toBe(0);
    expect(await fs.readFile(path.join(task, 'backend/.env'), 'utf8')).toBe('keep user edit');
    const completed = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
    await fs.appendFile(
      path.join(runtimeRoot, completed.attempts.at(-1).result.logRef),
      'changed log',
    );
    const stale = await invoke();
    expect(stale.output.exitCode).not.toBe(0);
    expect(stale.output.stdout + stale.output.stderr).toContain('Workspace setup log changed');
  });

  it('rejects unsafe local setup and stale local-file hashes before creating worktrees', async () => {
    await writeProjectConfig(projectRoot, { ...defaultProjectConfig(), repositories });
    const backend = path.join(projectRoot, 'backend');
    await fs.writeFile(path.join(backend, '.gitignore'), '.env\n');
    runGitCommand(backend, ['add', '.gitignore']);
    runGitCommand(backend, ['commit', '-m', 'ignore environment']);
    await fs.writeFile(path.join(backend, '.env'), 'before');
    const setupFile = path.join(temporary, 'unsafe-setup.json');
    const invoke = (...args: string[]) =>
      runNativeCliDetailed([
        'new',
        'unsafe-setup',
        '--isolation',
        'worktree',
        '--setup',
        setupFile,
        '--project-root',
        projectRoot,
        '--json',
        ...args,
      ]);
    for (const copyFiles of [['backend/source.txt'], ['backend/.git/config'], ['../outside']]) {
      await fs.writeFile(setupFile, JSON.stringify({ copyFiles }));
      expect((await invoke('--dry-run')).output.exitCode).not.toBe(0);
    }
    await fs.writeFile(setupFile, JSON.stringify({ copyFiles: ['backend/.env'] }));
    const preview = await invoke('--dry-run');
    expect(preview.output.exitCode, preview.output.stdout).toBe(0);
    const plan = JSON.parse(preview.output.stdout).data.plan;
    await fs.writeFile(path.join(backend, '.env'), 'after');
    expect((await invoke('--plan-hash', plan.hash)).output.exitCode).not.toBe(0);
    await expect(fs.stat(plan.projectRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reproduces the baseline non-Git coordinator failure and creates the same task with the new public CLI', async () => {
    await writeProjectConfig(projectRoot, { ...defaultProjectConfig(), repositories });
    const baseline = spawnSync(
      'git',
      [
        'show',
        'a61a2e5b4766e1ad62377dec598e402560a259b6:assets/skills/comet-native/scripts/comet-native-runtime.mjs',
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    expect(baseline.status, baseline.stderr).toBe(0);
    const file = path.join(temporary, 'baseline-runtime.mjs');
    await fs.writeFile(file, baseline.stdout);
    const args = [
      'new',
      'baseline-case',
      '--isolation',
      'worktree',
      '--project-root',
      projectRoot,
      '--json',
    ];
    const old = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', timeout: 30000 });
    expect(old.error).toBeUndefined();
    expect(old.status).not.toBe(0);
    expect(JSON.parse(old.stdout).error.message).toBe(
      'Native branch and worktree isolation require an attached Git branch',
    );
    const updated = await runNativeCliDetailed(args);
    expect(updated.output.exitCode, updated.output.stdout).toBe(0);
    expect(updated.dispatch.executionCwd).not.toBe(projectRoot);
    for (const entry of repositories) {
      const task = path.join(updated.dispatch.executionCwd!, entry.path);
      expect(runGitCommand(task, ['branch', '--show-current'])).toBe('comet/baseline-case');
      expect(runGitCommand(path.join(projectRoot, entry.path), ['status', '--porcelain'])).toBe('');
    }
  });

  it('preflights without writes and creates two independent three-repository tasks without copying dirty sources', async () => {
    const source = path.join(projectRoot, 'backend');
    await fs.writeFile(path.join(source, 'source.txt'), 'uncommitted source\n');
    await fs.writeFile(path.join(source, 'local.txt'), 'untracked\n');
    const originalStatus = runGitCommand(source, ['status', '--porcelain=v1']);
    const plan = await planNativeWorkspaceGroup({ projectRoot, name: 'task-a', repositories });
    expect(plan.repositories.map((entry) => entry.targetBranch)).toEqual([
      'master',
      'master',
      'main',
    ]);
    expect(plan.repositories[0].sourceDirty).toBe(true);
    await expect(fs.stat(plan.projectRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(resolveWorkspaceRuntimeLocation(projectRoot).runtimeRoot),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const first = await createNativeWorkspaceGroup(plan);
    expect(first.complete).toBe(true);
    expect(first.repositories).toHaveLength(3);
    const second = await createNativeWorkspaceGroup(
      await planNativeWorkspaceGroup({ projectRoot, name: 'task-b', repositories }),
    );
    expect(second.projectWorkspaceId).not.toBe(first.projectWorkspaceId);
    for (const entry of first.plan.repositories) {
      expect(await fs.readFile(path.join(entry.worktreeRoot, 'source.txt'), 'utf8')).toBe(
        `${entry.path}\n`,
      );
      expect(runGitCommand(entry.worktreeRoot, ['branch', '--show-current'])).toBe('comet/task-a');
    }
    await expect(
      fs.stat(path.join(first.plan.projectRoot, 'backend', 'local.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runGitCommand(source, ['status', '--porcelain=v1'])).toBe(originalStatus);
    await fs.writeFile(path.join(first.plan.projectRoot, 'backend', 'source.txt'), 'task work\n');
    expect(await createNativeWorkspaceGroup(plan)).toEqual(first);
    expect(
      await fs.readFile(path.join(first.plan.projectRoot, 'backend', 'source.txt'), 'utf8'),
    ).toBe('task work\n');
    await assertNativeWorkspaceGroupCurrent(second);
  });

  it('resumes a partial Git failure without replacing completed worktrees or removing foreign locks', async () => {
    const plan = await planNativeWorkspaceGroup({ projectRoot, name: 'recover', repositories });
    const blocked = plan.repositories[1];
    const lock = path.join(blocked.commonDir, 'refs', 'heads', 'comet', 'recover.lock');
    await fs.mkdir(path.dirname(lock), { recursive: true });
    await fs.writeFile(lock, 'external lock');
    await expect(createNativeWorkspaceGroup(plan)).rejects.toThrow('recover.lock');
    const firstRoot = plan.repositories[0].worktreeRoot;
    await fs.writeFile(path.join(firstRoot, 'source.txt'), 'retained task edits\n');
    expect(await fs.readFile(lock, 'utf8')).toBe('external lock');
    await fs.unlink(lock);
    const group = await createNativeWorkspaceGroup(plan);
    expect(group.complete).toBe(true);
    expect(await fs.readFile(path.join(firstRoot, 'source.txt'), 'utf8')).toBe(
      'retained task edits\n',
    );
    expect(await createNativeWorkspaceGroup(plan)).toEqual(group);
  });

  it('rejects missing members and branch drift instead of treating a partial group as current', async () => {
    const group = await createNativeWorkspaceGroup(
      await planNativeWorkspaceGroup({ projectRoot, name: 'identity', repositories }),
    );
    const root = group.plan.repositories[1].worktreeRoot;
    runGitCommand(root, ['switch', '-c', 'foreign-task']);
    await expect(assertNativeWorkspaceGroupCurrent(group)).rejects.toThrow('binding changed');
    runGitCommand(root, ['switch', 'comet/identity']);
    await fs.rename(root, `${root}-moved`);
    await expect(assertNativeWorkspaceGroupCurrent(group)).rejects.toThrow();
  });

  it('does not adopt a foreign branch during partial creation even when its commit matches', async () => {
    const plan = await planNativeWorkspaceGroup({ projectRoot, name: 'foreign', repositories });
    const member = plan.repositories[1];
    const lock = path.join(member.commonDir, 'refs/heads/comet/foreign.lock');
    await fs.mkdir(path.dirname(lock), { recursive: true });
    await fs.writeFile(lock, 'fixture lock');
    await expect(createNativeWorkspaceGroup(plan)).rejects.toThrow('foreign.lock');
    await fs.unlink(lock);
    runGitCommand(member.sourceRoot, ['branch', member.changeBranch, member.baseCommit]);
    await expect(createNativeWorkspaceGroup(plan)).rejects.toThrow('not owned by this preparation');
    expect(
      runGitCommand(member.sourceRoot, ['rev-parse', `refs/heads/${member.changeBranch}`]),
    ).toBe(member.baseCommit);
    await expect(fs.stat(member.worktreeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    runGitCommand(member.sourceRoot, ['branch', '-D', member.changeBranch]);
    expect((await createNativeWorkspaceGroup(plan)).complete).toBe(true);
  });

  it('rejects stale targets before creating any task worktree', async () => {
    const plan = await planNativeWorkspaceGroup({ projectRoot, name: 'stale', repositories });
    runGitCommand(plan.repositories[1].sourceRoot, [
      'commit',
      '--allow-empty',
      '-m',
      'target advanced',
    ]);
    await expect(createNativeWorkspaceGroup(plan)).rejects.toThrow('preflight is stale: frontend');
    await expect(fs.stat(plan.projectRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      runGitCommand(plan.repositories[0].sourceRoot, ['branch', '--list', 'comet/stale']),
    ).toBe('');
  });

  it('rejects nested task roots during preflight and after a competing creation reserves its directory', async () => {
    const outer = await planNativeWorkspaceGroup({ projectRoot, name: 'outer', repositories });
    const nestedPath = path.join(outer.projectRoot, 'nested');
    const nested = await planNativeWorkspaceGroup({
      projectRoot,
      name: 'nested',
      repositories,
      worktreePath: nestedPath,
    });
    const blocked = outer.repositories[1];
    const lock = path.join(blocked.commonDir, 'refs/heads/comet/outer.lock');
    await fs.mkdir(path.dirname(lock), { recursive: true });
    await fs.writeFile(lock, 'fixture lock');
    await expect(createNativeWorkspaceGroup(outer)).rejects.toThrow('outer.lock');
    await expect(createNativeWorkspaceGroup(nested)).rejects.toThrow('overlaps another task');
    await expect(
      planNativeWorkspaceGroup({
        projectRoot,
        name: 'nested',
        repositories,
        worktreePath: nestedPath,
      }),
    ).rejects.toThrow('overlaps another task');
    await fs.unlink(lock);
    await createNativeWorkspaceGroup(outer);
    await writeProjectConfig(projectRoot, { ...defaultProjectConfig(), repositories });
    const denied = await runNativeCliDetailed([
      'new',
      'nested',
      '--isolation',
      'worktree',
      '--worktree-path',
      nestedPath,
      '--project-root',
      projectRoot,
      '--json',
    ]);
    expect(denied.output.exitCode).not.toBe(0);
    expect(denied.output.stdout).toContain('overlaps another task');
    await expect(fs.stat(nestedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const entry of nested.repositories)
      expect(runGitCommand(entry.sourceRoot, ['branch', '--list', entry.changeBranch])).toBe('');
    expect(
      (
        await createNativeWorkspaceGroup(
          await planNativeWorkspaceGroup({ projectRoot, name: 'sibling', repositories }),
        )
      ).complete,
    ).toBe(true);
  });

  it('rejects overlapping repositories, symlink aliases and destinations inside the source', async () => {
    await expect(
      planNativeWorkspaceGroup({
        projectRoot,
        name: 'unsafe',
        repositories: [repositories[0], repositories[0]],
      }),
    ).rejects.toThrow('non-overlapping');
    await fs.symlink(path.join(projectRoot, 'backend'), path.join(projectRoot, 'alias'), 'dir');
    await expect(
      planNativeWorkspaceGroup({ projectRoot, name: 'unsafe', repositories: [{ path: 'alias' }] }),
    ).rejects.toThrow('exact Git root');
    await expect(
      planNativeWorkspaceGroup({
        projectRoot,
        name: 'unsafe',
        repositories,
        worktreePath: 'tasks/unsafe',
      }),
    ).rejects.toThrow('outside the coordinator');
    await expect(
      planNativeWorkspaceGroup({
        projectRoot,
        name: 'unsafe',
        repositories: [{ path: '../escape' }],
      }),
    ).rejects.toThrow('relative child');
  });

  it('creates SDK tasks through the public CLI and finds their Runs from the coordinator', async () => {
    await writeProjectConfig(projectRoot, { ...defaultProjectConfig(), repositories });
    const invoke = (...args: string[]) =>
      runNativeCliDetailed([...args, '--project-root', projectRoot, '--json']);
    const preview = await invoke('new', 'cli-a', '--isolation', 'worktree', '--dry-run');
    expect(preview.output.exitCode, preview.output.stdout).toBe(0);
    const { plan } = preview.dispatch.data as {
      plan: Awaited<ReturnType<typeof planNativeWorkspaceGroup>>;
    };
    await expect(fs.stat(plan.projectRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    const stale = await invoke('new', 'cli-a', '--isolation', 'worktree', '--plan-hash', 'wrong');
    expect(stale.output.exitCode).not.toBe(0);
    const created = await invoke(
      'new',
      'cli-a',
      '--isolation',
      'worktree',
      '--plan-hash',
      plan.hash,
    );
    expect(created.output.exitCode, created.output.stdout).toBe(0);
    expect(created.dispatch.executionCwd).toBe(plan.projectRoot);
    const other = await invoke('new', 'cli-b', '--isolation', 'worktree');
    expect(other.output.exitCode, other.output.stdout).toBe(0);
    expect(other.dispatch.executionCwd).not.toBe(plan.projectRoot);
    await expect(
      fs.stat(path.join(projectRoot, '.comet', 'current-change.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const status = await invoke('status', 'cli-a');
    expect(status.output.exitCode, status.output.stdout).toBe(0);
    expect(status.dispatch.executionCwd).toBe(plan.projectRoot);
    expect(status.dispatch.data).toMatchObject({
      workspace: {
        coordinatorRoot: projectRoot,
        planHash: plan.hash,
        repositories: [
          { path: 'backend', targetBranch: 'master' },
          { path: 'frontend', targetBranch: 'master' },
          { path: 'mobile', targetBranch: 'main' },
        ],
      },
    });
    const listing = await invoke('status');
    expect(listing.output.exitCode, listing.output.stdout).toBe(0);
    expect(listing.dispatch.data).toMatchObject({ total: 2 });
    const resumed = await invoke(
      'new',
      'cli-a',
      '--isolation',
      'worktree',
      '--plan-hash',
      plan.hash,
    );
    expect(resumed.output.exitCode, resumed.output.stdout).toBe(0);
    expect(resumed.dispatch.executionCwd).toBe(plan.projectRoot);
  });

  it('creates a current change from a registered coordinator alongside an isolated task', async () => {
    await writeProjectConfig(projectRoot, { ...defaultProjectConfig(), repositories });
    const configFile = path.join(projectRoot, '.comet/config.yaml');
    const config = await fs.readFile(configFile, 'utf8');
    const source = path.join(projectRoot, 'backend/source.txt');
    await fs.writeFile(source, 'uncommitted source\n');
    const packageRoot = process.env.COMET_TEST_PACKAGE_ROOT ?? process.cwd();
    const invoke = (...args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [
          path.join(packageRoot, 'bin/comet.js'),
          'native',
          ...args,
          '--project-root',
          projectRoot,
          '--json',
        ],
        { cwd: projectRoot, encoding: 'utf8', timeout: 30000 },
      );
      expect(result.error).toBeUndefined();
      return { status: result.status, response: JSON.parse(result.stdout) };
    };
    const isolated = invoke('new', 'isolated', '--isolation', 'worktree');
    expect(isolated.status, JSON.stringify(isolated.response)).toBe(0);
    const isolatedRoot = isolated.response.data.preparation.projectRoot;
    const isolatedStatus = invoke('status', 'isolated');
    expect(isolatedStatus.status).toBe(0);
    const worktreeLists = () =>
      repositories.map(({ path: ref }) =>
        runGitCommand(path.join(projectRoot, ref), ['worktree', 'list', '--porcelain']),
      );
    const originalWorktrees = worktreeLists();
    const stalePlan = await planNativeWorkspaceGroup({
      projectRoot,
      name: 'in-place',
      repositories,
    });
    const existing = invoke('new', 'isolated', '--isolation', 'current');
    expect(existing.status).not.toBe(0);
    expect(existing.response.error.message).toContain('already has a registered worktree');
    const preview = invoke('new', 'in-place', '--isolation', 'current', '--dry-run');
    expect(preview.status).not.toBe(0);
    expect(preview.response.error.message).toContain('require --isolation worktree');
    await expect(
      fs.stat(path.join(projectRoot, 'docs/comet/changes/in-place')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const created = invoke('new', 'in-place', '--isolation', 'current');
    expect(created.status, JSON.stringify(created.response)).toBe(0);
    expect(created.response.data).toMatchObject({
      name: 'in-place',
      phase: 'shape',
      preparation: {
        projectRoot,
        isolation: 'current',
        createdWorktree: false,
        createdBranch: false,
      },
    });
    expect(invoke('status', 'in-place').response.agent.workspace.cwd).toBe(projectRoot);
    expect(invoke('status', 'isolated').response.agent.workspace.cwd).toBe(isolatedRoot);
    expect(invoke('status', 'isolated').response.data.run).toEqual(
      isolatedStatus.response.data.run,
    );
    expect(invoke('status').response.data.total).toBe(2);
    const shapeWrite = spawnSync(
      process.execPath,
      [
        path.join(packageRoot, 'assets/skills/comet/scripts/comet-hook-router.mjs'),
        '--platform',
        'codex',
        '--project-root',
        projectRoot,
      ],
      {
        cwd: path.dirname(source),
        encoding: 'utf8',
        timeout: 20000,
        input: JSON.stringify({
          cwd: path.dirname(source),
          tool_name: 'Edit',
          tool_input: { file_path: source },
        }),
      },
    );
    expect(shapeWrite.status, shapeWrite.stderr).toBe(2);
    expect(shapeWrite.stderr).toMatch(/Shape|shape/);
    const blocked = invoke('new', 'second', '--isolation', 'current');
    expect(blocked.status).not.toBe(0);
    expect(blocked.response.error.message).toContain('already contains active change in-place');
    const duplicate = invoke('new', 'in-place', '--isolation', 'worktree', '--dry-run');
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.response.error.message).toContain('already belongs to the coordinator');
    await expect(createNativeWorkspaceGroup(stalePlan)).rejects.toThrow(
      'already belongs to the coordinator',
    );
    expect(await fs.readFile(configFile, 'utf8')).toBe(config);
    expect(await fs.readFile(source, 'utf8')).toBe('uncommitted source\n');
    expect(worktreeLists()).toEqual(originalWorktrees);
    await expect(fs.stat(stalePlan.projectRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(projectRoot, 'docs/comet/changes/second')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('binds all repository bytes and Git observations and rejects a missing member', async () => {
    const group = await createNativeWorkspaceGroup(
      await planNativeWorkspaceGroup({ projectRoot, name: 'candidate', repositories }),
    );
    let previous = await nativeRawInputSnapshot({ projectRoot: group.plan.projectRoot });
    expect(previous.complete, previous.diagnostics.join('\n')).toBe(true);
    expect(previous.repositories?.map((entry) => entry.path)).toEqual([
      'backend',
      'frontend',
      'mobile',
    ]);
    for (const entry of group.plan.repositories) {
      expect(previous.files.some((file) => file.path === `${entry.path}/source.txt`)).toBe(true);
      await fs.writeFile(path.join(entry.worktreeRoot, 'source.txt'), 'changed\n');
      const next = await nativeRawInputSnapshot({ projectRoot: group.plan.projectRoot, previous });
      expect(next.complete, next.diagnostics.join('\n')).toBe(true);
      expect(next.contentHash).not.toBe(previous.contentHash);
      previous = next;
    }
    await fs.rename(
      group.plan.repositories[2].worktreeRoot,
      `${group.plan.repositories[2].worktreeRoot}-missing`,
    );
    await expect(
      nativeRawInputSnapshot({ projectRoot: group.plan.projectRoot, previous }),
    ).rejects.toThrow();
  });

  it('keeps Runtime-owned artifacts out of child candidate inputs with a nested artifact root', async () => {
    const group = await createNativeWorkspaceGroup(
      await planNativeWorkspaceGroup({ projectRoot, name: 'nested-artifacts', repositories }),
    );
    const managedArtifactRoot = path.join(group.plan.projectRoot, 'backend/docs');
    const change = path.join(managedArtifactRoot, 'comet/changes/nested-artifacts');
    await fs.mkdir(change, { recursive: true });
    await fs.writeFile(path.join(change, 'comet-state.yaml'), 'runtime projection one\n');
    await fs.writeFile(path.join(change, 'brief.md'), '# Original contract\n');
    const first = await nativeRawInputSnapshot({
      projectRoot: group.plan.projectRoot,
      managedArtifactRoot,
    });
    expect(first.complete, first.diagnostics.join('\n')).toBe(true);
    expect(first.files.some((file) => file.path.endsWith('comet-state.yaml'))).toBe(false);
    await fs.writeFile(path.join(change, 'comet-state.yaml'), 'runtime projection two\n');
    const second = await nativeRawInputSnapshot({
      projectRoot: group.plan.projectRoot,
      managedArtifactRoot,
    });
    expect(second.contentHash).toBe(first.contentHash);
    await fs.writeFile(path.join(change, 'brief.md'), '# Changed contract\n');
    expect(
      (await nativeRawInputSnapshot({ projectRoot: group.plan.projectRoot, managedArtifactRoot }))
        .contentHash,
    ).not.toBe(first.contentHash);
  });
});
