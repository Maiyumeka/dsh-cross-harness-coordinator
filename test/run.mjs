// 统一测试入口：默认跑可在任意机器复现的核心套件；
// --deep 追加需要活的 DSH 环境或外部资源的验收脚本（缺环境会明确报告为跳过，而不是静默失败）。
const deep = process.argv.includes('--deep');
const started = Date.now();
const report = { core: [], deep: [], skipped: [] };

const coreTimeoutMs = Number(process.env.COORDINATOR_TEST_TIMEOUT_MS || 120000);
const deepTimeoutMs = Number(process.env.COORDINATOR_DEEP_TIMEOUT_MS || 180000);

const run = async (file, tier) => {
  const begin = Date.now();
  const limit = tier === 'deep' ? deepTimeoutMs : coreTimeoutMs;
  let timer;
  try {
    await Promise.race([
      import(`./${file}`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`测试超时（${limit} ms）：脚本未自行结束，可能挂起或等待外部环境`)), limit);
      }),
    ]);
    clearTimeout(timer);
    (tier === 'deep' ? report.deep : report.core).push({ file, ok: true, ms: Date.now() - begin });
  } catch (error) {
    clearTimeout(timer);
    const message = String(error && error.message ? error.message : error);
    if (tier === 'deep' && /url: expected string|ENOENT|COORDINATOR_TEST_URL|COORDINATOR_STARTUP_FILE/.test(message)) {
      report.skipped.push({ file, reason: '需要活的 DSH 环境（COORDINATOR_TEST_URL / COORDINATOR_STARTUP_FILE 未提供）' });
    } else {
      (tier === 'deep' ? report.deep : report.core).push({ file, ok: false, error: message, ms: Date.now() - begin });
    }
  }
};

// 核心：不依赖浏览器、外部服务或模型凭据，可在任意机器复现。
for (const file of ['engine.mjs', 'artifact-guard.mjs', 'recover.mjs', 'onboarding.mjs', 'mcp.mjs', 'large-startup.mjs', 'onboarding-release.mjs']) {
  await run(file, 'core');
}

// 深测：需要活的 DSH 页面或大文件来源；缺环境时报告跳过并给出所需变量。
if (deep) {
  for (const file of ['onboarding-ui.mjs', 'native-ui.mjs', 'native-large-startup.mjs', 'agent-install.mjs', 'agent-update.mjs', 'preview-ui.mjs']) {
    await run(file, 'deep');
  }
}

const failed = [...report.core, ...report.deep].filter((r) => !r.ok);
const summary = {
  passed: failed.length === 0,
  deep,
  seconds: Math.round((Date.now() - started) / 100) / 10,
  core: report.core,
  ...(deep ? { deep: report.deep, skippedForEnvironment: report.skipped } : {}),
  ...(failed.length ? { failures: failed } : {}),
};
console.log(JSON.stringify(summary, null, 2));
if (failed.length) process.exitCode = 1;
