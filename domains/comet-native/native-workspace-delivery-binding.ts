import { promises as fs } from 'node:fs';
import os from 'node:os';
import { resolveWorkspaceRuntimeRootSync } from '../workflow-contract/workspace-runtime.js';
import path from 'node:path';

import { runExternalCommandAsync } from '../../platform/process/external-command.js';
import { independentGitEnvironment } from '../../platform/process/git-environment.js';
import { hashRuntimeValue, type WorkflowRun } from '../engine/runtime.js';
import {
  hashProtectedProjectFile,
  readProtectedProjectFile,
} from '../workflow-contract/protected-project-path.js';
import { canonicalHash } from './native-canonical-hash.js';
import { readProjectConfig } from './native-config.js';
import { captureNativeWorkspaceGroupSpecPublication } from './native-workspace-group-specs.js';
import type { NativePortableState } from './native-portable-types.js';
import { parseNativePortableState } from './native-portable-state.js';
import {
  isNativeCodeGraphCachePath,
  nativeSensitiveRelativePathReason,
} from './native-sensitive-paths.js';
import {
  assertNativeWorkspaceGroupCurrent,
  readNativeWorkspaceGroup,
  type NativeRepositoryPlan,
  type NativeWorkspaceGroup,
} from './native-workspace-group.js';

type DeliveryPatternToken =
  | { kind: 'literal'; value: string }
  | { kind: 'question' | 'star' | 'globstar' | 'globstar-slash' };

function epsilonClosure(
  tokens: readonly DeliveryPatternToken[],
  positions: ReadonlySet<number>,
): Set<number> {
  const closure = new Set(positions);
  const pending = [...positions];
  while (pending.length > 0) {
    const position = pending.pop()!;
    const token = tokens[position];
    if (
      token &&
      (token.kind === 'star' || token.kind === 'globstar' || token.kind === 'globstar-slash') &&
      !closure.has(position + 1)
    ) {
      closure.add(position + 1);
      pending.push(position + 1);
    }
  }
  return closure;
}

// Match existing patterns exactly, including dotfiles and literal punctuation.
function compileLegacyDeliveryPattern(pattern: string): (relative: string) => boolean {
  const tokens: DeliveryPatternToken[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*' && pattern[index + 1] === '*') {
      index += 1;
      if (pattern[index + 1] === '/') {
        index += 1;
        tokens.push({ kind: 'globstar-slash' });
      } else {
        tokens.push({ kind: 'globstar' });
      }
    } else if (character === '*') {
      tokens.push({ kind: 'star' });
    } else if (character === '?') {
      tokens.push({ kind: 'question' });
    } else {
      tokens.push({ kind: 'literal', value: character });
    }
  }

  return (relative) => {
    let positions = epsilonClosure(tokens, new Set([0]));
    for (const character of relative) {
      const next = new Set<number>();
      for (const position of positions) {
        const token = tokens[position];
        if (!token) continue;
        if (token.kind === 'literal' && token.value === character) {
          next.add(position + 1);
        } else if (token.kind === 'question' && character !== '/') {
          next.add(position + 1);
        } else if (token.kind === 'star' && character !== '/') {
          next.add(position);
        } else if (token.kind === 'globstar') {
          next.add(position);
        } else if (token.kind === 'globstar-slash') {
          next.add(position);
          if (character === '/') next.add(position + 1);
        }
      }
      positions = epsilonClosure(tokens, next);
      if (positions.size === 0) return false;
    }
    return positions.has(tokens.length);
  };
}

export async function nativeWorkspaceDeliveryExclusions(group: NativeWorkspaceGroup) {
  const config = await readProjectConfig(group.plan.projectRoot);
  const patterns = (config?.native.legacyDeliveryExcludes ?? []).map(compileLegacyDeliveryPattern);
  const localFiles = new Set(group.plan.setup?.files.map(({ path: ref }) => ref));
  return (repositoryPath: string, ref: string): boolean => {
    const relative = repositoryPath ? `${repositoryPath}/${ref}` : ref;
    if (
      localFiles.has(relative) ||
      nativeSensitiveRelativePathReason(ref) ||
      isNativeCodeGraphCachePath(ref) ||
      ref === '.worktrees' ||
      ref.startsWith('.worktrees/') ||
      ref === '.comet' ||
      ref.startsWith('.comet/')
    )
      return true;
    for (
      let prefix = relative;
      prefix;
      prefix = prefix.slice(0, Math.max(0, prefix.lastIndexOf('/')))
    ) {
      if (patterns.some((match) => match(prefix) || match(`${prefix}/`))) return true;
    }
    return false;
  };
}

