const fs = require('node:fs');
const path = require('node:path');

class JsonStore {
  constructor(filename) {
    this.filename = filename;
    this.pending = Promise.resolve();
    try { this.values = JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.values = {};
    }
  }
  get(key, fallback) { return Object.hasOwn(this.values, key) ? this.values[key] : fallback; }
  keys() { return Object.keys(this.values); }
  update(key, value) {
    if (value === undefined) delete this.values[key];
    else this.values[key] = value;
    const contents = JSON.stringify(this.values, null, 2);
    this.pending = this.pending.catch(() => {}).then(async () => {
      await fs.promises.mkdir(path.dirname(this.filename), { recursive: true });
      const temporary = `${this.filename}.${process.pid}.tmp`;
      await fs.promises.writeFile(temporary, contents, { mode: 0o600 });
      await fs.promises.rename(temporary, this.filename);
    });
    return this.pending;
  }
  flush() { return this.pending; }
}

module.exports = { JsonStore };
