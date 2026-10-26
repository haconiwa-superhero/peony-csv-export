'use strict';

const fs = require('fs/promises');
const path = require('path');

class InventoryAlertStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { version: 1, items: {} };
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      this.state = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this.state;
  }

  get(key) {
    return this.state.items[key] || null;
  }

  async set(key, value) {
    this.state.items[key] = value;
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(this.state, null, 2));
      await fs.rename(tempPath, this.filePath);
    });
    await this.writeQueue;
  }
}

module.exports = { InventoryAlertStore };
