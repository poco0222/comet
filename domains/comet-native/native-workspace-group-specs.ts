import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withRecoverableFileLock } from '../../platform/fs/recoverable-file-lock.js';
import {
  inspectProtectedProjectPath,
  readProtectedProjectFile,
} from '../workflow-contract/protected-project-path.js';
import { atomicWriteBytes, atomicWriteJson } from './native-atomic-file.js';
import { canonicalHash } from './native-canonical-hash.js';
import { nativeProjectPaths } from './native-paths.js';
import type { NativeWorkspaceGroup } from './native-workspace-group.js';
import type { NativePortableSpecChange } from './native-portable-types.js';

interface SpecFile {
  ref: string;
  content: string;
  hash: string;
}
interface SpecBaseline {
  schema: 'comet.native.workspace-group-specs.v1';
  groupHash: string;
  artifactRootRef: string;
  files: SpecFile[];
  hash: string;
  installed: boolean;
}

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function readFile(root: string, ref: string): Promise<SpecFile | null> {
  try {
    const { bytes } = await readProtectedProjectFile(root, ref, Number.MAX_SAFE_INTEGER, {
      label: 'Native group Spec',
    });
    return { ref, content: bytes.toString('base64'), hash: digest(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readSpecs(root: string): Promise<SpecFile[]> {
  const result: SpecFile[] = [];
  try {
    await fs.lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }
  async function visit(ref: string) {
    const inspected = await inspectProtectedProjectPath(root, ref, {
      expected: 'directory',
      label: 'Native group Specs directory',
    });
    if (!inspected.exists) return;
    for (const entry of await fs.readdir(inspected.target, { withFileTypes: true })) {
      const child = `${ref}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else {
        const file = await readFile(root, child);
        if (!file) throw new Error(`Native group Spec disappeared: ${child}`);
        result.push(file);
      }
    }
  }
  await visit('specs');
  return result.sort((a, b) => a.ref.localeCompare(b.ref));
}

async function storage(group: NativeWorkspaceGroup, artifactRootRef: string) {
  const task = await nativeProjectPaths(group.plan.projectRoot, artifactRootRef);
  const coordinator = await nativeProjectPaths(group.plan.coordinatorRoot, artifactRootRef);
  const ref = 'workspace-group-specs.json';
  const read = async (): Promise<SpecBaseline | null> => {
    const file = await readFile(task.runtimeDir, ref);
    if (!file) return null;
    const value = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) as SpecBaseline;
    if (
      value.schema !== 'comet.native.workspace-group-specs.v1' ||
      value.groupHash !== group.plan.hash ||
      value.artifactRootRef !== artifactRootRef ||
      !Array.isArray(value.files) ||
      value.hash !== canonicalHash('group-specs', value.files) ||
      typeof value.installed !== 'boolean' ||
      value.files.some(
        (entry) =>
          !entry.ref.startsWith('specs/') ||
          entry.hash !== digest(Buffer.from(entry.content, 'base64')),
      )
    )
      throw new Error('Native group Specs baseline is invalid');
    return value;
  };
  return {
    task,
    coordinator,
    read,
    save: (value: SpecBaseline) =>
      atomicWriteJson(path.join(task.runtimeDir, ref), value, { containedRoot: task.runtimeDir }),
    lock: path.join(coordinator.locksDir, 'workspace-group-specs.lock'),
  };
}

/** Freeze the shared Specs once before Shape; later tasks keep their own original baseline. */
export async function initializeNativeWorkspaceGroupSpecs(
  group: NativeWorkspaceGroup,
  artifactRootRef: string,
): Promise<void> {
  const io = await storage(group, artifactRootRef);
  await withRecoverableFileLock(io.lock, async () => {
    let baseline = await io.read();
    if (baseline?.installed) return;
    if (!baseline) {
      const files = await readSpecs(io.coordinator.nativeRoot);
      const hash = canonicalHash('group-specs', files);
      if (hash !== canonicalHash('group-specs', await readSpecs(io.coordinator.nativeRoot)))
        throw new Error('Shared Specs changed during task preparation; retry creation');
      baseline = {
        schema: 'comet.native.workspace-group-specs.v1',
        groupHash: group.plan.hash,
        artifactRootRef,
        files,
        hash,
        installed: false,
      };
      await io.save(baseline);
    }
    const current = await readSpecs(io.task.nativeRoot);
    if (
      current.some(
        (file) => baseline!.files.find((original) => original.ref === file.ref)?.hash !== file.hash,
      )
    )
      throw new Error('Task Specs changed during preparation; preserve them before retrying');
    for (const file of baseline.files) {
      if (current.some((entry) => entry.ref === file.ref)) continue;
      await atomicWriteBytes(
        path.join(io.task.nativeRoot, file.ref),
        Buffer.from(file.content, 'base64'),
        { containedRoot: io.task.projectRoot, exclusive: true },
      );
    }
    baseline.installed = true;
    await io.save(baseline);
  });
}

/** Publish only the merged task's capabilities; unrelated shared Specs stay untouched. */
export async function publishNativeWorkspaceGroupSpecs(options: {
  group: NativeWorkspaceGroup;
  artifactRootRef: string;
  specChanges: readonly NativePortableSpecChange[];
  deliveryId: string;
}): Promise<void> {
  const io = await storage(options.group, options.artifactRootRef);
  await withRecoverableFileLock(io.lock, async () => {
    const baseline = await io.read();
    if (!baseline?.installed) throw new Error('Native group Specs baseline is missing');
    const changes: Array<{ ref: string; original: SpecFile | null; desired: SpecFile | null }> = [];
    for (const spec of options.specChanges) {
      const ref = `specs/${spec.capability}/spec.md`;
      const original = baseline.files.find((file) => file.ref === ref) ?? null;
      const desired = await readFile(io.task.nativeRoot, ref);
      if ((spec.operation === 'remove') !== (desired === null))
        throw new Error(`Archived task Spec does not match its operation: ${ref}`);
      changes.push({ ref, original, desired });
    }
    const receipt = {
      groupHash: options.group.plan.hash,
      deliveryId: options.deliveryId,
      specs: changes.map(({ ref, desired }) => ({ ref, hash: desired?.hash ?? null })),
    };
    const published = await readFile(io.task.runtimeDir, 'group-delivery/specs-published.json');
    if (published) {
      if (
        canonicalHash(
          'publication',
          JSON.parse(Buffer.from(published.content, 'base64').toString('utf8')),
        ) !== canonicalHash('publication', receipt)
      )
        throw new Error('Native group Specs publication differs from the original delivery');
      return;
    }
    const assertCurrent = async (change: (typeof changes)[number]) => {
      const current = await readFile(io.coordinator.nativeRoot, change.ref);
      if (
        (current?.hash ?? null) !== (change.original?.hash ?? null) &&
        (current?.hash ?? null) !== (change.desired?.hash ?? null)
      )
        throw new Error(
          `Shared Spec changed since task creation: ${change.ref}; preserve both versions and reconcile before retrying delivery`,
        );
      return current;
    };
    for (const change of changes) await assertCurrent(change);
    for (const change of changes) {
      const current = await assertCurrent(change);
      if ((current?.hash ?? null) === (change.desired?.hash ?? null)) continue;
      const destination = path.join(io.coordinator.nativeRoot, change.ref);
      if (change.desired)
        await atomicWriteBytes(destination, Buffer.from(change.desired.content, 'base64'), {
          containedRoot: io.coordinator.projectRoot,
          exclusive: current === null,
          beforeCommit: async () => {
            await assertCurrent(change);
          },
        });
      else await fs.unlink(destination);
    }
    await atomicWriteJson(
      path.join(io.task.runtimeDir, 'group-delivery/specs-published.json'),
      receipt,
      { containedRoot: io.task.runtimeDir },
    );
  });
}