export async function nativeWorkspaceDeliveryPaths(
  group: NativeWorkspaceGroup,
  repository: NativeRepositoryPlan,
): Promise<string[]> {
  const root = repository.worktreeRoot;
  const excluded = await nativeWorkspaceDeliveryExclusions(group);
  const env = { ...independentGitEnvironment(), GIT_OPTIONAL_LOCKS: '0' };
  const git = (args: string[]) => runExternalCommandAsync('git', args, { cwd: root, env });
  const changed = async (...args: string[]) =>
    (await git(['diff', '--name-only', '--no-renames', '-z', ...args, '--']))
      .split('\0')
      .filter(Boolean);
  const branchCommits = (await git(['rev-list', `${repository.baseCommit}..HEAD`])).trim();
  const committed = branchCommits
    ? (
        await runExternalCommandAsync(
          'git',
          [
            'diff-tree',
            '--stdin',
            '-m',
            '--no-commit-id',
            '-r',
            '--name-only',
            '--no-renames',
            '-z',
          ],
          { cwd: root, env, input: branchCommits + '\n' },
        )
      )
        .split('\0')
        .filter(Boolean)
    : [];
  const staged = await changed('--cached', 'HEAD');
  for (const ref of [...committed, ...staged]) {
    if (excluded(repository.path, ref))
      throw new Error(
        `Changed file is excluded from accepted delivery inputs: ${repository.path}/${ref}`,
      );
  }
  if (await git(['ls-files', '--unmerged', '-z']))
    throw new Error(`Unresolved task index in ${repository.path}`);
  // Enumerate names before running Git against the working files, including clean filters.
  const tracked = (await git(['ls-files', '-v', '-z']))
    .split('\0')
    .filter((entry) => entry && !excluded(repository.path, entry.slice(2)));
  if (tracked.some((entry) => !entry.startsWith('H ')))
    throw new Error(`Task checkout hides tracked delivery inputs: ${repository.path}`);
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter((ref) => ref && !excluded(repository.path, ref));
  const selected = [...tracked.map((entry) => entry.slice(2)), ...untracked];
  const trackedChanges = [];
  for (let offset = 0; offset < selected.length; offset += 100) {
    const paths = selected.slice(offset, offset + 100).map((ref) => `:(literal)${ref}`);
    const result = await git([
      'status',
      '--porcelain=v1',
      '--no-renames',
      '-z',
      '--untracked-files=all',
      '--',
      ...paths,
    ]);
    for (const entry of result.split('\0').filter(Boolean)) trackedChanges.push(entry.slice(3));
  }
  return [...new Set([...staged, ...trackedChanges])];
}

export async function captureNativeWorkspaceDeliveryTrees(group: NativeWorkspaceGroup) {
  await assertNativeWorkspaceGroupCurrent(group);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-delivery-index-'));
  try {
    const reads = await Promise.allSettled(
      group.plan.repositories.map(async (repository, index) => {
        const args = await nativeWorkspaceDeliveryPaths(group, repository);
        const cwd = repository.worktreeRoot;
        const env = {
          ...independentGitEnvironment(),
          GIT_INDEX_FILE: path.join(directory, String(index)),
        };
        const git = (args: string[]) => runExternalCommandAsync('git', args, { cwd, env });
        const head = (await git(['rev-parse', 'HEAD'])).trim();
        await git(['read-tree', head]);
        // Keep Git's real index untouched and use the same staged paths as delivery.
        if (args.length) await git(['--literal-pathspecs', 'add', '-A', '--', ...args]);
        const tree = (await git(['write-tree'])).trim();
        if ((await git(['rev-parse', 'HEAD'])).trim() !== head)
          throw new Error(`Task branch changed during delivery input capture: ${cwd}`);
        return { path: repository.path, head, tree };
      }),
    );
    return reads.map((read) => {
      if (read.status === 'rejected') throw read.reason;
      return read.value;
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function captureNativeWorkspaceDeliveryRootFiles(
  group: NativeWorkspaceGroup,
  root = group.plan.projectRoot,
) {
  const excluded = await nativeWorkspaceDeliveryExclusions(group);
  const config = await readProjectConfig(group.plan.projectRoot);
  const artifacts = path.posix.join(config?.native.artifact_root ?? 'docs', 'comet');
  const repositories = new Set(group.plan.repositories.map((entry) => entry.path));
  const files: Array<{ path: string; hash: string; mode: string }> = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const ref = path.posix.join(dir, entry.name);
      if (repositories.has(ref) || ref === artifacts || excluded('', ref)) continue;
      if (entry.isDirectory()) await visit(ref);
      else {
        const file = await hashProtectedProjectFile(root, ref, {
          label: 'Native delivery root file',
        });
        files.push({
          path: ref,
          hash: file.digest,
          mode:
            Number(file.stat.mode) & 0o111 && process.platform !== 'win32' ? '100755' : '100644',
        });
      }
    }
  }
  await visit('');
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path === b.path ? 0 : 1));
}

