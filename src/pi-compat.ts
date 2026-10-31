// Pi behavior is only advertised as version-verified against the locally reviewed 1.4.0 docs/CLI.
// Other versions remain inspectable, but guided writes/runtime actions carry an explicit uncertainty warning.
export const TESTED_PI_VERSION = '1.4.0';
// Reviewed from Pi 1.4.0 dist/extensions/index.js without importing executable extensions.
// Do not advertise this registry for another Pi version.
export const TESTED_BUILTIN_EXTENSIONS = ['llama.cpp', 'codemode', 'tool-search', 'mcp'];
