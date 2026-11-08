// Closed diagnostic vocabulary shared by the worker, driver and artifact parser.
// Never derive output identifiers from arbitrary stderr text. These are clues, not
// authenticated root-cause findings. In particular, a module error can be a fallback
// after an earlier native-addon load failure.
export const MISSING_DEPENDENCY_SPECIFIERS = Object.freeze([
  ['@deepseek-ai/schemastery', 'host-process-exited-hint-missing-schemastery'],
  ['@deepseek-ai/dsh-llm', 'host-process-exited-hint-missing-dsh-llm'],
  ['@deepseek-ai/dsh-sandbox-policy', 'host-process-exited-hint-missing-dsh-sandbox-policy'],
  ['@deepseek-ai/dsh-credentials', 'host-process-exited-hint-missing-dsh-credentials'],
  ['@deepseek-ai/dsh-scope', 'host-process-exited-hint-missing-dsh-scope'],
  ['qrcode', 'host-process-exited-hint-missing-qrcode'],
].map(pair => Object.freeze(pair)));
export const HINT_CODES = Object.freeze([
  'host-process-exited-hint-eacces', 'host-process-exited-hint-erofs',
  'host-process-exited-hint-enoent', 'host-process-exited-hint-enospc',
  'host-process-exited-hint-user-lookup', 'host-process-exited-hint-module-not-found',
  'host-process-exited-hint-native-load', 'host-process-exited-hint-startup-audit',
  'host-process-exited-hint-port-in-use', 'host-process-exited-hint-out-of-memory',
  'host-process-exited-hint-engine-mismatch', 'host-process-exited-hint-bad-invocation',
  ...MISSING_DEPENDENCY_SPECIFIERS.map(([, code]) => code),
  'host-plugin-import-failed', 'host-plugin-import-missing-module', 'host-plugin-import-native-load',
]);
export const RUNTIME_ERROR_CODES = Object.freeze([
  'host-process-spawn-failed', 'host-process-spawn-inconclusive',
  'host-process-exited', 'host-process-exited-zero', 'host-process-exited-nonzero', 'host-process-exited-signal',
  ...HINT_CODES,
  'host-process-state-inconclusive', 'host-ready-timeout', 'host-auth-response-inconclusive',
  'host-identity-inconclusive', 'response-inconclusive', 'compatibility-check-failed',
  'host-capabilities-inconclusive', 'probe-input-invalid', 'worker-failed',
]);
export const INSTALL_ERROR_CODES = Object.freeze([
  'install-failed', ...MISSING_DEPENDENCY_SPECIFIERS.map(([, code]) => code),
]);
