import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', 'tests/finance.test.ts', 'tests/storage-api.test.ts'], { encoding: 'utf8', windowsHide: true });
await mkdir('evidence', { recursive: true });
await writeFile('evidence/core-tests.tap', result.stdout || result.stderr);
const total = Number(result.stdout.match(/^# tests (\d+)$/m)?.[1] ?? 0), passed = Number(result.stdout.match(/^# pass (\d+)$/m)?.[1] ?? 0), failed = Number(result.stdout.match(/^# fail (\d+)$/m)?.[1] ?? 0);
await writeFile('evidence/core-tests.json', JSON.stringify({ date: new Date().toISOString(), total, passed, failed, scenarios: [...result.stdout.matchAll(/^# Subtest: (.+)$/gm)].map(m => m[1]), realApi: false }, null, 2));
if (result.status !== 0 || total === 0 || failed) { process.stderr.write(result.stdout + result.stderr); process.exitCode = 1; }
else console.log(`${passed}/${total} 核心测试通过；完整证据 evidence/core-tests.json`);
