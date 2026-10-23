import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  candidateBins,
  defaultDirs,
  parseJsonLoose,
  readDevtoolsState,
  readSkillVersion,
  resolveBin,
  runCliJson,
  safeEnv,
  spawnTarget,
  userDataRoots,
} from '../lib/devtools.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'wechatide-dev-'));

test('parseJsonLoose survives the CLI banner and trailing noise', () => {
  assert.deepEqual(parseJsonLoose('{"ok":true}'), { ok: true });
  assert.deepEqual(parseJsonLoose('[wechatide] skill-call: x\n{"ok":true,"result":{}}'), { ok: true, result: {} });
  assert.deepEqual(parseJsonLoose('{"ok":true}\n[wechatide] done'), { ok: true });
  assert.equal(parseJsonLoose('no json here'), undefined);
  assert.equal(parseJsonLoose(''), undefined);
});

test('readDevtoolsState reads the port, status and advertised mcp config', () => {
  const root = scratch();
  try {
    const dir = join(root, 'hash1', 'Default');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.ide'), '11782');
    writeFileSync(join(dir, '.ide-status'), 'On');
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { 'wechat-devtools': { command: 'wechatide', args: ['mcp'] } } }));

    const state = readDevtoolsState({ dirs: [dir] });
    assert.equal(state.found, true);
    assert.equal(state.port, 11782);
    assert.equal(state.running, true);
    assert.equal(state.mcpJson.mcpServers['wechat-devtools'].args[0], 'mcp');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readDevtoolsState reports a stopped IDE without inventing a port', () => {
  const root = scratch();
  try {
    const dir = join(root, 'hash1', 'Default');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.ide-status'), 'Off');
    const state = readDevtoolsState({ dirs: [dir] });
    assert.equal(state.found, true);
    assert.equal(state.running, false);
    assert.equal(state.port, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('defaultDirs only reports directories that actually contain Default/', () => {
  const root = scratch();
  try {
    mkdirSync(join(root, 'has', 'Default'), { recursive: true });
    mkdirSync(join(root, 'empty'), { recursive: true });
    const dirs = defaultDirs('darwin', {}, [root]);
    assert.equal(dirs.length, 1);
    assert.ok(dirs[0].endsWith(join('has', 'Default')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readSkillVersion finds the bundled skill beside the macOS CLI', () => {
  const root = scratch();
  try {
    const app = join(root, 'wechatwebdevtools.app');
    const macos = join(app, 'Contents', 'MacOS');
    const skill = join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'wechatide-skill');
    mkdirSync(macos, { recursive: true });
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: wechatide-skill\nversion: 0.3.9\ndescription: x\n---\n');
    assert.equal(readSkillVersion(join(macos, 'wechatide')), '0.3.9');
    assert.equal(readSkillVersion(join(macos, 'missing-binary')), '0.3.9');
    assert.equal(readSkillVersion(''), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveBin prefers explicit config, then the env var, then well-known paths', () => {
  const root = scratch();
  try {
    const explicit = join(root, 'custom-wechatide');
    writeFileSync(explicit, '');
    const config = resolveBin({ binPath: explicit }, 'darwin');
    assert.equal(config.bin, explicit);
    assert.equal(config.source, 'config');
    assert.equal(config.exists, true);

    const previous = process.env.WECHAT_DEVTOOLS_CLI;
    process.env.WECHAT_DEVTOOLS_CLI = explicit;
    try {
      const fromEnv = resolveBin({ binPath: '' }, 'darwin');
      assert.equal(fromEnv.source, 'env:WECHAT_DEVTOOLS_CLI');
      assert.equal(fromEnv.bin, explicit);
    } finally {
      if (previous === undefined) delete process.env.WECHAT_DEVTOOLS_CLI;
      else process.env.WECHAT_DEVTOOLS_CLI = previous;
    }

    const fallback = resolveBin({ binPath: '' }, 'linux');
    assert.ok(['well-known', 'PATH'].includes(fallback.source));
    assert.ok(candidateBins('win32').some((entry) => entry.endsWith('cli.bat')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('safeEnv strips model credentials but keeps PATH/HOME', () => {
  const env = safeEnv({ PATH: '/usr/bin', HOME: '/Users/x', DEEPSEEK_API_KEY: 'sk-x', OPENAI_API_KEY: 'sk-y', MCP_TOKEN: 'keep' });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/Users/x');
  assert.equal(env.MCP_TOKEN, 'keep');
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('spawnTarget leaves POSIX and .exe launchers alone', () => {
  assert.deepEqual(spawnTarget('/Applications/x/wechatide', ['mcp'], { platform: 'darwin' }), {
    file: '/Applications/x/wechatide',
    args: ['mcp'],
  });
  assert.deepEqual(spawnTarget('C:\\tools\\wechatide.exe', ['mcp'], { platform: 'win32' }), {
    file: 'C:\\tools\\wechatide.exe',
    args: ['mcp'],
  });
});

test('spawnTarget wraps a Windows .cmd launcher in cmd /d /s /c with quoted tokens', () => {
  const target = spawnTarget('C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\wechatide.cmd', ['mcp'], {
    platform: 'win32',
    comspec: 'C:\\Windows\\system32\\cmd.exe',
  });
  assert.equal(target.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(target.args.slice(0, 3), ['/d', '/s', '/c']);
  const line = target.args[3];
  // cmd /s 正好剥掉最外层一对引号，每个 token 的引号都保留。
  assert.ok(line.startsWith('"') && line.endsWith('"'));
  assert.equal(line, '""C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\wechatide.cmd" "mcp""');
});

test('spawnTarget doubles embedded quotes instead of breaking the command line', () => {
  const target = spawnTarget('C:\\x\\wechatide.bat', ['-c', 'a"b'], { platform: 'win32', comspec: 'cmd.exe' });
  assert.equal(target.args[3], '""C:\\x\\wechatide.bat" "-c" "a""b""');
});

test('Windows UserData is found both flat and under a "User Data" level', () => {
  const root = scratch();
  try {
    mkdirSync(join(root, 'User Data', 'hash9', 'Default'), { recursive: true });
    mkdirSync(join(root, 'hash2', 'Default'), { recursive: true });
    writeFileSync(join(root, 'User Data', 'hash9', 'Default', '.ide'), '11782');
    writeFileSync(join(root, 'User Data', 'hash9', 'Default', '.ide-status'), 'On');
    const dirs = defaultDirs('win32', {}, [root]);
    assert.equal(dirs.length, 2);
    assert.ok(dirs.some((dir) => dir.includes(join('User Data', 'hash9', 'Default'))));
    assert.ok(dirs.some((dir) => dir.endsWith(join('hash2', 'Default'))));

    const state = readDevtoolsState({ dirs });
    assert.equal(state.found, true);
    assert.equal(state.port, 11782);
    assert.equal(state.running, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows install discovery probes the .cmd launcher next to Program Files', () => {
  const env = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' };
  const bins = candidateBins('win32', env);
  assert.ok(bins.some((bin) => bin === join('C:\\Program Files (x86)', 'Tencent', '微信web开发者工具', 'wechatide.cmd')));
  assert.ok(bins.some((bin) => bin.includes('Tencent') && bin.endsWith('wechatide.cmd')));
  // 分隔符取决于构建路径的宿主（Windows 上是 path.win32）；
  // 真正要校验的形态是 "--Tencent--微信web开发者工具--<launcher>"。
  assert.ok(bins.every((bin) => /(?:wechatide\.(?:cmd|exe)|cli\.bat|wechatide)$/.test(bin)));
});
