import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  defaultWorkflowProjectConfig,
  mergeWorkflowProjectConfigDocument,
  parseWorkflowProjectConfigDocument,
  renderStructuredProjectConfig,
} from '../../../domains/workflow-contract/project-config.js';
import { parseWorkflowGlobalConfig } from '../../../domains/workflow-contract/global-config.js';

const nativeNew = path.resolve('assets/skills/comet-native/scripts/comet-native-new.mjs');
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
  )(
    'rejects unsafe or ambiguous declaration %j in the parser and generated CLI',
    ({ repositories }) => {
      const config = source(repositories);
      expect(() => parseWorkflowProjectConfigDocument(config)).toThrow(/repositories/);
      const root = mkdtempSync(path.join(os.tmpdir(), 'comet-repositories-config-'));
      try {
        mkdirSync(path.join(root, '.comet'));
        writeFileSync(path.join(root, '.comet/config.yaml'), config);
        const result = spawnSync(
          process.execPath,
          [nativeNew, 'bad-repositories', '--isolation', 'worktree', '--dry-run', '--json'],
          { cwd: root, encoding: 'utf8', timeout: 20000 },
        );
        if (result.error) throw result.error;
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).toMatch(/repositories/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

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
