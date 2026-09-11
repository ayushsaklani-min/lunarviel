import { spawnSync } from 'node:child_process';
import process from 'node:process';

const [source = 'contracts/hello-world.compact', output = 'contracts/managed/hello-world'] = process.argv.slice(2);
const projectRelativePath = /^[A-Za-z0-9._/-]+$/;
if (!source.endsWith('.compact') || source.startsWith('/') || output.startsWith('/') ||
    source.includes('..') || output.includes('..') ||
    !projectRelativePath.test(source) || !projectRelativePath.test(output)) {
  throw new Error('Compile paths must be simple project-relative paths without parent traversal');
}
const compilerArgs = ['compile', source, output];

function run(command, args) {
  const result = spawnSync(command, [...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.platform !== 'win32') {
  run('compact', compilerArgs);
} else {
  const distro = process.env.MIDNIGHT_WSL_DISTRO ?? 'Ubuntu-24.04';
  const windowsPath = process.cwd();
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (!match) throw new Error(`Unsupported Windows project path: ${windowsPath}`);
  const [, drive, remainder] = match;
  const wslProjectPath = `/mnt/${drive.toLowerCase()}/${remainder.replaceAll('\\', '/')}`;
  const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const script = [
    'export PATH="$HOME/.local/bin:$PATH"',
    `cd ${shellQuote(wslProjectPath)}`,
    `exec compact compile ${shellQuote(source)} ${shellQuote(output)}`,
  ].join('; ');

  run('wsl.exe', ['-d', distro, '--', 'bash', '-lc', script]);
}
