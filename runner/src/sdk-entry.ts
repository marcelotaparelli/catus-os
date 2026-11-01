// Disabled: SDK/CLI 0.166.0 announces tools and retries, incompatible with M5.1.
// The isolated loopback reproduction lives in scripts/check-sdk-contract.mjs.
process.stderr.write(
  'Codex SDK disabled: incompatible no-tools contract; NOT_VERIFIED\n',
);
process.exitCode = 2;
export {};
