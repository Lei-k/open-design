// Test-only executable for the multi-user run isolation harness. No provider or tools.
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { message: string; delayMs?: number };
if (request.delayMs) await new Promise((resolve) => setTimeout(resolve, Math.min(request.delayMs!, 2000)));
process.stdout.write(JSON.stringify({
  message: request.message,
  cwd: process.cwd(),
  home: process.env.HOME,
  temp: process.env.TMPDIR,
  dataRoot: process.env.OD_DATA_DIR,
  plantedSecret: process.env.MULTIUSER_TEST_API_KEY ?? null,
  envKeys: Object.keys(process.env).sort(),
}) + '\n');
