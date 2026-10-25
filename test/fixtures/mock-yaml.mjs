// The integration fixtures contain no YAML persona/preset files.
// Unexpected use fails instead of silently pretending to parse arbitrary YAML.
export default {
  load(text) {
    try { return JSON.parse(text); }
    catch { throw new Error('YAML parsing is outside this integration fixture.'); }
  },
  dump(value) { return JSON.stringify(value, null, 2); }
};
