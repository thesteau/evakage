import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let server;
let building = false;
let pending = false;
let stopping = false;
let timer;
const runBuild = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => resolve(code === 0));
});
async function rebuild() {
  if (building) { pending = true; return; }
  building = true;
  try {
    if (process.platform === 'win32' && server && server.exitCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill();
      await exited;
    }
    if (await runBuild() && !stopping) {
      if (server && server.exitCode === null) {
        const exited = new Promise(resolve => server.once('exit', resolve));
        server.kill();
        await exited;
      }
      server = spawn(fileURLToPath(new URL(`../app/dist/evakage${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url)), [], { cwd: fileURLToPath(new URL('../app/', import.meta.url)), stdio: 'inherit' });
      server.on('error', error => console.error(error));
    }
  } catch (error) { console.error(error); }
  finally {
    building = false;
    if (pending && !stopping) { pending = false; void rebuild(); }
  }
}
const watchers = ['app/client', 'app/server', 'app/cmd', 'app/go.mod', 'app/go.sum', 'app/tsconfig.json'].map(dir => watch(new URL(`../${dir}`, import.meta.url), { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), 150);
}));
function shutdown() {
  stopping = true;
  clearTimeout(timer);
  for (const watcher of watchers) watcher.close();
  server?.kill();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
void rebuild();
