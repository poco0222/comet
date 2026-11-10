import path from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  defaultWorkflowProjectConfig,
  mergeWorkflowProjectConfigDocument,
  parseWorkflowProjectConfigDocument,
  renderStructuredProjectConfig,
  workflowProjectConfigRuntimeHelperScript,
} from '../../../domains/workflow-contract/project-config.js';
import { parseWorkflowGlobalConfig } from '../../../domains/workflow-contract/global-config.js';

const generated = new Function(
  'path',
  `${workflowProjectConfigRuntimeHelperScript()}\nreturn managedWorkflowConfigFields;`,
)(path) as (source: string) => unknown;
const source = (repositories: unknown) =>
  stringify({ ...defaultWorkflowProjectConfig(), repositories });

describe('project repository configuration', () => {
  it('preserves independent branch targets through parse, render and update', () => {
    const repositories = [
      { path: 'backend', target_branch: 'master' },
      { path: 'apps/mobile', target_branch: 'main' },
      { path: 'frontend' },
    ];
    const parsed = parseWorkflowProjectConfigDocument(source(repositories)).config!;
    expect(parsed.repositories).toEqual(repositories);
    const merged = mergeWorkflowProjectConfigDocument({ extension: 'retained' }, parsed);
    expect(merged.extension).toBe('retained');
    const rendered = renderStructuredProjectConfig(merged, 'zh-CN');
    expect(parseWorkflowProjectConfigDocument(rendered).config?.repositories).toEqual(repositories);
    expect(() => generated(rendered)).not.toThrow();
    const without = { ...parsed };
    delete without.repositories;
    expect(mergeWorkflowProjectConfigDocument(merged, without)).not.toHaveProperty('repositories');
  });

  it.each(
    [
      null,
      [],
      {},
      [{ path: '../escape' }],
      [{ path: '/absolute' }],
      [{ path: '.comet' }],
      [{ path: 'docs/backend' }],
      [{ path: 'backend' }, { path: 'backend/sub' }],
      [{ path: 'backend', target_branch: '' }],
      [{ path: 'backend', unexpected: true }],
    ].map((repositories) => ({ repositories })),
  )('rejects unsafe or ambiguous declaration %j in both validators', ({ repositories }) => {
    expect(() => parseWorkflowProjectConfigDocument(source(repositories))).toThrow(/repositories/);
    expect(() => generated(source(repositories))).toThrow(/repositories/);
  });

  it('does not allow a project topology in global configuration', () => {
    expect(() =>
      parseWorkflowGlobalConfig(
        source([{ path: 'backend' }]).replace('comet.project.v1', 'comet.global.v1'),
      ),
    ).toThrow('cannot contain project repositories');
    expect(
      parseWorkflowProjectConfigDocument(stringify(defaultWorkflowProjectConfig())).config,
    ).not.toHaveProperty('repositories');
  });
});
