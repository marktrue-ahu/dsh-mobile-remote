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
export const DIAGNOSTIC_CODES = Object.freeze([
  'module-not-found', 'native-load', 'native-mapping-denied', 'native-binding-unavailable',
  'permission-denied', 'read-only', 'no-space', 'port-in-use', 'out-of-memory',
]);
export const DIAGNOSTIC_TARGETS = Object.freeze([
  'schemastery', 'dsh-llm', 'dsh-sandbox-policy', 'dsh-credentials', 'dsh-scope', 'qrcode',
  'native-addon-loader', 'node-addon-require-builtin', 'native-cache', 'native-local-build', 'host-entry',
]);
// This function is injected verbatim with toString(), not handwritten inside a
// template: regex escapes must retain their semantics in the generated worker.
export function formatHostDiagnostic(text) {
  if (typeof text !== 'string' || !text) return null;
  const input = text.slice(-4096);
  const codes = [];
  for (const [pattern, code] of [
    [/\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b/, 'module-not-found'],
    [/\bERR_DLOPEN_FAILED\b/, 'native-load'],
    [/failed to map segment from shared object/, 'native-mapping-denied'],
    [/No usable (?:native binding|prebuilt binary) found/, 'native-binding-unavailable'],
    [/\b(?:EACCES|EPERM)\b/, 'permission-denied'], [/\bEROFS\b/, 'read-only'],
    [/\bENOSPC\b/, 'no-space'], [/\bEADDRINUSE\b/, 'port-in-use'],
    [/\b(?:ENOMEM|heap out of memory)\b/i, 'out-of-memory'],
  ]) if (pattern.test(input)) codes.push(code);
  const targets = [];
  for (const [needle, target] of [
    ['@deepseek-ai/schemastery', 'schemastery'], ['@deepseek-ai/dsh-llm', 'dsh-llm'],
    ['@deepseek-ai/dsh-sandbox-policy', 'dsh-sandbox-policy'],
    ['@deepseek-ai/dsh-credentials', 'dsh-credentials'], ['@deepseek-ai/dsh-scope', 'dsh-scope'],
    ["'qrcode'", 'qrcode'], ['node-addon-native-custom-loader', 'native-addon-loader'],
    ['node-addon-require-builtin', 'node-addon-require-builtin'],
    ['/native-cache/', 'native-cache'], ['/node-addon-require-builtin/build/', 'native-local-build'],
    ['/@deepseek-ai/dsh/lib/bin.js', 'host-entry'],
  ]) if (input.includes(needle)) targets.push(target);
  // Even unrecognised nonempty output produces a fixed empty diagnostic. Silence
  // must not be mistaken for a working transport or a successful self-check.
  return 'HOST_DIAG: ' + JSON.stringify({schema: 1, codes, targets});
}
export function parseHostDiagnostic(line) {
  if (typeof line !== 'string' || line.length > 2048 || !line.startsWith('HOST_DIAG: ')) return null;
  try {
    const data = JSON.parse(line.slice('HOST_DIAG: '.length));
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join(',') !== 'codes,schema,targets' || data.schema !== 1) return null;
    for (const [key, allowed] of [['codes', DIAGNOSTIC_CODES], ['targets', DIAGNOSTIC_TARGETS]]) {
      const values = data[key];
      if (!Array.isArray(values) || values.length > allowed.length || new Set(values).size !== values.length || values.some(v => typeof v !== 'string' || !allowed.includes(v))) return null;
    }
    return 'HOST_DIAG: ' + JSON.stringify({schema: 1, codes: data.codes, targets: data.targets});
  } catch { return null; }
}