export async function captureNativeWorkspaceDeliverySetupFiles(group: NativeWorkspaceGroup) {
  return Promise.all(
    (group.plan.setup?.files ?? []).map(async ({ path: ref }) => {
      const file = await hashProtectedProjectFile(group.plan.projectRoot, ref, {
        label: 'Native delivery setup file',
      });
      return { path: ref, hash: file.digest };
    }),
  );
}

async function deliveryInputs(group: NativeWorkspaceGroup) {
  const [trees, rootFiles, localFiles] = await Promise.all([
    captureNativeWorkspaceDeliveryTrees(group),
    captureNativeWorkspaceDeliveryRootFiles(group),
    captureNativeWorkspaceDeliverySetupFiles(group),
  ]);
  return { trees, rootFiles, localFiles };
}

function bindingHash(
  group: NativeWorkspaceGroup,
  inputs: Awaited<ReturnType<typeof deliveryInputs>>,
) {
  return canonicalHash('comet.native.workspace-group-delivery-binding.v1', {
    groupHash: group.plan.hash,
    workspace: group.projectWorkspaceId,
    repositories: group.repositories,
    ...inputs,
  });
}

export async function captureNativeWorkspaceDeliveryBinding(group: NativeWorkspaceGroup) {
  return bindingHash(group, await deliveryInputs(group));
}

export interface NativeWorkspaceVerifierDelivery {
  deliveryTreeBinding: string;
  deliverySpecs: Array<{ ref: string; hash: string | null }>;
}

export async function readNativeWorkspaceVerifierDelivery(
  projectRoot: string,
  artifactRootRef: string,
  state: NativePortableState,
): Promise<NativeWorkspaceVerifierDelivery | undefined> {
  if (!state.workspace.group_hash) return;
  const group = await readNativeWorkspaceGroup(projectRoot);
  if (group?.plan.hash !== state.workspace.group_hash || group.plan.name !== state.name)
    throw new Error('Native verification requires its original registered workspace group');
  const [deliveryTreeBinding, deliverySpecs] = await Promise.all([
    captureNativeWorkspaceDeliveryBinding(group),
    captureNativeWorkspaceGroupSpecPublication(
      group,
      artifactRootRef,
      state.spec_changes,
      state.name,
    ),
  ]);
  return { deliveryTreeBinding, deliverySpecs };
}

function acceptedVerifierOutput(run: Readonly<WorkflowRun>) {
  const state = parseNativePortableState(run.state);
  return [...run.actions].reverse().find((action) => {
    const output = action.outcome?.output as
      { candidateId?: string; response?: { result?: { verdict?: string } } } | undefined;
    return (
      action.stepId === 'verify.verifier' &&
      action.status === 'succeeded' &&
      output?.candidateId === state.builder_handoff?.candidate_id &&
      output?.response?.result?.verdict === 'pass'
    );
  })?.outcome?.output as NativeWorkspaceVerifierDelivery | undefined;
}

export function readNativeWorkspaceDeliverySpecBinding(run: Readonly<WorkflowRun>) {
  return acceptedVerifierOutput(run)?.deliverySpecs;
}

export async function assertNativeWorkspaceVerifierDeliveryCurrent(
  run: Readonly<WorkflowRun>,
  projectRoot: string,
  artifactRootRef: string,
) {
  const original = acceptedVerifierOutput(run);
  if (!original?.deliveryTreeBinding) return; // Existing Runs preserve their original acceptance.
  const current = await readNativeWorkspaceVerifierDelivery(
    projectRoot,
    artifactRootRef,
    parseNativePortableState(run.state),
  );
  if (
    !current ||
    original.deliveryTreeBinding !== current.deliveryTreeBinding ||
    hashRuntimeValue(original.deliverySpecs) !== hashRuntimeValue(current.deliverySpecs)
  )
    throw new Error(
      'Accepted multi-repository delivery inputs changed; restore the verified inputs or request fresh verification before Archive',
    );
}

