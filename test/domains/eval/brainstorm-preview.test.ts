import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const script = fileURLToPath(
  new URL(
    '../../../eval/local/skills/benchmarks/dependency/superpowers/brainstorming/scripts/server.cjs',
    import.meta.url,
  ),
);

it('serves a fixed bootstrap page and initializes only authorized preview sessions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'comet-brainstorm-preview-'));
  const sessionKey = 'preview+fixture&value';
  const server = spawn(process.execPath, [script], {
    cwd: directory,
    env: {
      ...process.env,
      BRAINSTORM_DIR: directory,
      BRAINSTORM_HOST: '127.0.0.1',
      BRAINSTORM_OWNER_PID: '',
      BRAINSTORM_PORT: '',
      BRAINSTORM_PORT_FILE: '',
      BRAINSTORM_TOKEN: sessionKey,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const closed = once(server, 'close');
  const stdout = createInterface({ input: server.stdout });
  try {
    const [line] = await Promise.race([
      once(stdout, 'line', { signal: AbortSignal.timeout(5000) }),
      closed.then(([code]) => {
        throw new Error(`Preview server exited before startup: ${code}`);
      }),
    ]);
    const { port } = JSON.parse(line) as { port: number };
    const url = new URL(`http://127.0.0.1:${port}/`);
    const requestOptions = { signal: AbortSignal.timeout(5000) };
    url.searchParams.set('key', 'wrong-key');
    const denied = await fetch(url, requestOptions);
    expect(denied.status).toBe(403);
    expect(denied.headers.get('set-cookie')).toBeNull();
    await denied.text();

    url.searchParams.set('key', sessionKey);
    const authorized = await fetch(url, requestOptions);
    expect(authorized.status).toBe(200);
    const cookie = authorized.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    const html = await authorized.text();
    expect(html).not.toContain(sessionKey);

    const setItem = vi.fn();
    const replace = vi.fn();
    const bootstrap = /<script>([\s\S]*?)<\/script>/u.exec(html);
    expect(bootstrap).not.toBeNull();
    runInNewContext(
      bootstrap![1],
      { URLSearchParams, sessionStorage: { setItem }, location: { search: url.search, replace } },
      { timeout: 1000 },
    );
    expect(setItem).toHaveBeenCalledExactlyOnceWith('brainstorm-session-key', sessionKey);
    expect(replace).toHaveBeenCalledExactlyOnceWith('/');
    const preview = await fetch(new URL('/', url), {
      ...requestOptions,
      headers: { cookie: cookie.split(';')[0] },
    });
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain('Waiting for the agent to push a screen');
  } finally {
    stdout.close();
    if (server.exitCode === null && server.signalCode === null) server.kill();
    try {
      await closed;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
