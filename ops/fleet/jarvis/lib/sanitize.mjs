export function summarizeExportWarnings(warnings = []) {
  const categories = {
    skippedBuiltIns: 0,
    systemDependentEnv: 0,
    omittedSystemDependentCommands: 0,
    other: 0,
  };
  for (const raw of warnings) {
    const w = String(raw);
    if (/skipped\s+\d+\s+built-in/i.test(w)) categories.skippedBuiltIns += 1;
    else if (/system-dependent/i.test(w) && /\benv\b/i.test(w)) categories.systemDependentEnv += 1;
    else if (/command .+ omitted|omitted from export because it is system-dependent/i.test(w)) {
      categories.omittedSystemDependentCommands += 1;
    } else categories.other += 1;
  }
  return { total: warnings.length, categories };
}