/** Translate retained historical inputs only when they prove the same Git payload. */
async function assertLegacyDeliveryInputs(
  run: Readonly<WorkflowRun>,
  group: NativeWorkspaceGroup,
  inputs: Awaited<ReturnType<typeof deliveryInputs>>,
): Promise<void> {
  const state = parseNativePortableState(run.state);
  const output = [...run.actions].reverse().find((action) => {
    const result = action.outcome?.output as { candidateId?: string } | undefined;
    return (
      ['verify.checks', 'verify.requested-checks'].includes(action.stepId) &&
      action.status === 'succeeded' &&
      result?.candidateId === state.builder_handoff?.candidate_id
    );
  })?.outcome?.output as { rawInput?: { afterRef?: string } } | undefined;
  const ref = output?.rawInput?.afterRef;
  const prefix = `native/sdk-checks/${hashRuntimeValue(run.runId)}/inputs/`;
  const failure = () =>
    new Error(
      'The archived Run lacks matching historical delivery inputs. Preserve its evidence and verify the intended changes in a new task before Git delivery.',
    );
  if (!ref?.startsWith(prefix) || !/^[a-f0-9]{64}\.json$/u.test(ref.slice(prefix.length)))
    throw failure();
  const workspaceRoot = resolveWorkspaceRuntimeRootSync(group.plan.projectRoot);
  const { bytes } = await readProtectedProjectFile(workspaceRoot, ref, Number.MAX_SAFE_INTEGER, {
    label: 'Original Native delivery inputs',
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw failure();
    throw error;
  });
  const original = JSON.parse(bytes.toString('utf8')) as {
    schema?: string;
    projectRoot?: string;
    complete?: boolean;
    files?: Array<{ path: string; mode: string; hash: string; generated?: boolean }>;
    repositories?: Array<{ path: string; head: string }>;
  };
  if (
    original.schema !== 'comet.native.raw-input.v1' ||
    original.complete !== true ||
    original.projectRoot !== group.plan.projectRoot ||
    hashRuntimeValue(original) !== ref.slice(prefix.length, -5) ||
    !Array.isArray(original.files) ||
    !Array.isArray(original.repositories)
  )
    throw failure();
  const expected = new Map(
    original.files.filter((file) => !file.generated).map((file) => [file.path, file]),
  );
  for (const file of inputs.rootFiles) {
    const old = expected.get(file.path);
    if (old?.hash !== file.hash || old.mode !== file.mode) throw failure();
  }
  for (const file of inputs.localFiles) {
    if (expected.get(file.path)?.hash !== file.hash) throw failure();
  }
  const excluded = await nativeWorkspaceDeliveryExclusions(group);
  const artifactRootRef = (run.input as { artifactRootRef: string }).artifactRootRef;
  const artifacts = path.posix.join(artifactRootRef, 'comet');
  const actualRootFiles = new Set(inputs.rootFiles.map((file) => file.path));
  for (const [ref, file] of expected) {
    if (
      file.mode !== '160000' &&
      ref !== artifacts &&
      !ref.startsWith(`${artifacts}/`) &&
      !group.plan.repositories.some(
        ({ path: member }) => ref === member || ref.startsWith(`${member}/`),
      ) &&
      !excluded('', ref) &&
      !actualRootFiles.has(ref)
    )
      throw failure();
  }

  for (const [index, entry] of group.plan.repositories.entries()) {
    const current = inputs.trees[index];
    if (current.head !== original.repositories.find(({ path: ref }) => ref === entry.path)?.head)
      throw failure();
    const cwd = entry.worktreeRoot;
    const env = independentGitEnvironment();
    const staged = (
      await runExternalCommandAsync('git', ['ls-tree', '-rz', '--full-tree', current.tree], {
        cwd,
        env,
      })
    )
      .split('\0')
      .filter(Boolean);
    const names = new Set<string>();
    for (const record of staged) {
      const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/su.exec(record);
      const ref = match?.[3];
      if (!ref || !match) throw failure();
      if (excluded(entry.path, ref)) continue;
      names.add(ref);
      const old = expected.get(`${entry.path}/${ref}`);
      if (old?.mode !== match[1]) throw failure();
      const actual = await hashProtectedProjectFile(cwd, ref, {
        label: 'Historical Git delivery input',
      });
      const actualGitBlob = (
        await runExternalCommandAsync('git', ['hash-object', '--no-filters', '--', ref], {
          cwd,
          env,
        })
      ).trim();
      if (actual.digest !== old.hash || actualGitBlob !== match[2]) throw failure();
    }
    for (const [ref, file] of expected) {
      const childPath = ref.startsWith(`${entry.path}/`) ? ref.slice(entry.path.length + 1) : null;
      if (
        childPath &&
        file.mode !== '160000' &&
        !excluded(entry.path, childPath) &&
        !names.has(childPath)
      )
        throw failure();
    }
  }
}

export async function assertNativeWorkspaceDeliveryBinding(
  run: Readonly<WorkflowRun>,
  group: NativeWorkspaceGroup,
) {
  const state = parseNativePortableState(run.state);
  if (state.workspace.group_hash !== group.plan.hash || !state.builder_handoff || !state.archived)
    throw new Error('Native Git delivery requires the original archived workspace group');
  const binding = acceptedVerifierOutput(run)?.deliveryTreeBinding;
  const inputs = await deliveryInputs(group);
  if (typeof binding !== 'string') {
    await assertLegacyDeliveryInputs(run, group, inputs);
  } else if (binding !== bindingHash(group, inputs))
    throw new Error('Accepted Native Git delivery inputs changed after verification');
  return inputs;
}
