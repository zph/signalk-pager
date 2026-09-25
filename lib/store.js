'use strict'
const fs = require('node:fs')
const path = require('node:path')

class Store {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.chmodSync(directory, 0o700)
    this.file = path.join(directory, 'pager-state.json')
    this.state = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : { incidents: {}, events: {}, jobs: [], telegramOffset: 0 }
    this.serial = Promise.resolve()
  }

  transaction(fn) {
    const next = this.serial.then(() => {
      const copy = structuredClone(this.state)
      const result = fn(copy)
      this.save(copy)
      this.state = copy
      return result
    })
    this.serial = next.catch(() => {})
    return next
  }

  save(state) {
    const temp = `${this.file}.${process.pid}.tmp`
    const fd = fs.openSync(temp, 'w', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify(state))
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    fs.renameSync(temp, this.file)
    const dir = fs.openSync(path.dirname(this.file), 'r')
    try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
  }
}
module.exports = Store
