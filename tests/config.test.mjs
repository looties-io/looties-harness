// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, productionCommandNames } from '../harness/hooks/config.mjs';
import { permissionProblems } from '../harness/sync-adapters.mjs';

function repoWith(config) {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-config-'));
  mkdirSync(path.join(root, '.agents'));
  if (config !== undefined) writeFileSync(path.join(root, '.agents', 'harness.config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return root;
}

describe('harness config', () => {
  it('gives the defaults when the repository has no config', () => {
    const config = loadConfig(repoWith());
    expect(config.branches).toEqual({ integration: 'dev', release: 'main' });
    expect(config.productionCommands).toEqual([]);
    expect(config.protectedConfig).toEqual(DEFAULT_CONFIG.protectedConfig);
  });

  it('merges nested keys over the defaults', () => {
    const config = loadConfig(repoWith({ branches: { integration: 'develop' } }));
    expect(config.branches).toEqual({ integration: 'develop', release: 'main' });
  });

  it('reads a bare string production command as an entry, so every reader sees one shape', () => {
    const config = loadConfig(repoWith({ productionCommands: ['npm publish', { command: 'terraform apply' }, { command: 'kubectl apply', effect: 'changes the cluster' }] }));
    expect(config.productionCommands).toEqual([
      { command: 'npm publish', effect: 'a production change' },
      { command: 'terraform apply', effect: 'a production change' },
      { command: 'kubectl apply', effect: 'changes the cluster' },
    ]);
    expect(productionCommandNames(config)).toEqual(['npm publish', 'terraform apply', 'kubectl apply']);
    const names = productionCommandNames(config);
    expect(permissionProblems({ allow: ['Bash(git status:*)'], ask: names.map((name) => `Bash(${name}:*)`) }, names)).toEqual([]);
  });

  it('refuses an entry without a command and an unreadable file, so the guard fails closed', () => {
    expect(() => loadConfig(repoWith({ productionCommands: [{ effect: 'x' }] }))).toThrow(/need a command/);
    expect(() => loadConfig(repoWith('{ not json'))).toThrow();
  });
});
