import path from 'node:path';
import { readFileRaceSafe } from '../../platform/fs/race-safe-read.js';
import { stripUtf8Bom } from '../../platform/fs/strip-bom.js';
import {
  assertNoArguments,
  NativeUsageError,
  requiredPositional,
  success,
  takeFlag,
  takeOption,
  type DispatchResult,
} from './native-cli-shared.js';
import { inspectNativeSdkRun, resolveNativeSdkCommandRoot } from './native-runtime-ownership.js';
import {
  assertNativeWorkspaceDeliveryBinding,
  readNativeWorkspaceDeliverySpecBinding,
} from './native-workspace-delivery-binding.js';
import {
  readNativeWorkspaceGroup,
  readNativeWorkspaceGroupPlan,
} from './native-workspace-group.js';
import {
  cleanupNativeWorkspaceGroup,
  readNativeWorkspaceCleanupStatus,
} from './native-workspace-group-cleanup.js';
import { inspectNativeSdkStatus } from './native-sdk-status.js';
import {
  applyNativeWorkspaceGroupDelivery,
  inspectNativeWorkspaceGroupDelivery,
  nativeWorkspaceDeliveryReportTemplate,
  prepareNativeWorkspaceGroupDelivery,
  reportNativeWorkspaceGroupDelivery,
  type NativeWorkspaceGroupDelivery,
} from './native-workspace-group-delivery.js';
import { validateNativeWorkspaceFinishMessage } from './native-workspace-finish.js';
import {
  assertNativeWorkspaceGroupSpecPublication,
  publishNativeWorkspaceGroupSpecs,
} from './native-workspace-group-specs.js';

/** Git delivery follows the accepted SDK Run; it never supplies workflow decisions. */
export async function nativeDeliverCommand(
  args: string[],
  projectRoot: string,
): Promise<DispatchResult> {
  const name = requiredPositional(args, 'change name');
  const apply = takeOption(args, '--apply');
  const cleanup = takeFlag(args, '--cleanup');
  const reportFile = takeOption(args, '--checks');
  const refreshDeliveryId = takeOption(args, '--refresh');
  const commitMessage = takeOption(args, '--commit-message');
  assertNoArguments(args);
  if (apply && refreshDeliveryId)
    throw new NativeUsageError('--apply and --refresh cannot be combined');
  if (cleanup && refreshDeliveryId)
    throw new NativeUsageError('--cleanup and --refresh cannot be combined');
  if (reportFile && (apply || cleanup || refreshDeliveryId))
    throw new NativeUsageError('--checks submits results for an existing delivery');
  if (commitMessage !== undefined)
    validateNativeWorkspaceFinishMessage(commitMessage, '--commit-message');
  if (cleanup) {
    const plan = await readNativeWorkspaceGroupPlan(projectRoot, name);
    const root = plan?.projectRoot ?? projectRoot;
    const retained = await readNativeWorkspaceCleanupStatus(root, name);
    const status =
      retained ?? (await inspectNativeSdkStatus({ projectRoot: root, name, details: true }));
    let result;
    try {
      result = await cleanupNativeWorkspaceGroup({ root, name, apply, status });
    } catch (error) {
      return {
        ...success('deliver', {
          change: name,
          recoveryArgs: [
            'comet',
            'native',
            'deliver',
            name,
            '--cleanup',
            ...(apply ? ['--apply', apply] : []),
            '--project-root',
            projectRoot,
            '--json',
          ],
          precondition:
            'Preserve retained files and resolve the reported worktree identity or Git lock before retrying the same command.',
        }),
        executionCwd: root,
        exitCode: 73,
        error: {
          code: 'conflict',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    return {
      ...success('deliver', {
        change: name,
        cleanup: result,
        next: apply
          ? null
          : {
              commandArgs: [
                'comet',
                'native',
                'deliver',
                name,
                '--cleanup',
                '--apply',
                result.planHash,
                '--project-root',
                projectRoot,
                '--json',
              ],
              summary:
                'Remove eligible merged worktrees; preserve local files and historical evidence.',
            },
      }),
      executionCwd: root,
    };
  }
  const root = await resolveNativeSdkCommandRoot(projectRoot, name);
  const group = await readNativeWorkspaceGroup(root);
  if (!group || group.plan.name !== name)
    throw new NativeUsageError('deliver requires a Native SDK multi-repository task');
  const { run, state, artifactRootRef } = await inspectNativeSdkRun(root, name, { readOnly: true });
  const finalized = [...run.actions]
    .reverse()
    .find((action) => action.stepId === 'archive.finalize' && action.status === 'succeeded');
  if (
    run.status !== 'completed' ||
    !state.archived ||
    state.verification_result !== 'pass' ||
    !state.builder_handoff ||
    state.workspace.group_hash !== group.plan.hash ||
    state.verification?.candidate_id !== state.builder_handoff.candidate_id ||
    state.children_contract_hash ||
    !finalized?.outcome
  )
    throw new NativeUsageError(
      'Complete acceptance and Archive in the original SDK Run before Git delivery',
    );
  const checks = new Map(
    (state.verification?.checks ?? []).map((check) => [
      `verify:${check.id}`,
      { id: `verify:${check.id}`, name: check.name.text },
    ]),
  );
  for (const check of state.verification?.reported_checks ?? state.builder_handoff.checks) {
    const name = check.name.text.trim();
    const id = `verify:${name}`;
    if (name && !checks.has(id)) checks.set(id, { id, name });
  }
  let expectedSpecs: ReturnType<typeof readNativeWorkspaceDeliverySpecBinding>;
  let delivery: NativeWorkspaceGroupDelivery;
  try {
    const existing = await inspectNativeWorkspaceGroupDelivery(group);
    if (existing && existing.candidateId !== state.builder_handoff.candidate_id)
      throw new Error('Delivery belongs to another accepted candidate');
    expectedSpecs = readNativeWorkspaceDeliverySpecBinding(run);
    const legacySpecs = (
      finalized.outcome.output as {
        specs?: Array<{ capability?: string; resultHash?: string | null }>;
      } | null
    )?.specs;
    if (
      !expectedSpecs &&
      Array.isArray(legacySpecs) &&
      legacySpecs.length === state.spec_changes.length &&
      legacySpecs.every((spec, index) => {
        const change = state.spec_changes[index];
        return (
          spec?.capability === change.capability &&
          (change.operation === 'remove'
            ? spec.resultHash === null
            : typeof spec.resultHash === 'string' && /^[a-f0-9]{64}$/u.test(spec.resultHash))
        );
      })
    ) {
      expectedSpecs = legacySpecs.map(({ capability, resultHash }) => ({
        ref: `specs/${capability}/spec.md`,
        hash: resultHash!,
      }));
    }
    if (!existing || existing.status !== 'merged') {
      if (!expectedSpecs && state.spec_changes.length)
        throw new Error('Original Archive lacks accepted Spec publication evidence');
      if (expectedSpecs)
        await assertNativeWorkspaceGroupSpecPublication(group, artifactRootRef, expectedSpecs);
    }
    if (apply) {
      delivery = await applyNativeWorkspaceGroupDelivery(group, apply);
    } else if (reportFile) {
      const { bytes } = await readFileRaceSafe(
        path.resolve(projectRoot, reportFile),
        Number.MAX_SAFE_INTEGER,
        { label: 'Native integration check report' },
      );
      delivery = await reportNativeWorkspaceGroupDelivery(
        group,
        JSON.parse(stripUtf8Bom(bytes.toString('utf8'))),
      );
    } else {
      delivery = await prepareNativeWorkspaceGroupDelivery({
        group,
        candidateId: state.builder_handoff.candidate_id,
        commitMessage: commitMessage ?? existing?.commitMessage ?? `feat: ${name}`,
        checks: [...checks.values()],
        artifactRootRef,
        refreshDeliveryId,
        validateCandidate: () => assertNativeWorkspaceDeliveryBinding(run, group),
      });
    }
  } catch (error) {
    const saved = await inspectNativeWorkspaceGroupDelivery(group).catch(() => null);
    const prefix = ['comet', 'native', 'deliver', name];
    const suffix = ['--project-root', root, '--json'];
    return {
      ...success('deliver', {
        change: name,
        delivery: saved,
        diagnosticArgs: ['comet', 'native', 'status', name, '--details', ...suffix],
        recoveryArgs: [
          ...prefix,
          ...(apply
            ? ['--apply', apply]
            : reportFile
              ? ['--checks', path.resolve(projectRoot, reportFile)]
              : [
                  ...(commitMessage ? ['--commit-message', commitMessage] : []),
                  ...(refreshDeliveryId ? ['--refresh', refreshDeliveryId] : []),
                ]),
          ...suffix,
        ],
        refresh:
          saved && saved.status !== 'merged'
            ? {
                commandArgs: [
                  ...prefix,
                  '--refresh',
                  saved.id,
                  '--commit-message',
                  saved.commitMessage,
                  ...suffix,
                ],
                preconditions: [
                  'Keep the accepted task candidate unchanged.',
                  'Resolve dirty target work and reconcile any unknown previous check before running a replacement.',
                  'Run fresh checks for the new integration round. The old worktrees and evidence are preserved.',
                ],
              }
            : null,
      }),
      executionCwd: root,
      exitCode: 73,
      error: { code: 'conflict', message: error instanceof Error ? error.message : String(error) },
    };
  }
  if (delivery.status === 'merged') {
    try {
      await publishNativeWorkspaceGroupSpecs({
        group,
        artifactRootRef,
        specChanges: state.spec_changes,
        deliveryId: delivery.id,
        expectedSpecs,
      });
    } catch (error) {
      const message = `Git targets are merged; shared Specs publication is blocked. ${error instanceof Error ? error.message : String(error)}`;
      return {
        ...success('deliver', {
          change: name,
          delivery,
          specs: { status: 'blocked' },
          recoveryArgs: [
            'comet',
            'native',
            'deliver',
            name,
            '--apply',
            delivery.planHash!,
            '--project-root',
            root,
            '--json',
          ],
        }),
        executionCwd: root,
        exitCode: 73,
        error: { code: 'conflict', message },
      };
    }
  }
  const reportTemplate =
    delivery.status === 'awaiting-checks' ? nativeWorkspaceDeliveryReportTemplate(delivery) : null;
  return {
    ...success(
      'deliver',
      {
        change: name,
        runId: run.runId,
        delivery,
        specs: { status: delivery.status === 'merged' ? 'published' : 'pending' },
        next:
          delivery.status === 'merged'
            ? null
            : reportTemplate
              ? {
                  cwd: delivery.integrationRoot,
                  resultTemplate: reportTemplate,
                  commandArgs: [
                    'comet',
                    'native',
                    'deliver',
                    name,
                    '--checks',
                    '<checks-json-file>',
                    '--project-root',
                    root,
                    '--json',
                  ],
                  summary:
                    'Run the required checks with Agent platform tools in the prepared integration workspace and submit the actual results.',
                }
              : {
                  commandArgs: [
                    'comet',
                    'native',
                    'deliver',
                    name,
                    '--apply',
                    delivery.planHash!,
                    '--project-root',
                    root,
                    '--json',
                  ],
                  summary: 'Apply the verified integration commits to their local target branches.',
                },
      },
      delivery.status === 'merged'
        ? `Merged ${name} into all local target branches; task and integration worktrees are retained.\n`
        : reportTemplate
          ? `Prepared ${name} for integration checks.\n`
          : `Prepared and checked ${name}; target branches have not been updated.\n`,
    ),
    executionCwd: root,
  };
}
